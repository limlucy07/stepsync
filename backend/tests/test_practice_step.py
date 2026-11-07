"""Step mastery: POST /dances/{id}/steps/{step_id}/practice and the progress rules."""

import json
import shutil
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app import main
from app.config import Settings
from app.main import create_app
from app.pose_processing import PoseArtifacts
from app.progress import can_practice, clean_title, dance_progress, title_key
from app.supabase_store import SupabaseConfig, SupabaseStore

SAMPLE_CSV = Path(__file__).resolve().parents[1] / "output" / "reze_pose_data.csv"
AUTH = {"Authorization": "Bearer good-token"}
ME = "user-123"
VIDEO = b"\x00\x00\x00\x18ftypmp42" + b"0" * 2000
STEPS = [
    {"id": "s1", "step_order": 1, "name": "Step 1", "start_ms": 0, "end_ms": 2000, "description": "Fast"},
    {"id": "s2", "step_order": 2, "name": "Step 2", "start_ms": 2000, "end_ms": 4500, "description": "Slow"},
    {"id": "s3", "step_order": 3, "name": "Step 3", "start_ms": 4500, "end_ms": 4800, "description": "Slow"},
    {"id": "s4", "step_order": 4, "name": "Step 4", "start_ms": 4800, "end_ms": 7000, "description": "Slow"},
]


# --- the rules ------------------------------------------------------------------

def test_first_step_is_current_before_any_practice():
    progress = dance_progress(STEPS, [])
    assert progress["current_step"] == 0 and progress["mastered_step_ids"] == [] and not progress["completed"]
    assert can_practice(progress, 0) and not can_practice(progress, 1)


def test_over_80_masters_a_step_and_80_does_not():
    progress = dance_progress(STEPS, [{"step_id": "s1", "score": 80}])
    assert progress["current_step"] == 0
    progress = dance_progress(STEPS, [{"step_id": "s1", "score": 80}, {"step_id": "s1", "score": 81}])
    assert progress["mastered_step_ids"] == ["s1"] and progress["current_step"] == 1
    assert progress["best_scores"] == {"s1": 81}
    assert can_practice(progress, 0) and can_practice(progress, 1) and not can_practice(progress, 2)


def test_a_later_low_score_does_not_unmaster():
    progress = dance_progress(STEPS, [{"step_id": "s1", "score": 90}, {"step_id": "s1", "score": 30}])
    assert progress["mastered_step_ids"] == ["s1"] and progress["best_scores"]["s1"] == 90


def test_every_step_mastered():
    progress = dance_progress(STEPS, [{"step_id": s["id"], "score": 99} for s in STEPS])
    assert progress["completed"] and progress["current_step"] == 4 and progress["steps_completed"] == 4
    assert all(can_practice(progress, i) for i in range(4))


def test_attempts_on_steps_that_no_longer_exist_are_ignored():
    progress = dance_progress(STEPS, [{"step_id": "gone", "score": 99}, {"step_id": "s1", "score": None}])
    assert progress["best_scores"] == {} and progress["current_step"] == 0


def test_names_match_ignoring_case_and_spaces():
    assert clean_title("  Perfect    Night ") == "Perfect Night"
    assert title_key("PERFECT night") == title_key(" perfect  Night")
    assert title_key("Perfect Night 2") != title_key("Perfect Night")


# --- the endpoint -------------------------------------------------------------------

class FakeSupabase:
    """Keeps practice_sessions, step_attempts and user_dance_progress rows like Supabase would."""

    def __init__(self, owner=ME, is_public=False, video_path="My Dance.mp4", fail_attempts=False):
        self.dance = {"id": "d1", "owner_id": owner, "title": "My Dance", "video_path": video_path,
                      "is_public": is_public, "duration_ms": 16000, "status": "ready"}
        self.sessions, self.attempts, self.progress = [], [], []
        self.fail_attempts = fail_attempts

    def seed_attempt(self, step_id, score):
        if not self.sessions:
            self.sessions.append({"id": "ps-1", "user_id": ME, "dance_id": "d1"})
        self.attempts.append({"session_id": "ps-1", "step_id": step_id, "score": score, "attempt_number": 1})

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path, method = request.url.path, request.method
        params = dict(request.url.params)
        if path == "/auth/v1/user":
            ok = request.headers["authorization"] == "Bearer good-token"
            return httpx.Response(200 if ok else 401, json={"id": ME} if ok else {})
        table = path.removeprefix("/rest/v1/")
        body = json.loads(request.content) if request.content else None
        if table == "dances":
            return httpx.Response(200, json=[self.dance] if params.get("id") == "eq.d1" else [])
        if table == "steps":
            return httpx.Response(200, json=STEPS)
        if table == "practice_sessions":
            if method == "POST":
                row = {"id": f"ps-{len(self.sessions) + 1}", **body}
                self.sessions.append(row)
                return httpx.Response(201, json=[row])
            return httpx.Response(200, json=[{"id": s["id"]} for s in self.sessions])
        if table == "step_attempts":
            if method == "POST":
                if self.fail_attempts:
                    return httpx.Response(400, json={"message": "column score does not exist"})
                self.attempts.append(body)
                return httpx.Response(201, json={})
            rows = self.attempts
            if "step_id" in params:
                rows = [a for a in rows if a["step_id"] == params["step_id"].removeprefix("eq.")]
            return httpx.Response(200, json=rows)
        if table == "user_dance_progress":
            if method == "PATCH":
                for row in self.progress:
                    row.update(body)
                return httpx.Response(200, json=self.progress)
            if method == "POST":
                self.progress.append(body)
                return httpx.Response(201, json={})
            return httpx.Response(200, json=self.progress)
        return httpx.Response(404)


class FakePose:
    """Each practice video's pose data is the tutorial's own pose data between trim_ms (a perfect take of
    that part), or the whole tutorial when trim_ms is None (a recording of the wrong part)."""

    def __init__(self):
        self.trim_ms = None
        self.calls = 0

    def __call__(self, video, out_dir, model, timeout):
        self.calls += 1
        out_dir.mkdir(parents=True, exist_ok=True)
        data = out_dir / "pose_data.csv"
        if Path(video).stem == "practice" and self.trim_ms:
            start, end = self.trim_ms
            lines = SAMPLE_CSV.read_text().splitlines()
            keep = [lines[0]]
            for line in lines[1:]:
                cells = line.split(",")
                t = int(cells[1])
                if start <= t <= end:
                    cells[1] = str(t - start)
                    keep.append(",".join(cells))
            data.write_text("\n".join(keep) + "\n")
        else:
            shutil.copy(SAMPLE_CSV, data)
        return PoseArtifacts(out_dir / "x.mp4", data)


pytestmark = pytest.mark.skipif(not SAMPLE_CSV.is_file(), reason="sample pose CSV not in repo")


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path / "uploads")
    settings = Settings(data_directory=tmp_path / "data")
    settings.video_directory.mkdir(parents=True)
    (settings.video_directory / "My Dance.mp4").write_bytes(VIDEO)
    pose_dir = settings.pose_results_directory / "My Dance"
    pose_dir.mkdir(parents=True)
    shutil.copy(SAMPLE_CSV, pose_dir / "pose_data.csv")
    fake, pose = FakeSupabase(), FakePose()

    def client_for(supabase=None):
        store = SupabaseStore(SupabaseConfig("https://proj.supabase.co", "secret"),
                              httpx.Client(transport=httpx.MockTransport(supabase or fake)))
        return TestClient(create_app(settings, pose_runner=pose, supabase_store=store))

    return fake, pose, client_for


def practice(client, step_id, headers=AUTH):
    return client.post(f"/dances/d1/steps/{step_id}/practice",
                       files={"practice": ("practice.mov", VIDEO, "video/quicktime")}, headers=headers)


def test_mastering_a_step_unlocks_the_next(setup):
    fake, pose, client_for = setup
    pose.trim_ms = (0, 2000)  # a good take of step 1
    with client_for() as client:
        assert practice(client, "s2").status_code == 403, "step 2 is locked at first"
        response = practice(client, "s1")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["passed"] and body["overallScore"] > 80 and body["stepIndex"] == 0
        assert body["progress"]["mastered_step_ids"] == ["s1"] and body["progress"]["current_step"] == 1
        # Saved: one session, one attempt, and the user's progress row pointing at step 2.
        assert len(fake.sessions) == 1 and fake.attempts[0]["step_id"] == "s1"
        assert fake.attempts[0]["attempt_number"] == 1 and fake.attempts[0]["score"] == body["overallScore"]
        assert fake.progress == [{"user_id": ME, "dance_id": "d1", "steps_completed": 1, "current_step_id": "s2"}]
        # The dance screen shows it, and step 2 can now be practiced.
        assert client.get("/dances/d1", headers=AUTH).json()["progress"]["current_step"] == 1
        pose.trim_ms = (2000, 4500)
        assert practice(client, "s2").json()["passed"]
    assert fake.progress[0]["steps_completed"] == 2 and fake.progress[0]["current_step_id"] == "s3"
    assert len(fake.sessions) == 1, "attempts go into the same practice session"


def test_a_failed_attempt_is_saved_but_does_not_unlock(setup):
    fake, pose, client_for = setup
    pose.trim_ms = None  # whole dance recorded instead of step 1
    with client_for() as client:
        body = practice(client, "s1").json()
        assert not body["passed"] and body["overallScore"] <= 80
        assert body["progress"]["current_step"] == 0
        assert fake.attempts[0]["score"] == body["overallScore"]
        assert practice(client, "s2").status_code == 403
        assert practice(client, "s1").json()["progress"]["best_scores"]["s1"] == body["overallScore"]
    assert [a["attempt_number"] for a in fake.attempts] == [1, 2]


def test_mastered_steps_can_be_practiced_again(setup):
    fake, pose, client_for = setup
    fake.seed_attempt("s1", 95)
    fake.seed_attempt("s2", 92)
    pose.trim_ms = (0, 2000)
    with client_for() as client:
        body = practice(client, "s1").json()
    assert body["passed"] and body["progress"]["current_step"] == 2


def test_locked_message_names_the_step_to_master(setup):
    fake, pose, client_for = setup
    fake.seed_attempt("s1", 95)
    with client_for() as client:
        response = practice(client, "s4")
    assert response.status_code == 403
    assert response.json()["detail"] == "Master step 2 first to unlock step 4."
    assert pose.calls == 0, "nothing is processed for a locked step"


def test_too_short_step(setup):
    fake, pose, client_for = setup
    fake.seed_attempt("s1", 95)
    fake.seed_attempt("s2", 95)
    with client_for() as client:
        response = practice(client, "s3")  # 0.3 s long
    assert response.status_code == 422 and "too short" in response.json()["detail"]


def test_score_still_shown_when_saving_fails(setup):
    fake, pose, client_for = setup
    pose.trim_ms = (0, 2000)
    with client_for(FakeSupabase(fail_attempts=True)) as client:
        body = practice(client, "s1").json()
    assert body["passed"] and "couldn't be saved" in body["progress_error"]
    assert body["progress"]["current_step"] == 0, "nothing was saved, so nothing unlocks"


@pytest.mark.parametrize("kind", ["login", "other user private", "unknown step", "video elsewhere"])
def test_refusals(setup, kind):
    fake, pose, client_for = setup
    supabase = {
        "other user private": FakeSupabase(owner="someone-else"),
        "video elsewhere": FakeSupabase(video_path="not-here.mp4"),
    }.get(kind)
    with client_for(supabase) as client:
        if kind == "login":
            assert practice(client, "s1", headers={}).status_code == 401
        elif kind == "unknown step":
            assert practice(client, "nope").status_code == 404
        elif kind == "other user private":
            assert practice(client, "s1").status_code == 404
        else:
            response = practice(client, "s1")
            assert response.status_code == 409 and "another" in response.json()["detail"]


def test_public_dances_can_be_practiced_by_others(setup):
    fake, pose, client_for = setup
    pose.trim_ms = (0, 2000)
    with client_for(FakeSupabase(owner="someone-else", is_public=True)) as client:
        assert practice(client, "s1").json()["passed"]
