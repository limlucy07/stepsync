"""POST /analyze: the phone app's upload endpoint, scored with Satwik's DTW comparison."""

import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import app.main as main
from app.config import Settings
from app.main import create_app
from app.pose_processing import PoseArtifacts

VIDEO = b"\x00\x00\x00\x18ftypmp42" + b"0" * 2000
SAMPLE_CSV = Path(__file__).resolve().parents[1] / "output" / "reze_pose_data.csv"
pytestmark = pytest.mark.skipif(not SAMPLE_CSV.is_file(), reason="sample pose CSV not in repo")


class FakePose:
    """Stands in for Kaitlyn's extractor: every video gets the same sample pose data."""

    def __init__(self):
        self.videos = []

    def __call__(self, video, out_dir, model, timeout):
        self.videos.append(Path(video).name)
        out_dir.mkdir(parents=True, exist_ok=True)
        shutil.copy(SAMPLE_CSV, out_dir / "pose_data.csv")
        (out_dir / "skeleton_preview.mp4").write_bytes(b"x")
        return PoseArtifacts(out_dir / "skeleton_preview.mp4", out_dir / "pose_data.csv")


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(main, "UPLOAD_DIR", tmp_path / "uploads")
    settings = Settings(data_directory=tmp_path / "data")
    settings.video_directory.mkdir(parents=True)
    pose = FakePose()
    with TestClient(create_app(settings, pose_runner=pose)) as client:
        client.settings = settings
        client.pose = pose
        yield client


def practice_file():
    return {"practice": ("practice.mov", VIDEO, "video/quicktime")}


def test_two_uploaded_files(client):
    files = {**practice_file(), "reference": ("ref.mp4", VIDEO, "video/mp4")}
    response = client.post("/analyze", files=files)
    assert response.status_code == 200
    body = response.json()
    assert body["steps"] and "sessionId" in body
    # Same pose data on both sides: a perfect match.
    assert body["overallScore"] == 100 and body["movementScore"] == 100 and body["timingScore"] == 100
    assert {"start", "end", "score", "feedback", "referenceStart", "referenceEnd"} <= set(body["steps"][0])
    saved = main.UPLOAD_DIR / body["sessionId"]
    assert (saved / "reference.mp4").is_file() and (saved / "practice.mov").is_file()


def test_reference_from_youtube_import(client):
    (client.settings.video_directory / "My Dance.mp4").write_bytes(VIDEO)
    response = client.post("/analyze", files=practice_file(), data={"reference_video": "My Dance.mp4"})
    assert response.status_code == 200
    saved = main.UPLOAD_DIR / response.json()["sessionId"]
    assert (saved / "practice.mov").is_file()
    assert not (saved / "reference.mp4").exists()  # the saved YouTube file is used in place
    assert client.pose.videos == ["My Dance.mp4", "practice.mov"]  # no pose data yet, so extracted once


def test_reuses_pose_data_from_the_youtube_import(client):
    (client.settings.video_directory / "My Dance.mp4").write_bytes(VIDEO)
    pose_dir = client.settings.pose_results_directory / "My Dance"
    pose_dir.mkdir(parents=True)
    shutil.copy(SAMPLE_CSV, pose_dir / "pose_data.csv")
    response = client.post("/analyze", files=practice_file(), data={"reference_video": "My Dance.mp4"})
    assert response.status_code == 200, response.text
    assert client.pose.videos == ["practice.mov"], "only the practice video needs pose extraction"


def test_scores_one_tutorial_step(client):
    (client.settings.video_directory / "My Dance.mp4").write_bytes(VIDEO)
    data = {"reference_video": "My Dance.mp4", "step_start_ms": "2000", "step_end_ms": "4500"}
    body = client.post("/analyze", files=practice_file(), data=data).json()
    # Only the step's part of the reference is compared, so its sections stay inside 2.0 to 4.5 s.
    assert all(2.0 <= s["referenceStart"] and s["referenceEnd"] <= 4.5 for s in body["steps"])
    assert body["referenceSamples"] < body["practiceSamples"]


@pytest.mark.parametrize("data, message", [
    ({"step_start_ms": "1000", "step_end_ms": "1300"}, "too short"),
    ({"step_start_ms": "1000"}, "both"),
    ({"step_start_ms": "3000", "step_end_ms": "2000"}, "both"),
])
def test_rejects_bad_step_ranges(client, data, message):
    files = {**practice_file(), "reference": ("ref.mp4", VIDEO, "video/mp4")}
    response = client.post("/analyze", files=files, data=data)
    assert response.status_code == 422
    assert message in response.json()["detail"]
    assert client.pose.videos == []


def test_no_dancer_found(client, monkeypatch):
    def empty_pose(video, out_dir, model, timeout):
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "pose_data.csv").write_text(SAMPLE_CSV.read_text().splitlines()[0] + "\n")
        return PoseArtifacts(out_dir / "x.mp4", out_dir / "pose_data.csv")

    settings = client.settings
    with TestClient(create_app(settings, pose_runner=empty_pose)) as other:
        files = {**practice_file(), "reference": ("ref.mp4", VIDEO, "video/mp4")}
        response = other.post("/analyze", files=files)
    assert response.status_code == 422
    assert "full-body" in response.json()["detail"]


def test_unknown_youtube_filename(client):
    response = client.post("/analyze", files=practice_file(), data={"reference_video": "missing.mp4"})
    assert response.status_code == 404


@pytest.mark.parametrize("name", ["../secret.mp4", "sub/x.mp4", "..", "..\\\\x.mp4", "/etc/passwd"])
def test_rejects_paths(client, tmp_path, name):
    (tmp_path / "secret.mp4").write_bytes(VIDEO)
    response = client.post("/analyze", files=practice_file(), data={"reference_video": name})
    assert response.status_code == 400


def test_needs_exactly_one_reference(client):
    assert client.post("/analyze", files=practice_file()).status_code == 422
    both = {**practice_file(), "reference": ("ref.mp4", VIDEO, "video/mp4")}
    assert client.post("/analyze", files=both, data={"reference_video": "x.mp4"}).status_code == 422


def test_rejects_non_video(client):
    files = {**practice_file(), "reference": ("notes.txt", b"hello", "text/plain")}
    assert client.post("/analyze", files=files).status_code == 415
