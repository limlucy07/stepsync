"""Save a reference dance's keypoints and motion features to Supabase.

Reads the pose CSV written by pose_extraction.py (one row per landmark per frame),
groups it into frames, adds simple motion features, and writes to the team's tables:
  dances        one row per uploaded dance (owner = the logged-in user)
  steps         one row per learnable step found by segmentation.py
  keyframes     three key poses per step (start, middle, end) for scoring
  pose_frames   one row per frame (all 33 keypoints + per-frame features as JSON)
pose_frames is created by supabase/migrations/20261027010000_upload_into_dances.sql;
the other tables belong to the team's schema.

Configuration (backend environment only; the secret key must never ship in the app):
  STEPSYNC_SUPABASE_URL         https://<project>.supabase.co
  STEPSYNC_SUPABASE_SECRET_KEY  the project's secret / service_role key
"""

import csv
import logging
import math
import os
from dataclasses import dataclass
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

# Joint angle = angle at the middle landmark, in degrees.
JOINT_ANGLES = {
    "left_elbow": ("left_shoulder", "left_elbow", "left_wrist"),
    "right_elbow": ("right_shoulder", "right_elbow", "right_wrist"),
    "left_shoulder": ("left_elbow", "left_shoulder", "left_hip"),
    "right_shoulder": ("right_elbow", "right_shoulder", "right_hip"),
    "left_hip": ("left_shoulder", "left_hip", "left_knee"),
    "right_hip": ("right_shoulder", "right_hip", "right_knee"),
    "left_knee": ("left_hip", "left_knee", "left_ankle"),
    "right_knee": ("right_hip", "right_knee", "right_ankle"),
}
FRAME_BATCH = 300  # rows per insert request, keeps each request well under PostgREST limits


class SupabaseError(Exception):
    """Saving to Supabase failed; the message is safe to show to the app user."""


class StepsChangedError(SupabaseError):
    """The edit was made against steps that no longer match what's saved."""


class StepInUseError(SupabaseError):
    """A step that would be deleted still has practice data pointing at it."""


TEMP_STEP_ORDER = 100000


def _num(value):
    if value is None or value == "":
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def load_pose_frames(csv_path: Path) -> list[dict]:
    """Group the long-format pose CSV into one dict per frame, in frame order."""
    frames: dict[int, dict] = {}
    with csv_path.open(newline="") as handle:
        for row in csv.DictReader(handle):
            index = int(row["frame_index"])
            frame = frames.setdefault(index, {
                "frame_index": index,
                "timestamp_ms": int(float(row.get("timestamp_ms") or 0)),
                "pose_present": row.get("pose_present") == "1",
                "torso_scale_m": _num(row.get("torso_scale_m")),
                "keypoints": {},
            })
            name = row.get("landmark_name")
            if not frame["pose_present"] or not name:
                continue
            frame["keypoints"][name] = {
                "x": _num(row.get("x_norm")), "y": _num(row.get("y_norm")), "z": _num(row.get("z_relative")),
                "visibility": _num(row.get("visibility")), "presence": _num(row.get("presence")),
                "reliable": row.get("landmark_reliable") == "1",
                "wx": _num(row.get("world_x")), "wy": _num(row.get("world_y")), "wz": _num(row.get("world_z")),
                "hx": _num(row.get("hip_relative_x_norm")), "hy": _num(row.get("hip_relative_y_norm")),
                "hz": _num(row.get("hip_relative_z_norm")),
            }
    return [frames[i] for i in sorted(frames)]


def _point(keypoint, prefix):
    if not keypoint or not keypoint.get("reliable"):
        return None
    coords = tuple(keypoint.get(f"{prefix}{axis}") for axis in "xyz")
    return None if any(c is None for c in coords) else coords


def _angle(a, b, c):
    ba = [a[i] - b[i] for i in range(3)]
    bc = [c[i] - b[i] for i in range(3)]
    norm = math.dist(a, b) * math.dist(c, b)
    if norm == 0:
        return None
    cosine = max(-1.0, min(1.0, sum(ba[i] * bc[i] for i in range(3)) / norm))
    return round(math.degrees(math.acos(cosine)), 1)


def add_motion_features(frames: list[dict]) -> dict:
    """Add per-frame features in place and return whole-video summary features.

    speed          per keypoint, in torso lengths per second, from hip-relative coordinates
                   (body movement, independent of camera distance and of walking across frame)
    motion_energy  mean keypoint speed in the frame
    joint_angles   elbows, shoulders, hips, knees in degrees, from 3D world coordinates
    """
    previous = None
    energies = []
    for frame in frames:
        keypoints = frame["keypoints"]
        frame["joint_angles"] = {}
        frame["motion_energy"] = None
        if not frame["pose_present"]:
            previous = None
            continue
        for joint, (a, b, c) in JOINT_ANGLES.items():
            points = [_point(keypoints.get(n), "w") for n in (a, b, c)]
            frame["joint_angles"][joint] = None if None in points else _angle(*points)

        speeds = []
        if previous is not None:
            seconds = (frame["timestamp_ms"] - previous["timestamp_ms"]) / 1000
            for name, keypoint in keypoints.items():
                now, before = _point(keypoint, "h"), _point(previous["keypoints"].get(name), "h")
                if seconds > 0 and now and before:
                    keypoint["speed"] = round(math.dist(now, before) / seconds, 4)
                    speeds.append(keypoint["speed"])
        if speeds:
            frame["motion_energy"] = round(sum(speeds) / len(speeds), 4)
            energies.append(frame["motion_energy"])
        previous = frame

    with_pose = sum(1 for f in frames if f["pose_present"])
    return {
        "frames_with_pose": with_pose,
        "pose_coverage": round(with_pose / len(frames), 4) if frames else 0,
        "avg_motion_energy": round(sum(energies) / len(energies), 4) if energies else None,
        "peak_motion_energy": max(energies) if energies else None,
    }


@dataclass(frozen=True)
class SupabaseConfig:
    url: str
    secret_key: str

    @classmethod
    def from_env(cls) -> "SupabaseConfig | None":
        url = os.getenv("STEPSYNC_SUPABASE_URL", "").strip().rstrip("/")
        key = os.getenv("STEPSYNC_SUPABASE_SECRET_KEY", "").strip()
        return cls(url, key) if url and key else None


class SupabaseStore:
    def __init__(self, config: SupabaseConfig, client: httpx.Client | None = None):
        self.config = config
        self.client = client or httpx.Client(timeout=30)

    @classmethod
    def from_env(cls) -> "SupabaseStore | None":
        config = SupabaseConfig.from_env()
        return cls(config) if config else None

    def _headers(self, bearer: str | None = None) -> dict:
        return {
            "apikey": self.config.secret_key,
            "Authorization": f"Bearer {bearer or self.config.secret_key}",
            "Content-Type": "application/json",
        }

    def user_id_for_token(self, access_token: str) -> str | None:
        """The signed-in app user's id, checked with Supabase Auth; None if the token is invalid."""
        try:
            response = self.client.get(f"{self.config.url}/auth/v1/user", headers=self._headers(access_token))
        except httpx.HTTPError:
            logger.exception("Could not reach Supabase Auth")
            return None
        return response.json().get("id") if response.status_code == 200 else None

    def save_dance(self, dance: dict, frames: list[dict], steps: list[dict]) -> str:
        """Insert the dance, its steps, keyframes and frames; returns the new dances id.

        If any insert fails, everything written for this dance is removed again.
        """
        rest = f"{self.config.url}/rest/v1"
        returning = {**self._headers(), "Prefer": "return=representation"}
        try:
            response = self.client.post(f"{rest}/dances", json=dance, headers=returning)
            self._check(response, "dances")
            dance_id = response.json()[0]["id"]
            step_ids: list[str] = []
            try:
                if steps:
                    response = self.client.post(f"{rest}/steps", json=[_step_row(dance_id, s) for s in steps],
                                                headers=returning)
                    self._check(response, "steps")
                    by_order = {row["step_order"]: row["id"] for row in response.json()}
                    step_ids = list(by_order.values())
                    keyframes = [row for s in steps for row in _keyframe_rows(by_order[s["step_index"] + 1], s, frames)]
                    if keyframes:
                        self._check(self.client.post(f"{rest}/keyframes", json=keyframes, headers=self._headers()),
                                    "keyframes")
                for start in range(0, len(frames), FRAME_BATCH):
                    rows = [_frame_row(dance_id, f) for f in frames[start:start + FRAME_BATCH]]
                    self._check(self.client.post(f"{rest}/pose_frames", json=rows, headers=self._headers()), "pose_frames")
            except Exception:
                self._remove(dance_id, step_ids)
                raise
            return dance_id
        except httpx.HTTPError as error:
            logger.exception("Supabase request failed")
            raise SupabaseError("Couldn't reach Supabase. Check STEPSYNC_SUPABASE_URL and the network.") from error

    def get_dance(self, dance_id: str) -> dict | None:
        """The dance's owner and saved video name, or None if it doesn't exist."""
        try:
            response = self.client.get(
                f"{self.config.url}/rest/v1/dances",
                params={"id": f"eq.{dance_id}", "select": "id,owner_id,video_path"},
                headers=self._headers(),
            )
        except httpx.HTTPError as error:
            logger.exception("Supabase request failed")
            raise SupabaseError("Couldn't reach Supabase. Check STEPSYNC_SUPABASE_URL and the network.") from error
        if response.status_code >= 300:
            self._check(response, "dances")
        rows = response.json()
        return rows[0] if rows else None

    def update_steps(self, dance_id: str, steps: list[dict], frames: list[dict],
                     sources: list[int | None] | None = None, saved_count: int | None = None) -> None:
        """Save edited steps: moved, split or merged.

        sources[i] is the position (0-based, in step_order) of the saved step that steps[i] continues, or None
        for a new step (the right half of a split). A step that continues a saved one keeps its id, so practice
        data pointing at it keeps working. Saved steps no step continues (merged away) are deleted; if practice
        data still points at one, nothing is deleted and StepInUseError is raised.
        With no sources, steps map one-to-one onto the saved steps.
        """
        rest, headers = f"{self.config.url}/rest/v1", self._headers()
        try:
            response = self.client.get(
                f"{rest}/steps", params={"dance_id": f"eq.{dance_id}", "select": "id,step_order", "order": "step_order"},
                headers=headers,
            )
            self._check(response, "steps")
            existing = response.json()
            if sources is None:
                if len(existing) != len(steps):
                    raise StepsChangedError(
                        f"This dance has {len(existing)} steps in Supabase but {len(steps)} were sent.")
                sources = list(range(len(steps)))
            if saved_count is not None and saved_count != len(existing):
                raise StepsChangedError("The steps changed since you opened this dance. Reload it and try again.")
            kept = [s for s in sources if s is not None]
            if any(s < 0 or s >= len(existing) for s in kept) or any(b <= a for a, b in zip(kept, kept[1:])):
                raise StepsChangedError("The edited steps don't match the saved ones. Reload the dance and try again.")

            removed = [row["id"] for i, row in enumerate(existing) if i not in set(kept)]
            if removed:
                self._delete_steps(rest, headers, removed)

            # step_order may be unique per dance, so park moved steps on temporary numbers before the
            # new steps take their final ones.
            final_order = {sources[i]: i + 1 for i in range(len(steps)) if sources[i] is not None}
            for source, order in final_order.items():
                if existing[source]["step_order"] != order:
                    self._check(self.client.patch(f"{rest}/steps", params={"id": f"eq.{existing[source]['id']}"},
                                                  json={"step_order": TEMP_STEP_ORDER + order}, headers=headers), "steps")
            step_ids: list[str] = [""] * len(steps)
            new = [i for i, s in enumerate(sources) if s is None]
            if new:
                rows = [{**_step_row(dance_id, steps[i]), "step_order": i + 1} for i in new]
                response = self.client.post(f"{rest}/steps", json=rows,
                                            headers={**headers, "Prefer": "return=representation"})
                self._check(response, "steps")
                by_order = {row["step_order"]: row["id"] for row in response.json()}
                for i in new:
                    step_ids[i] = by_order[i + 1]
            for i, source in enumerate(sources):
                if source is None:
                    continue
                step_ids[i] = existing[source]["id"]
                update = {k: v for k, v in _step_row(dance_id, steps[i]).items()
                          if k in ("step_order", "name", "start_ms", "end_ms", "description")}
                update["step_order"] = i + 1
                self._check(self.client.patch(f"{rest}/steps", params={"id": f"eq.{step_ids[i]}"}, json=update,
                                              headers=headers), "steps")

            old_ids = [existing[s]["id"] for s in kept]
            if old_ids:
                self._check(self.client.delete(f"{rest}/keyframes", params={"step_id": f"in.({','.join(old_ids)})"},
                                               headers=headers), "keyframes")
            keyframes = [k for step_id, step in zip(step_ids, steps) for k in _keyframe_rows(step_id, step, frames)]
            if keyframes:
                self._check(self.client.post(f"{rest}/keyframes", json=keyframes, headers=headers), "keyframes")
        except httpx.HTTPError as error:
            logger.exception("Supabase request failed")
            raise SupabaseError("Couldn't reach Supabase. Check STEPSYNC_SUPABASE_URL and the network.") from error

    def _delete_steps(self, rest: str, headers: dict, step_ids: list[str]):
        """Delete merged-away steps and their keyframes. If anything else (practice data) still points at
        one of them, put the keyframes back and raise StepInUseError, so nothing is lost."""
        ids = f"in.({','.join(step_ids)})"
        response = self.client.get(f"{rest}/keyframes", params={"step_id": ids, "select": "*"}, headers=headers)
        self._check(response, "keyframes")
        backup = response.json()
        self._check(self.client.delete(f"{rest}/keyframes", params={"step_id": ids}, headers=headers), "keyframes")
        response = self.client.delete(f"{rest}/steps", params={"id": ids}, headers=headers)
        if response.status_code < 300:
            return
        if backup:
            restored = self.client.post(f"{rest}/keyframes", json=backup, headers=headers)
            if restored.status_code >= 300:
                logger.error("Could not restore keyframes: %s %s", restored.status_code, restored.text[:500])
        if "23503" in response.text:
            raise StepInUseError(
                "One of the steps you merged already has practice data, so it can't be removed. "
                "Move the cuts instead, or clear that practice data first.")
        self._check(response, "steps")

    def _remove(self, dance_id: str, step_ids: list[str]):
        """Undo a partial save, children first (works whether or not the foreign keys cascade)."""
        rest, headers = f"{self.config.url}/rest/v1", self._headers()
        try:
            if step_ids:
                self.client.delete(f"{rest}/keyframes", params={"step_id": f"in.({','.join(step_ids)})"}, headers=headers)
            self.client.delete(f"{rest}/pose_frames", params={"dance_id": f"eq.{dance_id}"}, headers=headers)
            self.client.delete(f"{rest}/steps", params={"dance_id": f"eq.{dance_id}"}, headers=headers)
            self.client.delete(f"{rest}/dances", params={"id": f"eq.{dance_id}"}, headers=headers)
        except httpx.HTTPError:
            logger.exception("Could not remove partial dance %s", dance_id)

    @staticmethod
    def _check(response: httpx.Response, table: str):
        if response.status_code < 300:
            return
        logger.error("Supabase insert into %s failed: %s %s", table, response.status_code, response.text[:2000])
        hint = ""
        if (response.status_code == 404 or "does not exist" in response.text
                or "PGRST205" in response.text or "PGRST204" in response.text):
            hint = " Run backend/supabase/migrations/20261027010000_upload_into_dances.sql first."
        elif "23503" in response.text and table == "dances":
            hint = " The user has no row in profiles; every account needs one before it can own dances."
        elif response.status_code in (401, 403):
            hint = " Check STEPSYNC_SUPABASE_SECRET_KEY (use the secret/service_role key)."
        raise SupabaseError(f"Supabase rejected the {table} request ({response.status_code}).{hint}{_reason(response)}")


def _reason(response: httpx.Response) -> str:
    """Supabase's own explanation (e.g. which constraint failed), shortened for the app."""
    try:
        body = response.json()
    except ValueError:
        return ""
    if not isinstance(body, dict):
        return ""
    # "details" can repeat the whole failing row (all keypoints), so only message and hint.
    parts = [str(body[k]) for k in ("message", "hint") if body.get(k)]
    text = " ".join(parts)
    return f" Supabase says: {text[:300]}" if text else ""


INTENSITY_WORDS = {"slow": "Slow", "medium": "Medium", "fast": "Fast"}


def _step_row(dance_id: str, step: dict) -> dict:
    focus = " + ".join(part.capitalize() for part in step["focus"])
    description = INTENSITY_WORDS[step["intensity"]] + (f" \u00b7 {focus}" if focus else "")
    return {
        "dance_id": dance_id,
        "step_order": step["step_index"] + 1,
        "name": step["label"],
        "start_ms": step["start_ms"],
        "end_ms": step["end_ms"],
        "description": description,
    }


def _keyframe_rows(step_id: str, step: dict, frames: list[dict]) -> list[dict]:
    """Three key poses per step: the first, middle and last frames where the dancer is visible."""
    inside = [f for f in frames
              if step["start_frame"] <= f["frame_index"] <= step["end_frame"] and f["pose_present"]]
    if not inside:
        return []
    picks = [inside[0], inside[len(inside) // 2], inside[-1]]
    unique = list({f["frame_index"]: f for f in picks}.values())
    return [{
        "step_id": step_id,
        "frame_order": order,  # 1-based, like steps.step_order (keyframes_frame_order_check)
        "timestamp_ms": f["timestamp_ms"],
        "pose_data": {"frame_index": f["frame_index"], "keypoints": f["keypoints"], "joint_angles": f["joint_angles"]},
    } for order, f in enumerate(unique, start=1)]


def _frame_row(dance_id: str, frame: dict) -> dict:
    return {
        "dance_id": dance_id,
        "frame_index": frame["frame_index"],
        "timestamp_ms": frame["timestamp_ms"],
        "pose_present": frame["pose_present"],
        "torso_scale_m": frame["torso_scale_m"],
        "motion_energy": frame["motion_energy"],
        "joint_angles": frame["joint_angles"],
        "keypoints": frame["keypoints"],
    }
