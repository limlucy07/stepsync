"""Saving keypoints and motion features to Supabase (no real network)."""

import json
import shutil
from pathlib import Path
from unittest.mock import patch

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.pose_processing import PoseArtifacts
from app.supabase_store import (FRAME_BATCH, SupabaseConfig, SupabaseError, SupabaseStore,
                                add_motion_features, load_pose_frames)

SAMPLE_CSV = Path(__file__).resolve().parents[1] / "output" / "reze_pose_data.csv"
needs_sample = pytest.mark.skipif(not SAMPLE_CSV.is_file(), reason="sample pose CSV not in repo")


@needs_sample
def test_groups_csv_into_frames():
    frames = load_pose_frames(SAMPLE_CSV)
    assert len(frames) == 616
    assert [f["frame_index"] for f in frames] == sorted(f["frame_index"] for f in frames)
    with_pose = [f for f in frames if f["pose_present"]]
    assert len(with_pose) == 487
    assert all(len(f["keypoints"]) == 33 for f in with_pose)
    assert all(f["keypoints"] == {} for f in frames if not f["pose_present"])
    nose = with_pose[0]["keypoints"]["nose"]
    assert set(nose) >= {"x", "y", "z", "visibility", "reliable", "wx", "hx"}


@needs_sample
def test_motion_features():
    frames = load_pose_frames(SAMPLE_CSV)
    summary = add_motion_features(frames)
    assert summary["frames_with_pose"] == 487
    assert summary["pose_coverage"] == pytest.approx(487 / 616, abs=1e-3)
    assert 0 < summary["avg_motion_energy"] <= summary["peak_motion_energy"]
    angles = [a for f in frames for a in f["joint_angles"].values() if a is not None]
    assert angles and all(0 <= a <= 180 for a in angles)
    speeds = [k["speed"] for f in frames for k in f["keypoints"].values() if "speed" in k]
    assert speeds and min(speeds) >= 0
    # Frames without a dancer carry no features.
    assert all(f["motion_energy"] is None and f["joint_angles"] == {} for f in frames if not f["pose_present"])
    json.dumps(frames, allow_nan=False)  # must be valid JSON for Supabase


def test_csv_without_landmark_columns(tmp_path):
    path = tmp_path / "pose.csv"
    path.write_text("frame_index,pose_present\n0,0\n")
    frames = load_pose_frames(path)
    assert frames == [{"frame_index": 0, "timestamp_ms": 0, "pose_present": False, "torso_scale_m": None, "keypoints": {}}]
    assert add_motion_features(frames)["frames_with_pose"] == 0


class FakeSupabase:
    """Records requests and answers like Supabase's REST API."""

    def __init__(self, fail_table=None, fail_status=500, fail_body=None, titles=()):
        self.requests = []
        self.titles = list(titles)  # names of the user's existing dances
        self.fail_table, self.fail_status, self.fail_body = fail_table, fail_status, fail_body or {"message": "boom"}

    def posted(self, table):
        return [json.loads(r.content) for r in self.requests if r.method == "POST" and r.url.path == f"/rest/v1/{table}"]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/auth/v1/user":
            ok = request.headers["authorization"] == "Bearer good-token"
            return httpx.Response(200 if ok else 401, json={"id": "user-123"} if ok else {})
        table = path.removeprefix("/rest/v1/")
        if request.method == "DELETE":
            return httpx.Response(204)
        if request.method == "GET" and table == "dances":
            return httpx.Response(200, json=[{"title": t} for t in self.titles])
        if request.method == "POST":
            if table == self.fail_table:
                return httpx.Response(self.fail_status, json=self.fail_body)
            body = json.loads(request.content)
            if table == "dances":
                return httpx.Response(201, json=[{"id": "dance-1", **body}])
            if table == "steps":
                return httpx.Response(201, json=[{"id": f"step-{r['step_order']}", **r} for r in body])
            return httpx.Response(201, json={})
        return httpx.Response(404)


def make_store(fake):
    return SupabaseStore(SupabaseConfig("https://proj.supabase.co", "secret"), httpx.Client(transport=httpx.MockTransport(fake)))


def frames_fixture(count):
    return [{"frame_index": i, "timestamp_ms": i * 33, "pose_present": True, "torso_scale_m": None,
             "keypoints": {"nose": {"x": 0.5}}, "joint_angles": {}, "motion_energy": None} for i in range(count)]


STEPS = [
    {"step_index": 0, "label": "Step 1", "start_frame": 0, "end_frame": 40, "start_ms": 0, "end_ms": 1320,
     "intensity": "fast", "focus": ["legs", "arms"], "avg_motion_energy": 2.0, "peak_motion_energy": 3.0},
    {"step_index": 1, "label": "Step 2", "start_frame": 40, "end_frame": 80, "start_ms": 1320, "end_ms": 2640,
     "intensity": "slow", "focus": [], "avg_motion_energy": 0.5, "peak_motion_energy": 1.0},
]


def test_save_dance_writes_team_tables():
    fake = FakeSupabase()
    dance_id = make_store(fake).save_dance({"owner_id": "user-123", "title": "x"}, frames_fixture(FRAME_BATCH * 2 + 5), STEPS)
    assert dance_id == "dance-1"
    steps = fake.posted("steps")[0]
    assert [s["step_order"] for s in steps] == [1, 2]
    assert steps[0] == {"dance_id": "dance-1", "step_order": 1, "name": "Step 1", "start_ms": 0, "end_ms": 1320,
                        "description": "Fast \u00b7 Legs + Arms"}
    assert steps[1]["description"] == "Slow"
    keyframes = fake.posted("keyframes")[0]
    # frame_order is 1-based: the team's keyframes_frame_order_check rejects 0.
    assert [(k["step_id"], k["frame_order"]) for k in keyframes] == [("step-1", 1), ("step-1", 2), ("step-1", 3),
                                                                     ("step-2", 1), ("step-2", 2), ("step-2", 3)]
    assert [k["pose_data"]["frame_index"] for k in keyframes[:3]] == [0, 20, 40]
    assert "tolerance" not in keyframes[0]  # keeps the team's default
    batches = fake.posted("pose_frames")
    assert [len(b) for b in batches] == [FRAME_BATCH, FRAME_BATCH, 5]
    assert all(row["dance_id"] == "dance-1" for b in batches for row in b)
    assert all(r.headers["apikey"] == "secret" for r in fake.requests)


@pytest.mark.parametrize("table", ["steps", "keyframes", "pose_frames"])
def test_failure_removes_everything(table):
    fake = FakeSupabase(fail_table=table)
    with pytest.raises(SupabaseError):
        make_store(fake).save_dance({"owner_id": "u", "title": "x"}, frames_fixture(90), STEPS)
    deletes = [(r.url.path, dict(r.url.params)) for r in fake.requests if r.method == "DELETE"]
    assert ("/rest/v1/dances", {"id": "eq.dance-1"}) in deletes
    assert ("/rest/v1/steps", {"dance_id": "eq.dance-1"}) in deletes
    assert ("/rest/v1/pose_frames", {"dance_id": "eq.dance-1"}) in deletes
    if table != "steps":
        assert ("/rest/v1/keyframes", {"step_id": "in.(step-1,step-2)"}) in deletes


def test_missing_table_hint():
    with pytest.raises(SupabaseError, match="upload_into_dances"):
        make_store(FakeSupabase(fail_table="pose_frames", fail_status=404, fail_body={"code": "PGRST205"})).save_dance(
            {"owner_id": "u", "title": "x"}, frames_fixture(3), [])


def test_missing_profile_hint():
    body = {"code": "23503", "message": "violates foreign key constraint dances_owner_id_fkey"}
    with pytest.raises(SupabaseError, match="profiles"):
        make_store(FakeSupabase(fail_table="dances", fail_status=409, fail_body=body)).save_dance(
            {"owner_id": "u", "title": "x"}, frames_fixture(3), [])


def test_user_lookup():
    store = make_store(FakeSupabase())
    assert store.user_id_for_token("good-token") == "user-123"
    assert store.user_id_for_token("bad-token") is None


def test_config_from_env(monkeypatch):
    assert SupabaseConfig.from_env() is None
    monkeypatch.setenv("STEPSYNC_SUPABASE_URL", "https://proj.supabase.co/")
    monkeypatch.setenv("STEPSYNC_SUPABASE_SECRET_KEY", "secret")
    assert SupabaseConfig.from_env() == SupabaseConfig("https://proj.supabase.co", "secret")


# --- through the endpoint ---------------------------------------------------

def import_short(tmp_path, store, video, headers=None, pose_csv=SAMPLE_CSV, title=None):
    def download(url, directory, settings):
        from app.youtube import DownloadedVideo
        path = directory / "input.mp4"
        path.write_bytes(video.read_bytes())
        return DownloadedVideo(path, "Dance Short")

    def pose_runner(video_path, output_directory, model_path, timeout_seconds):
        output_directory.mkdir(parents=True, exist_ok=True)
        data = output_directory / "pose_data.csv"
        shutil.copy(pose_csv, data)
        preview = output_directory / "skeleton_preview.mp4"
        preview.write_bytes(b"preview")
        return PoseArtifacts(preview, data)

    app = create_app(Settings(data_directory=tmp_path / "data"), pose_runner=pose_runner, supabase_store=store)
    body = {"url": "https://youtube.com/shorts/jNQXAC9IVRw", **({"title": title} if title is not None else {})}
    with patch("app.main.download_video", download), TestClient(app) as client:
        return client.post("/reference-videos", json=body, headers=headers or {})


@needs_sample
def test_endpoint_saves_to_supabase(tmp_path, video):
    fake = FakeSupabase()
    response = import_short(tmp_path, make_store(fake), video, headers={"Authorization": "Bearer good-token"})
    body = response.json()
    assert response.status_code == 200, body
    assert body["supabase_status"] == "saved"
    assert body["supabase_dance_id"] == "dance-1"
    assert body["frames_saved"] == 616
    dance = fake.posted("dances")[0]
    assert dance["owner_id"] == "user-123"
    assert dance["title"] == "Dance Short"
    assert dance["status"] == "ready"
    assert dance["source_url"] == "https://www.youtube.com/watch?v=jNQXAC9IVRw"
    assert dance["video_path"].endswith(".mp4") and "/" not in dance["video_path"]
    assert dance["duration_ms"] > 0
    assert len(body["steps"]) >= 6
    assert len(fake.posted("steps")[0]) == len(body["steps"])
    assert fake.posted("keyframes")[0]
    assert sum(len(b) for b in fake.posted("pose_frames")) == 616


@needs_sample
def test_endpoint_needs_login_to_save(tmp_path, video):
    fake = FakeSupabase()
    body = import_short(tmp_path, make_store(fake), video).json()
    assert body["supabase_status"] == "failed"
    assert "Log in" in body["supabase_error"]
    assert body["steps"]  # steps still come back for the app
    assert not fake.posted("dances")


@needs_sample
def test_endpoint_reports_supabase_failure_but_keeps_video(tmp_path, video):
    fake = FakeSupabase(fail_table="dances", fail_status=404, fail_body={"code": "PGRST205"})
    body = import_short(tmp_path, make_store(fake), video, headers={"Authorization": "Bearer good-token"}).json()
    assert body["persisted"] is True
    assert body["supabase_status"] == "failed"
    assert "upload_into_dances" in body["supabase_error"]


@needs_sample
def test_steps_returned_without_supabase(tmp_path, video):
    body = import_short(tmp_path, None, video).json()
    assert body["supabase_status"] == "not_configured"
    assert len(body["steps"]) >= 6


def test_endpoint_without_supabase(tmp_path, video):
    csv = tmp_path / "pose.csv"
    csv.write_text("frame_index,pose_present\n0,0\n")
    response = import_short(tmp_path, None, video, pose_csv=csv)
    assert response.json()["supabase_status"] == "not_configured"


def test_error_includes_supabase_reason():
    body = {"code": "23514", "message": 'new row for relation "keyframes" violates check constraint "keyframes_frame_order_check"'}
    with pytest.raises(SupabaseError, match="keyframes_frame_order_check"):
        make_store(FakeSupabase(fail_table="keyframes", fail_status=400, fail_body=body)).save_dance(
            {"owner_id": "u", "title": "x"}, frames_fixture(90), STEPS)


# --- dance names --------------------------------------------------------------

LOGIN = {"Authorization": "Bearer good-token"}


@needs_sample
def test_endpoint_saves_the_name_the_user_gave(tmp_path, video):
    fake = FakeSupabase(titles=["Perfect Night"])
    response = import_short(tmp_path, make_store(fake), video, headers=LOGIN, title="  My   Routine ")
    assert response.status_code == 200, response.json()
    assert fake.posted("dances")[0]["title"] == "My Routine"  # trimmed, spaces collapsed
    assert response.json()["filename"] == "My Routine.mp4"


@needs_sample
@pytest.mark.parametrize("name", ["Perfect Night", "perfect night", "  PERFECT   night "])
def test_endpoint_rejects_a_name_already_used(tmp_path, video, name):
    fake = FakeSupabase(titles=["Perfect Night"])
    response = import_short(tmp_path, make_store(fake), video, headers=LOGIN, title=name)
    assert response.status_code == 409
    assert "already have a dance called" in response.json()["detail"]
    assert not fake.posted("dances")
    assert not list((tmp_path / "data").rglob("*.mp4")), "rejected before downloading anything"


@needs_sample
@pytest.mark.parametrize("name, message", [("   ", "Give the dance a name"), ("x" * 81, "under 80")])
def test_endpoint_rejects_bad_names(tmp_path, video, name, message):
    response = import_short(tmp_path, make_store(FakeSupabase()), video, headers=LOGIN, title=name)
    assert response.status_code == 422
    assert message in response.json()["detail"]


@needs_sample
def test_youtube_title_gets_a_number_when_taken(tmp_path, video):
    # No name sent (older app): the YouTube title is used, numbered so it stays unique.
    fake = FakeSupabase(titles=["Dance Short", "dance short (2)"])
    import_short(tmp_path, make_store(fake), video, headers=LOGIN)
    assert fake.posted("dances")[0]["title"] == "Dance Short (3)"
