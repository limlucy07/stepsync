"""GET /dances and GET /dances/{id}: reading saved dances for the home and dance screens."""

import httpx
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.supabase_store import SupabaseConfig, SupabaseStore, step_from_row

AUTH = {"Authorization": "Bearer good-token"}
ME = "user-123"

DANCES = [
    {"id": "d-old", "owner_id": ME, "title": "Old one", "video_path": "old.mp4", "source_url": "https://youtu.be/a",
     "duration_ms": 15000, "status": "ready", "is_public": False, "created_at": "2026-10-01T00:00:00Z",
     "steps": [{"count": 4}]},
    {"id": "d-new", "owner_id": ME, "title": "New one", "video_path": "here.mp4", "source_url": "https://youtu.be/b",
     "duration_ms": 20500, "status": "ready", "is_public": False, "created_at": "2026-11-01T00:00:00Z",
     "steps": [{"count": 13}]},
    {"id": "d-public", "owner_id": "someone-else", "title": "Shared", "video_path": None, "source_url": None,
     "duration_ms": None, "status": "ready", "is_public": True, "created_at": "2026-10-15T00:00:00Z",
     "steps": [{"count": 2}]},
]
PRIVATE_OTHER = {"id": "d-private", "owner_id": "someone-else", "title": "Not yours", "is_public": False,
                 "video_path": None}
STEPS = [
    {"id": "s1", "step_order": 1, "name": "Step 1", "start_ms": 0, "end_ms": 800, "description": "Fast · Arms + Legs"},
    {"id": "s2", "step_order": 2, "name": "Step 2", "start_ms": 800, "end_ms": 2000, "description": "Slow"},
    {"id": "s3", "step_order": 3, "name": "Step 3", "start_ms": 2000, "end_ms": 3000, "description": None},
]


class FakeSupabase:
    def __init__(self, fail=False):
        self.fail = fail
        self.requests = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path, params = request.url.path, dict(request.url.params)
        if path == "/auth/v1/user":
            ok = request.headers["authorization"] == "Bearer good-token"
            return httpx.Response(200 if ok else 401, json={"id": ME} if ok else {})
        if self.fail:
            return httpx.Response(500, json={"message": "boom"})
        if path == "/rest/v1/dances":
            if "id" in params:
                wanted = params["id"].removeprefix("eq.")
                rows = [d for d in DANCES + [PRIVATE_OTHER] if d["id"] == wanted]
                return httpx.Response(200, json=[{k: v for k, v in r.items() if k != "steps"} for r in rows])
            return httpx.Response(200, json=[dict(d, steps=list(d["steps"])) for d in DANCES])
        if path == "/rest/v1/steps":
            return httpx.Response(200, json=STEPS if params["dance_id"] == "eq.d-new" else [])
        if path == "/rest/v1/user_dance_progress":
            return httpx.Response(200, json=[{"dance_id": "d-new", "steps_completed": 2}])
        if path == "/rest/v1/practice_sessions":
            return httpx.Response(200, json=[{"id": "ps-1"}] if params["dance_id"] == "eq.d-new" else [])
        if path == "/rest/v1/step_attempts":
            return httpx.Response(200, json=[{"step_id": "s1", "score": 95}, {"step_id": "s2", "score": 70}])
        return httpx.Response(404)


def make_client(tmp_path, fake):
    settings = Settings(data_directory=tmp_path / "data")
    settings.video_directory.mkdir(parents=True)
    (settings.video_directory / "here.mp4").write_bytes(b"video")  # only this one is on this backend
    store = None if fake is None else SupabaseStore(
        SupabaseConfig("https://proj.supabase.co", "secret"), httpx.Client(transport=httpx.MockTransport(fake)))
    return TestClient(create_app(settings, supabase_store=store))


def test_lists_my_dances_and_public_ones_newest_first(tmp_path):
    fake = FakeSupabase()
    with make_client(tmp_path, fake) as client:
        response = client.get("/dances", headers=AUTH)
    assert response.status_code == 200, response.text
    dances = response.json()["dances"]
    assert [d["id"] for d in dances] == ["d-new", "d-public", "d-old"]
    new, shared, old = dances
    assert new == {
        "id": "d-new", "title": "New one", "source_url": "https://youtu.be/b", "video_path": "here.mp4",
        "video_available": True, "duration_ms": 20500, "status": "ready", "is_public": False, "mine": True,
        "step_count": 13, "created_at": "2026-11-01T00:00:00Z", "steps_completed": 2,
    }
    assert old["steps_completed"] == 0
    assert old["video_available"] is False, "old.mp4 isn't on this backend"
    assert shared["mine"] is False and shared["video_available"] is False
    params = dict(next(r for r in fake.requests if r.url.path == "/rest/v1/dances").url.params)
    assert params["select"] == "*,steps(count)"
    assert params["or"] == f"(owner_id.eq.{ME},is_public.eq.true)"


def test_dance_with_steps(tmp_path):
    with make_client(tmp_path, FakeSupabase()) as client:
        response = client.get("/dances/d-new", headers=AUTH)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["title"] == "New one" and body["mine"] and body["step_count"] == 3
    assert body["steps"] == [
        {"id": "s1", "step_index": 0, "label": "Step 1", "start_ms": 0, "end_ms": 800, "intensity": "fast", "focus": ["arms", "legs"]},
        {"id": "s2", "step_index": 1, "label": "Step 2", "start_ms": 800, "end_ms": 2000, "intensity": "slow", "focus": []},
        {"id": "s3", "step_index": 2, "label": "Step 3", "start_ms": 2000, "end_ms": 3000, "intensity": "medium", "focus": []},
    ]
    # Step 1 scored 95 (mastered); step 2 only 70, so it's the current step.
    assert body["progress"] == {"mastered_step_ids": ["s1"], "best_scores": {"s1": 95, "s2": 70},
                                "current_step": 1, "steps_completed": 1, "completed": False}


def test_someone_elses_private_dance_is_hidden(tmp_path):
    with make_client(tmp_path, FakeSupabase()) as client:
        assert client.get("/dances/d-private", headers=AUTH).status_code == 404
        assert client.get("/dances/d-public", headers=AUTH).status_code == 200
        assert client.get("/dances/missing", headers=AUTH).status_code == 404


@pytest.mark.parametrize("path", ["/dances", "/dances/d-new"])
def test_needs_login(tmp_path, path):
    with make_client(tmp_path, FakeSupabase()) as client:
        assert client.get(path).status_code == 401
        assert client.get(path, headers={"Authorization": "Bearer bad"}).status_code == 401


def test_without_supabase(tmp_path):
    with make_client(tmp_path, None) as client:
        assert client.get("/dances", headers=AUTH).status_code == 503


def test_list_still_works_without_progress_table(tmp_path):
    class NoProgress(FakeSupabase):
        def __call__(self, request):
            if request.url.path == "/rest/v1/user_dance_progress":
                return httpx.Response(404, json={"code": "PGRST205", "message": "missing"})
            return super().__call__(request)

    with make_client(tmp_path, NoProgress()) as client:
        response = client.get("/dances", headers=AUTH)
    assert response.status_code == 200
    assert all(d["steps_completed"] == 0 for d in response.json()["dances"])


def test_supabase_errors_are_reported(tmp_path):
    with make_client(tmp_path, FakeSupabase(fail=True)) as client:
        response = client.get("/dances", headers=AUTH)
    assert response.status_code == 502
    assert "boom" in response.json()["detail"]


def test_step_from_row_matches_what_save_writes():
    from app.supabase_store import _step_row
    step = {"step_index": 4, "label": "Step 5", "start_ms": 10, "end_ms": 900, "intensity": "fast",
            "focus": ["torso", "head"]}
    assert step_from_row(4, _step_row("d", step)) == step
