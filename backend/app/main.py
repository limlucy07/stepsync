"""Local YouTube intake API with synchronous pose extraction."""

import logging
import shutil
import uuid
from dataclasses import asdict
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Callable

from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from .config import Settings
from .handoff import ProcessingState
from .pose_processing import PoseArtifacts, run_pose_extraction
from .video import VideoError, validate_video
from .youtube import download_video, validate_url
from .storage import save_video
from .dtw_compare import compare_csv
from .progress import MAX_TITLE_LENGTH, can_practice, clean_title, dance_progress, passed, title_key
from .segmentation import segment_steps, steps_from_ranges
from .supabase_store import StepInUseError, StepsChangedError, SupabaseError, SupabaseStore, step_from_row, add_motion_features, load_pose_frames

logger = logging.getLogger(__name__)

# Videos uploaded from the phone app by POST /analyze.
UPLOAD_DIR = Path(__file__).resolve().parent.parent / "uploads"
UPLOAD_SUFFIXES = {".mp4", ".mov", ".m4v", ".webm"}
MAX_UPLOAD_BYTES = 300 * 1024 * 1024  # 300 MB per video


class MetadataResponse(BaseModel):
    duration_seconds: float
    width: int
    height: int
    fps: float
    frame_count: int
    rotation_degrees: float
    timestamp_source: str


class YouTubeRequest(BaseModel):
    url: str
    # The name the user gave the dance; must differ from the names of their other dances.
    title: str | None = None


class StepResponse(BaseModel):
    step_index: int
    label: str
    start_ms: int
    end_ms: int
    intensity: str
    focus: list[str]


class StepRange(BaseModel):
    start_ms: int
    end_ms: int
    # Position (0-based) of the saved step this one continues, keeping its id; null for a new step
    # (the right half of a split). Leave it out on every step to map steps one-to-one.
    source: int | None = None


class StepsUpdate(BaseModel):
    steps: list[StepRange]
    saved_count: int | None = None  # how many steps the app thinks are saved, to catch stale edits


MIN_EDITED_STEP_MS = 200
MAX_EDITED_STEPS = 200


class UploadResponse(BaseModel):
    status: ProcessingState
    source_url: str
    filename: str
    size_bytes: int
    metadata: MetadataResponse
    pose_processing: str
    persisted: bool
    saved_path: str
    pose_preview_path: str | None = None
    pose_data_path: str | None = None
    pose_error_code: str | None = None
    pose_error: str | None = None
    # Supabase: "saved", "not_configured", "skipped" (no keypoints) or "failed".
    supabase_status: str = "not_configured"
    supabase_dance_id: str | None = None
    supabase_error: str | None = None
    frames_saved: int | None = None
    # Learnable steps found in the dance (empty when no dancer was detected).
    steps: list[StepResponse] = []


_FROM_ENV = object()


def create_app(
    settings: Settings | None = None,
    pose_runner: Callable[[Path, Path, Path, float], PoseArtifacts] | None = None,
    supabase_store: "SupabaseStore | None | object" = _FROM_ENV,
) -> FastAPI:
    settings = settings or Settings.from_env()
    pose_runner = pose_runner or run_pose_extraction
    store = SupabaseStore.from_env() if supabase_store is _FROM_ENV else supabase_store
    app = FastAPI(title="StepSync local video backend", description=(
        "Validated videos are saved locally and processed by the pose extractor. "
        "No authentication or database is connected."
    ))

    # Lets the Expo web build (a different origin) call the API during development.
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
    )

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok"}

    @app.exception_handler(VideoError)
    async def video_error_handler(request, error):
        return JSONResponse(status_code=error.status_code,
                            content={"error": {"code": error.code, "message": error.message}})

    @app.exception_handler(RequestValidationError)
    async def request_error_handler(request, error):
        message = ("Send a JSON object with a nonempty string in the 'url' field."
                   if request.url.path == "/reference-videos" else "The request body doesn't have the expected fields.")
        return JSONResponse(status_code=422, content={"error": {"code": "invalid_request", "message": message}})

    @app.post("/reference-videos", response_model=UploadResponse, status_code=200)
    def upload_video(request: YouTubeRequest, authorization: str | None = Header(default=None)):
        title = clean_title(request.title or "")
        if request.title is not None and not title:
            raise HTTPException(422, "Give the dance a name.")
        if len(title) > MAX_TITLE_LENGTH:
            raise HTTPException(422, f"Keep the dance name under {MAX_TITLE_LENGTH} characters.")
        if title:
            # Checked before downloading anything, so a taken name fails fast.
            owner_id = current_user(authorization)
            if owner_id and name_taken(owner_id, title):
                raise HTTPException(409, f'You already have a dance called "{title}". Pick a different name.')
        try:
            url = validate_url(request.url)
            with TemporaryDirectory(prefix="stepsync-youtube-") as directory:
                downloaded = download_video(url, Path(directory), settings)
                path = downloaded.path
                if path.suffix.lower() not in settings.allowed_extensions:
                    raise VideoError("unsupported_format", "MP4 is not enabled in the configured extension allowlist.", 415)
                size = path.stat().st_size
                if size > settings.max_upload_bytes:
                    raise VideoError("upload_too_large", f"File exceeds the {settings.max_upload_bytes}-byte limit.", 413)
                if size == 0:
                    raise VideoError("empty_file", "The downloaded video is empty.")
                metadata = validate_video(path, settings)
                saved = save_video(path, title or downloaded.title, settings.video_directory)
            try:
                artifacts = pose_runner(
                    saved, settings.pose_results_directory / saved.stem,
                    settings.pose_model_path, settings.pose_processing_timeout_seconds,
                )
            except Exception as error:
                logger.exception("Pose processing failed for saved video %s", saved)
                return UploadResponse(
                    status=ProcessingState.failed, source_url=url, filename=saved.name,
                    size_bytes=size, metadata=MetadataResponse(**asdict(metadata)),
                    pose_processing="failed", persisted=True, saved_path=str(saved),
                    pose_error_code=error.code if isinstance(error, VideoError) else "pose_processing_failed",
                    pose_error=error.message if isinstance(error, VideoError) else "Pose extraction failed. Check the backend logs.",
                    supabase_status="skipped",
                    supabase_error="Nothing was saved to Supabase because pose extraction failed.",
                )
            supabase_result = save_to_supabase(
                store, artifacts.data_path, url, title or clean_title(downloaded.title), saved, metadata, authorization,
            )
            return UploadResponse(
                status=ProcessingState.completed, source_url=url, filename=saved.name,
                size_bytes=size, metadata=MetadataResponse(**asdict(metadata)),
                pose_processing="completed", persisted=True, saved_path=str(saved),
                pose_preview_path=str(artifacts.preview_path), pose_data_path=str(artifacts.data_path),
                **supabase_result,
            )
        except VideoError:
            raise
        except Exception:
            logger.exception("Local video validation failed")
            raise VideoError("processing_failed", "Video inspection failed unexpectedly. Check the backend logs.", 500)

    @app.get("/videos/{filename}")
    def video_file(filename: str):
        """Stream a video saved by /reference-videos, so the app can preview it.

        Supports HTTP range requests, which iOS needs to play video.
        Only bare filenames from the saved-videos folder are served (see find_saved_video).
        """
        path = find_saved_video(filename, settings.video_directory)
        return FileResponse(path, media_type="video/mp4")

    def current_user(authorization: str | None) -> str | None:
        """The signed-in user's id, or None without Supabase or a valid login."""
        if store is None or not authorization or not authorization.lower().startswith("bearer "):
            return None
        return store.user_id_for_token(authorization[7:].strip())

    def name_taken(owner_id: str, title: str) -> bool:
        try:
            return title_key(title) in {title_key(t) for t in store.dance_titles(owner_id)}
        except SupabaseError as error:
            raise HTTPException(502, str(error))

    def signed_in_user(authorization: str | None) -> str:
        if store is None:
            raise HTTPException(503, "The backend isn't connected to Supabase.")
        owner_id = None
        if authorization and authorization.lower().startswith("bearer "):
            owner_id = store.user_id_for_token(authorization[7:].strip())
        if owner_id is None:
            raise HTTPException(401, "Log in to see your dances.")
        return owner_id

    def dance_summary(row: dict, user_id: str) -> dict:
        video_path = row.get("video_path") or ""
        try:
            video_available = bool(video_path) and find_saved_video(video_path, settings.video_directory).is_file()
        except HTTPException:
            video_available = False  # saved by another teammate's backend, so the file isn't here
        return {
            "id": row["id"],
            "title": row.get("title") or "Untitled dance",
            "source_url": row.get("source_url"),
            "video_path": video_path or None,
            "video_available": video_available,
            "duration_ms": row.get("duration_ms"),
            "status": row.get("status") or "ready",
            "is_public": bool(row.get("is_public")),
            "mine": row.get("owner_id") == user_id,
            "step_count": row.get("step_count", 0),
            "created_at": row.get("created_at"),
        }

    @app.get("/dances")
    def list_dances(authorization: str | None = Header(default=None)) -> dict:
        """The signed-in user's dances and public ones, newest first, for the home screen."""
        user_id = signed_in_user(authorization)
        try:
            rows = store.list_dances(user_id)
        except SupabaseError as error:
            raise HTTPException(502, str(error))
        try:
            completed = store.progress_by_dance(user_id)
        except SupabaseError:
            logger.exception("Could not read user_dance_progress")
            completed = {}  # the list still works without progress
        return {"dances": [{**dance_summary(row, user_id), "steps_completed": completed.get(row["id"], 0)}
                           for row in rows]}

    @app.get("/dances/{dance_id}")
    def get_dance(dance_id: str, authorization: str | None = Header(default=None)) -> dict:
        """One dance with its steps, for the dance screen."""
        user_id = signed_in_user(authorization)
        try:
            found = store.get_dance_with_steps(dance_id)
        except SupabaseError as error:
            raise HTTPException(502, str(error))
        if found is None:
            raise HTTPException(404, "That dance doesn't exist.")
        row, steps = found
        if row.get("owner_id") != user_id and not row.get("is_public"):
            raise HTTPException(404, "That dance doesn't exist.")
        progress = progress_for(user_id, dance_id, steps)
        return {**dance_summary({**row, "step_count": len(steps)}, user_id),
                "steps": [step_from_row(i, step) for i, step in enumerate(steps)],
                "progress": progress}

    def progress_for(user_id: str, dance_id: str, steps: list[dict]) -> dict:
        try:
            return dance_progress(steps, store.step_attempts(user_id, dance_id))
        except SupabaseError as error:
            raise HTTPException(502, str(error))

    @app.post("/dances/{dance_id}/steps/{step_id}/practice")
    def practice_step(
        dance_id: str,
        step_id: str,
        practice: UploadFile = File(...),
        authorization: str | None = Header(default=None),
    ) -> dict:
        """Score a recording of one step against that step of the tutorial and save the attempt.

        A step is mastered with a score over 80. Only the current step (the first one not mastered)
        and steps already mastered can be practiced; later ones stay locked.
        """
        user_id = signed_in_user(authorization)
        try:
            found = store.get_dance_with_steps(dance_id)
        except SupabaseError as error:
            raise HTTPException(502, str(error))
        if found is None or (found[0].get("owner_id") != user_id and not found[0].get("is_public")):
            raise HTTPException(404, "That dance doesn't exist.")
        row, steps = found
        index = next((i for i, step in enumerate(steps) if step["id"] == step_id), None)
        if index is None:
            raise HTTPException(404, "That step isn't part of this dance.")
        progress = progress_for(user_id, dance_id, steps)
        if not can_practice(progress, index):
            raise HTTPException(403, f"Master step {progress['current_step'] + 1} first to unlock step {index + 1}.")
        boundaries = step_boundaries(steps[index]["start_ms"], steps[index]["end_ms"])

        try:
            video = find_saved_video(row.get("video_path") or "", settings.video_directory)
        except HTTPException:
            raise HTTPException(409, "This dance's video isn't on this backend (it was uploaded through another "
                                     "teammate's backend), so it can't be scored here.")
        session_id = uuid.uuid4().hex
        session_dir = UPLOAD_DIR / session_id
        session_dir.mkdir(parents=True)
        practice_path = save_upload(practice, session_dir, "practice")
        model, timeout = settings.pose_model_path, settings.pose_processing_timeout_seconds
        reference_dir = settings.pose_results_directory / video.stem
        reference_csv = reference_dir / "pose_data.csv"
        if not reference_csv.is_file():
            reference_csv = pose_runner(video, reference_dir, model, timeout).data_path
        practice_csv = pose_runner(practice_path, session_dir / "practice_pose", model, timeout).data_path
        try:
            result = compare_csv(reference_csv, practice_csv, **boundaries)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

        score = int(result["overallScore"])
        response = {"sessionId": session_id, **result, "stepId": step_id, "stepIndex": index, "passed": passed(score)}
        try:
            store.record_attempt(user_id, dance_id, step_id, score)
            progress = dance_progress(steps, store.step_attempts(user_id, dance_id))
            current = progress["current_step"]
            store.save_progress(user_id, dance_id, progress["steps_completed"],
                                steps[current]["id"] if current < len(steps) else None)
        except SupabaseError as error:
            # The score is still shown; only saving it failed.
            logger.error("Could not save the attempt: %s", error)
            response["progress_error"] = f"Your score couldn't be saved, so it won't count yet. {error}"
        response["progress"] = progress
        return response

    @app.put("/dances/{dance_id}/steps")
    def update_dance_steps(dance_id: str, body: StepsUpdate, authorization: str | None = Header(default=None)) -> dict:
        """Save steps edited in the app: cuts moved, steps split or merged. Steps that continue a saved
        step keep its id, so practice data pointing at them keeps working."""
        if store is None:
            raise HTTPException(503, "The backend isn't connected to Supabase.")
        owner_id = None
        if authorization and authorization.lower().startswith("bearer "):
            owner_id = store.user_id_for_token(authorization[7:].strip())
        if owner_id is None:
            raise HTTPException(401, "Log in to edit steps.")
        try:
            dance = store.get_dance(dance_id)
        except SupabaseError as error:
            raise HTTPException(502, str(error))
        if dance is None:
            raise HTTPException(404, "That dance doesn't exist.")
        if dance["owner_id"] != owner_id:
            raise HTTPException(403, "You can only edit steps of your own dances.")

        ranges = [(r.start_ms, r.end_ms) for r in body.steps]
        if not ranges:
            raise HTTPException(422, "Send at least one step.")
        if len(ranges) > MAX_EDITED_STEPS:
            raise HTTPException(422, f"A dance can have at most {MAX_EDITED_STEPS} steps.")
        if ranges[0][0] < 0 or any(end - start < MIN_EDITED_STEP_MS for start, end in ranges):
            raise HTTPException(422, f"Every step must be at least {MIN_EDITED_STEP_MS / 1000:g} seconds long.")
        if any(a[1] != b[0] for a, b in zip(ranges, ranges[1:])):
            raise HTTPException(422, "Steps must follow each other with no gaps or overlaps.")

        video = find_saved_video(dance["video_path"] or "", settings.video_directory)
        pose_csv = settings.pose_results_directory / video.stem / "pose_data.csv"
        if not pose_csv.is_file():
            raise HTTPException(409, "The pose data for this dance is missing on the backend. Upload it again.")
        frames = load_pose_frames(pose_csv)
        add_motion_features(frames)
        try:
            steps = steps_from_ranges(frames, ranges)
        except ValueError as error:
            raise HTTPException(422, str(error))
        try:
            sources = [r.source for r in body.steps] if any("source" in r.model_fields_set for r in body.steps) else None
            store.update_steps(dance_id, steps, frames, sources=sources, saved_count=body.saved_count)
        except (StepsChangedError, StepInUseError) as error:
            raise HTTPException(409, str(error))
        except SupabaseError as error:
            raise HTTPException(502, str(error))
        return {"steps": [{k: step[k] for k in StepResponse.model_fields} for step in steps]}

    @app.post("/analyze")
    def analyze(
        practice: UploadFile = File(...),
        reference: UploadFile | None = File(None),
        reference_video: str | None = Form(None),
        step_start_ms: int | None = Form(None),
        step_end_ms: int | None = Form(None),
    ) -> dict:
        """Scores the practice video against the reference with Satwik's DTW comparison (dtw_compare.py).

        The reference is either an uploaded file or the `filename` POST /reference-videos returned for a
        YouTube link (its saved pose data is reused). step_start_ms/step_end_ms limit the reference to one
        tutorial step, so a recording of just that step gets a fair score."""
        boundaries = step_boundaries(step_start_ms, step_end_ms)
        if (reference is None) == (reference_video is None):
            raise HTTPException(
                422, "Send exactly one of 'reference' (a video file) or 'reference_video' "
                "(a filename from /reference-videos).",
            )
        saved_reference = (
            find_saved_video(reference_video, settings.video_directory)
            if reference_video is not None else None
        )
        session_id = uuid.uuid4().hex
        session_dir = UPLOAD_DIR / session_id
        session_dir.mkdir(parents=True)
        try:
            reference_path = saved_reference or save_upload(reference, session_dir, "reference")
            practice_path = save_upload(practice, session_dir, "practice")
        except HTTPException:
            shutil.rmtree(session_dir, ignore_errors=True)
            raise
        model, timeout = settings.pose_model_path, settings.pose_processing_timeout_seconds
        if saved_reference is not None:
            # Pose data from the YouTube import; only extracted again if it's missing.
            reference_dir = settings.pose_results_directory / saved_reference.stem
            reference_csv = reference_dir / "pose_data.csv"
            if not reference_csv.is_file():
                reference_csv = pose_runner(saved_reference, reference_dir, model, timeout).data_path
        else:
            reference_csv = pose_runner(reference_path, session_dir / "reference_pose", model, timeout).data_path
        practice_csv = pose_runner(practice_path, session_dir / "practice_pose", model, timeout).data_path
        try:
            result = compare_csv(reference_csv, practice_csv, **boundaries)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        # The response shape must match AnalysisResult in frontend/src/api/types.ts.
        return {"sessionId": session_id, **result}

    return app


def save_to_supabase(store, data_path: Path, url: str, title: str, saved: Path, metadata, authorization) -> dict:
    """Split the dance into steps and store keypoints, features and steps.

    Never fails the import: Supabase problems are reported in the response instead.
    """
    try:
        frames = load_pose_frames(data_path)
        add_motion_features(frames)
        steps = segment_steps(frames)
    except Exception:
        logger.exception("Could not read pose data from %s", data_path)
        return {"supabase_status": "failed", "supabase_error": "Couldn't read the pose data. Check the backend logs."}

    step_info = [{k: step[k] for k in StepResponse.model_fields} for step in steps]
    if store is None:
        return {"steps": step_info, "supabase_status": "not_configured", "supabase_error": (
            "The backend isn't connected to Supabase. Set STEPSYNC_SUPABASE_URL and "
            "STEPSYNC_SUPABASE_SECRET_KEY in backend/.env and restart it."
        )}
    try:
        owner_id = None
        if authorization and authorization.lower().startswith("bearer "):
            owner_id = store.user_id_for_token(authorization[7:].strip())
        if owner_id is None:
            return {"steps": step_info, "supabase_status": "failed",
                    "supabase_error": "Log in to save dances to Supabase; every dance needs an owner."}
        dance = {
            "owner_id": owner_id, "title": unique_title(store, owner_id, title or saved.stem), "source_url": url,
            "video_path": saved.name,  # the name /analyze accepts as reference_video
            "duration_ms": round(metadata.duration_seconds * 1000), "status": "ready",
        }
        dance_id = store.save_dance(dance, frames, steps)
        return {"steps": step_info, "supabase_status": "saved", "supabase_dance_id": dance_id,
                "frames_saved": len(frames)}
    except SupabaseError as error:
        return {"steps": step_info, "supabase_status": "failed", "supabase_error": str(error)}
    except Exception:
        logger.exception("Saving to Supabase failed")
        return {"steps": step_info, "supabase_status": "failed",
                "supabase_error": "Saving to Supabase failed unexpectedly. Check the backend logs."}


def unique_title(store, owner_id: str, title: str) -> str:
    """The title, or "title (2)", "(3)"... if the user already has a dance with that name.

    Names the user typed are checked (and rejected) before the download; this catches the rest,
    like a YouTube title used when no name was given."""
    taken = {title_key(t) for t in store.dance_titles(owner_id)}
    candidate, number = title, 2
    while title_key(candidate) in taken:
        candidate, number = f"{title} ({number})", number + 1
    return candidate


def find_saved_video(name: str, directory: Path) -> Path:
    """Look up a video saved by /reference-videos. Only a bare filename is accepted,
    never a path, so a client can't point the server at other files."""
    if not name or name in {".", ".."} or Path(name).name != name or "\\" in name:
        raise HTTPException(400, "reference_video must be a filename returned by /reference-videos.")
    directory = directory.resolve()
    path = (directory / name).resolve()
    if path.parent != directory or not path.is_file():
        raise HTTPException(404, "That reference video was not found on the server. Import the link again.")
    return path


def save_upload(upload: UploadFile, folder: Path, stem: str) -> Path:
    suffix = Path(upload.filename or "").suffix.lower()
    is_video = (upload.content_type or "").startswith("video/") or suffix in UPLOAD_SUFFIXES
    if not is_video:
        raise HTTPException(415, f"{stem} must be a video file, got {upload.content_type}.")

    path = folder / f"{stem}{suffix if suffix in UPLOAD_SUFFIXES else '.mp4'}"
    written = 0
    with path.open("wb") as out:
        while chunk := upload.file.read(1024 * 1024):
            written += len(chunk)
            if written > MAX_UPLOAD_BYTES:
                raise HTTPException(413, f"{stem} video is larger than 300 MB.")
            out.write(chunk)
    if written == 0:
        raise HTTPException(400, f"{stem} video is empty.")
    return path


MIN_SCORED_STEP_MS = 500


def step_boundaries(start_ms: int | None, end_ms: int | None) -> dict:
    """Reference time range (seconds) for compare_csv; empty when the whole dance is scored."""
    if start_ms is None and end_ms is None:
        return {}
    if start_ms is None or end_ms is None or start_ms < 0 or end_ms <= start_ms:
        raise HTTPException(422, "Send both step_start_ms and step_end_ms, with the end after the start.")
    if end_ms - start_ms < MIN_SCORED_STEP_MS:
        raise HTTPException(422, "This step is too short to score (under 0.5 s). Merge it with a neighbour in Edit.")
    return {"reference_start": start_ms / 1000, "reference_end": end_ms / 1000}


app = create_app()
