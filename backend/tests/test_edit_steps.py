"""PUT /dances/{dance_id}/steps: saving step boundaries edited in the app."""

import json
import shutil
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.segmentation import steps_from_ranges
from app.supabase_store import SupabaseConfig, SupabaseStore, add_motion_features, load_pose_frames

SAMPLE_CSV = Path(__file__).resolve().parents[1] / "output" / "reze_pose_data.csv"
pytestmark = pytest.mark.skipif(not SAMPLE_CSV.is_file(), reason="sample pose CSV not in repo")
VIDEO = "Dance Short.mp4"
AUTH = {"Authorization": "Bearer good-token"}


class FakeSupabase:
    def __init__(self, owner="user-123", step_count=3, dance_exists=True, step_in_use=False):
        self.owner, self.step_count, self.dance_exists = owner, step_count, dance_exists
        self.step_in_use = step_in_use
        self.requests = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path, method = request.url.path, request.method
        if path == "/auth/v1/user":
            ok = request.headers["authorization"] == "Bearer good-token"
            return httpx.Response(200 if ok else 401, json={"id": "user-123"} if ok else {})
        if method == "GET" and path == "/rest/v1/dances":
            rows = [{"id": "dance-1", "owner_id": self.owner, "video_path": VIDEO}] if self.dance_exists else []
            return httpx.Response(200, json=rows)
        if method == "GET" and path == "/rest/v1/steps":
            return httpx.Response(200, json=[{"id": f"step-{i + 1}", "step_order": i + 1} for i in range(self.step_count)])
        if method == "GET" and path == "/rest/v1/keyframes":
            return httpx.Response(200, json=[{"id": "kf-1", "step_id": "step-2", "frame_order": 1}])
        if method == "DELETE" and path == "/rest/v1/steps" and self.step_in_use:
            return httpx.Response(409, json={"code": "23503", "message": 'violates foreign key constraint on table "step_attempts"'})
        if method in ("PATCH", "DELETE"):
            return httpx.Response(204)
        if method == "POST" and path == "/rest/v1/steps":
            rows = json.loads(request.content)
            return httpx.Response(201, json=[{**r, "id": f"new-{r['step_order']}"} for r in rows])
        if method == "POST":
            return httpx.Response(201, json={})
        return httpx.Response(404)

    def calls(self, method, table):
        return [r for r in self.requests if r.method == method and r.url.path == f"/rest/v1/{table}"]


def make_client(tmp_path, fake, with_pose=True):
    settings = Settings(data_directory=tmp_path / "data")
    settings.video_directory.mkdir(parents=True)
    (settings.video_directory / VIDEO).write_bytes(b"video")
    if with_pose:
        pose_dir = settings.pose_results_directory / Path(VIDEO).stem
        pose_dir.mkdir(parents=True)
        shutil.copy(SAMPLE_CSV, pose_dir / "pose_data.csv")
    store = None if fake is None else SupabaseStore(
        SupabaseConfig("https://proj.supabase.co", "secret"), httpx.Client(transport=httpx.MockTransport(fake)))
    return TestClient(create_app(settings, supabase_store=store))


EDITED = {"steps": [{"start_ms": 0, "end_ms": 2000}, {"start_ms": 2000, "end_ms": 5500}, {"start_ms": 5500, "end_ms": 9000}]}


def test_saves_moved_boundaries(tmp_path):
    fake = FakeSupabase()
    with make_client(tmp_path, fake) as client:
        response = client.put("/dances/dance-1/steps", json=EDITED, headers=AUTH)
    assert response.status_code == 200, response.text
    steps = response.json()["steps"]
    assert [s["label"] for s in steps] == ["Step 1", "Step 2", "Step 3"]
    # Edges snap to the nearest frame (about 33 ms apart).
    for step, sent in zip(steps, EDITED["steps"]):
        assert abs(step["start_ms"] - sent["start_ms"]) <= 20 and abs(step["end_ms"] - sent["end_ms"]) <= 20
    patches = fake.calls("PATCH", "steps")
    assert [dict(r.url.params)["id"] for r in patches] == ["eq.step-1", "eq.step-2", "eq.step-3"]
    assert set(json.loads(patches[1].content)) == {"step_order", "name", "start_ms", "end_ms", "description"}
    # Old keyframes removed, new ones written for the same step ids.
    assert dict(fake.calls("DELETE", "keyframes")[0].url.params)["step_id"] == "in.(step-1,step-2,step-3)"
    keyframes = json.loads(fake.calls("POST", "keyframes")[0].content)
    assert {k["step_id"] for k in keyframes} == {"step-1", "step-2", "step-3"}
    assert all(k["frame_order"] >= 1 for k in keyframes)
    assert not fake.calls("POST", "steps") and not fake.calls("DELETE", "steps"), "steps keep their ids"


def test_labels_match_a_fresh_segmentation_of_the_same_ranges(tmp_path):
    with make_client(tmp_path, FakeSupabase()) as client:
        steps = client.put("/dances/dance-1/steps", json=EDITED, headers=AUTH).json()["steps"]
    frames = load_pose_frames(SAMPLE_CSV)
    add_motion_features(frames)
    expected = steps_from_ranges(frames, [(s["start_ms"], s["end_ms"]) for s in EDITED["steps"]])
    assert [(s["intensity"], s["focus"]) for s in steps] == [(s["intensity"], s["focus"]) for s in expected]


def test_needs_login(tmp_path):
    with make_client(tmp_path, FakeSupabase()) as client:
        assert client.put("/dances/dance-1/steps", json=EDITED).status_code == 401


def test_only_owner_can_edit(tmp_path):
    fake = FakeSupabase(owner="someone-else")
    with make_client(tmp_path, fake) as client:
        assert client.put("/dances/dance-1/steps", json=EDITED, headers=AUTH).status_code == 403
    assert not fake.calls("PATCH", "steps")


def test_unknown_dance(tmp_path):
    with make_client(tmp_path, FakeSupabase(dance_exists=False)) as client:
        assert client.put("/dances/dance-1/steps", json=EDITED, headers=AUTH).status_code == 404


@pytest.mark.parametrize("steps, message", [
    ([{"start_ms": 0, "end_ms": 2000}, {"start_ms": 2100, "end_ms": 4000}], "no gaps"),
    ([{"start_ms": 0, "end_ms": 2000}, {"start_ms": 1900, "end_ms": 4000}], "no gaps"),
    ([{"start_ms": 0, "end_ms": 100}, {"start_ms": 100, "end_ms": 4000}], "at least"),
    ([], "at least one"),
])
def test_rejects_bad_boundaries(tmp_path, steps, message):
    fake = FakeSupabase()
    with make_client(tmp_path, fake) as client:
        response = client.put("/dances/dance-1/steps", json={"steps": steps}, headers=AUTH)
    assert response.status_code == 422
    assert message in response.json()["detail"]
    assert not fake.calls("PATCH", "steps")


def test_step_count_must_match(tmp_path):
    with make_client(tmp_path, FakeSupabase(step_count=4)) as client:
        response = client.put("/dances/dance-1/steps", json=EDITED, headers=AUTH)
    assert response.status_code == 409
    assert "4 steps" in response.json()["detail"]


def test_missing_pose_data(tmp_path):
    with make_client(tmp_path, FakeSupabase(), with_pose=False) as client:
        assert client.put("/dances/dance-1/steps", json=EDITED, headers=AUTH).status_code == 409


def test_without_supabase(tmp_path):
    with make_client(tmp_path, None) as client:
        assert client.put("/dances/dance-1/steps", json=EDITED, headers=AUTH).status_code == 503


def ranges(*cuts, sources):
    return {"steps": [{"start_ms": a, "end_ms": b, "source": src} for (a, b), src in zip(zip(cuts, cuts[1:]), sources)],
            "saved_count": 3}


def test_split_adds_a_step_and_keeps_old_ids(tmp_path):
    fake = FakeSupabase()
    # Step 2 (2000-5500) split at 4000: the left half keeps step-2, the right half is new.
    body = ranges(0, 2000, 4000, 5500, 9000, sources=[0, 1, None, 2])
    with make_client(tmp_path, fake) as client:
        response = client.put("/dances/dance-1/steps", json=body, headers=AUTH)
    assert response.status_code == 200, response.text
    assert [s["label"] for s in response.json()["steps"]] == ["Step 1", "Step 2", "Step 3", "Step 4"]
    assert not fake.calls("DELETE", "steps")
    inserted = json.loads(fake.calls("POST", "steps")[0].content)
    assert [(r["step_order"], r["name"]) for r in inserted] == [(3, "Step 3")]
    patches = [(dict(r.url.params)["id"], json.loads(r.content)) for r in fake.calls("PATCH", "steps")]
    # step-3 moves from order 3 to 4: parked on a temporary number before the new step takes 3.
    assert patches[0] == ("eq.step-3", {"step_order": 100004})
    final = {pid: p for pid, p in patches[1:]}
    assert final["eq.step-3"]["step_order"] == 4 and final["eq.step-3"]["name"] == "Step 4"
    assert final["eq.step-1"]["step_order"] == 1 and final["eq.step-2"]["step_order"] == 2
    keyframes = json.loads(fake.calls("POST", "keyframes")[0].content)
    assert {k["step_id"] for k in keyframes} == {"step-1", "step-2", "new-3", "step-3"}


def test_merge_deletes_the_merged_away_step(tmp_path):
    fake = FakeSupabase()
    # Steps 2 and 3 merged: the merged step keeps step-2, step-3 is deleted.
    body = ranges(0, 2000, 9000, sources=[0, 1])
    with make_client(tmp_path, fake) as client:
        response = client.put("/dances/dance-1/steps", json=body, headers=AUTH)
    assert response.status_code == 200, response.text
    assert len(response.json()["steps"]) == 2
    assert dict(fake.calls("DELETE", "steps")[0].url.params)["id"] == "in.(step-3)"
    assert dict(fake.calls("DELETE", "keyframes")[0].url.params)["step_id"] == "in.(step-3)"
    assert not fake.calls("POST", "steps")
    keyframes = json.loads(fake.calls("POST", "keyframes")[-1].content)
    assert {k["step_id"] for k in keyframes} == {"step-1", "step-2"}


def test_merge_blocked_when_step_has_practice_data(tmp_path):
    fake = FakeSupabase(step_in_use=True)
    body = ranges(0, 5500, 9000, sources=[0, 2])  # step-2 merged into step-1
    with make_client(tmp_path, fake) as client:
        response = client.put("/dances/dance-1/steps", json=body, headers=AUTH)
    assert response.status_code == 409
    assert "practice data" in response.json()["detail"]
    # Its keyframes are put back and no other step was touched.
    assert json.loads(fake.calls("POST", "keyframes")[0].content) == [{"id": "kf-1", "step_id": "step-2", "frame_order": 1}]
    assert not fake.calls("PATCH", "steps")


@pytest.mark.parametrize("sources", [[0, 0, 2], [1, 0, 2], [0, 1, 5], [-1, 1, 2]])
def test_rejects_sources_that_dont_match(tmp_path, sources):
    fake = FakeSupabase()
    with make_client(tmp_path, fake) as client:
        response = client.put("/dances/dance-1/steps", json=ranges(0, 2000, 5500, 9000, sources=sources), headers=AUTH)
    assert response.status_code == 409
    assert not fake.calls("PATCH", "steps") and not fake.calls("DELETE", "steps")


def test_rejects_stale_saved_count(tmp_path):
    fake = FakeSupabase(step_count=4)
    with make_client(tmp_path, fake) as client:
        response = client.put("/dances/dance-1/steps", json=ranges(0, 2000, 5500, 9000, sources=[0, 1, 2]), headers=AUTH)
    assert response.status_code == 409
    assert "Reload" in response.json()["detail"]
