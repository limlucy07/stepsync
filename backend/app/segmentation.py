"""Split a dance into steps where the dancer's pose changes most.

The algorithm (segment_dance) compares the pose shortly before and shortly after each frame
and cuts at strong peaks of that change:
  1. standardize every feature column (same as sklearn's StandardScaler)
  2. smooth over time with a Gaussian (sigma = 2 frames)
  3. score each frame by how far the pose 0.2 s ahead is from the pose 0.2 s behind
  4. cut at peaks above mean + 0.75 * std, at least MIN_STEP_SECONDS apart

Features per frame (pose_feature_matrix): hip-relative x/y/z of the 33 landmarks
(independent of camera distance and of walking across frame) plus the 8 joint angles.
Frames before the dancer appears and after they leave are trimmed off.
"""

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.signal import find_peaks

from .supabase_store import JOINT_ANGLES

MIN_STEP_SECONDS = 0.4

LANDMARKS = [
    "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner", "right_eye",
    "right_eye_outer", "left_ear", "right_ear", "mouth_left", "mouth_right", "left_shoulder",
    "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_pinky",
    "right_pinky", "left_index", "right_index", "left_thumb", "right_thumb", "left_hip",
    "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle", "left_heel",
    "right_heel", "left_foot_index", "right_foot_index",
]


def segment_dance(features: np.ndarray, fps: float, min_step_seconds: float = MIN_STEP_SECONDS):
    """Return (step boundaries in seconds, change score per frame) for a frames x features array."""
    # 1. Normalize features (StandardScaler: zero mean, unit variance; constant columns stay 0)
    std = features.std(axis=0)
    X = (features - features.mean(axis=0)) / np.where(std > 0, std, 1.0)

    # 2. Smooth noisy frame-to-frame variations
    X = gaussian_filter1d(X, sigma=2, axis=0)

    # 3. Compare poses before and after each frame
    window = max(2, int(0.2 * fps))
    before = np.roll(X, window, axis=0)
    after = np.roll(X, -window, axis=0)
    score = np.linalg.norm(after - before, axis=1)

    # Ignore edges affected by array wrapping
    score[:window] = 0
    score[-window:] = 0

    # 4. Find significant local peaks
    min_distance = max(1, int(min_step_seconds * fps))
    threshold = np.mean(score) + 0.75 * np.std(score)
    peaks, _ = find_peaks(
        score,
        height=threshold,
        distance=min_distance,
        prominence=0.25 * np.std(score),
    )

    # Return boundaries in seconds
    return peaks / fps, score


def pose_feature_matrix(frames: list[dict]) -> np.ndarray:
    """frames x 107 array: hip-relative x/y/z of 33 landmarks + 8 joint angles.

    Unreliable or missing values are filled by linear interpolation over time
    (the algorithm's scaler can't take gaps); a column with no values at all becomes 0.
    """
    rows = []
    for frame in frames:
        row = []
        for name in LANDMARKS:
            keypoint = frame.get("keypoints", {}).get(name) or {}
            reliable = keypoint.get("reliable")
            for axis in ("hx", "hy", "hz"):
                value = keypoint.get(axis)
                row.append(value if reliable and value is not None else np.nan)
        for joint in JOINT_ANGLES:
            value = frame.get("joint_angles", {}).get(joint)
            row.append(value if value is not None else np.nan)
        rows.append(row)
    X = np.array(rows, dtype=float)
    index = np.arange(len(X))
    for column in range(X.shape[1]):
        known = ~np.isnan(X[:, column])
        if known.any():
            X[:, column] = np.interp(index, index[known], X[known, column])
        else:
            X[:, column] = 0.0
    return X


BODY_PARTS = {
    "arms": ("elbow", "wrist", "pinky", "index", "thumb"),
    "legs": ("knee", "ankle", "heel", "foot_index"),
    "head": ("nose", "eye", "ear", "mouth"),
    "torso": ("shoulder", "hip"),
}


def _part(landmark_name: str) -> str | None:
    for part, words in BODY_PARTS.items():
        if any(word in landmark_name for word in words):
            return part
    return None


def segment_steps(frames: list[dict]) -> list[dict]:
    """Return steps as dicts: step_index, start/end frame and ms, motion stats, intensity, focus."""
    with_pose = [i for i, f in enumerate(frames) if f.get("pose_present")]
    if len(with_pose) < 2:
        return []
    first, last = with_pose[0], with_pose[-1]
    span = frames[first: last + 1]
    times = [f["timestamp_ms"] for f in span]
    duration_ms = times[-1] - times[0]
    if duration_ms <= 0:
        return []

    fps = (len(span) - 1) / (duration_ms / 1000)
    boundaries, _score = segment_dance(pose_feature_matrix(span), fps)
    # segment_dance returns seconds (peak index / fps); turn them back into frame positions.
    peaks = sorted({int(round(b * fps)) for b in boundaries} - {0, len(span) - 1})
    cuts = [0, *[p for p in peaks if 0 < p < len(span) - 1], len(span) - 1]

    return _build_steps(span, cuts)


def steps_from_ranges(frames: list[dict], ranges_ms: list[tuple[int, int]]) -> list[dict]:
    """Rebuild steps from boundaries a person edited in the app, with fresh pace and focus labels.

    ranges_ms are back-to-back (start_ms, end_ms) pairs; each edge snaps to the nearest frame.
    """
    if not frames or not ranges_ms:
        return []
    times = [f["timestamp_ms"] for f in frames]

    def nearest(ms: int) -> int:
        return min(range(len(frames)), key=lambda i: abs(times[i] - ms))

    cuts = [nearest(ranges_ms[0][0])] + [nearest(end) for _, end in ranges_ms]
    for a, b in zip(cuts, cuts[1:]):
        if b <= a:
            raise ValueError("Steps are too close together; each step needs at least one frame.")
    first, last = cuts[0], cuts[-1]
    span = frames[first: last + 1]
    return _build_steps(span, [c - first for c in cuts])


def _build_steps(span: list[dict], cuts: list[int]) -> list[dict]:
    """Turn cut positions within span into step dicts with pace and body-part labels."""
    times = [f["timestamp_ms"] for f in span]
    energies = [f["motion_energy"] for f in span if f.get("motion_energy") is not None]
    overall = (sum(energies) / len(energies)) if energies else 0.0
    baseline = _part_speeds(span)
    steps = []
    for index, (a, b) in enumerate(zip(cuts, cuts[1:])):
        segment = span[a: b + 1]
        values = [f["motion_energy"] for f in segment if f.get("motion_energy") is not None]
        avg = sum(values) / len(values) if values else 0.0
        ratio = avg / overall if overall else 1.0
        steps.append({
            "step_index": index,
            "label": f"Step {index + 1}",
            "start_frame": span[a]["frame_index"],
            "end_frame": span[b]["frame_index"],
            "start_ms": times[a],
            "end_ms": times[b],
            "avg_motion_energy": round(avg, 4),
            "peak_motion_energy": round(max(values), 4) if values else 0.0,
            "intensity": "slow" if ratio < 0.75 else "fast" if ratio > 1.25 else "medium",
            "focus": _focus(segment, baseline),
        })
    return steps


def _part_speeds(frames: list[dict]) -> dict[str, float]:
    speeds: dict[str, list[float]] = {}
    for frame in frames:
        for name, keypoint in frame.get("keypoints", {}).items():
            part = _part(name)
            if part and keypoint.get("speed") is not None:
                speeds.setdefault(part, []).append(keypoint["speed"])
    return {part: float(np.mean(v)) for part, v in speeds.items() if v}


def _focus(segment: list[dict], baseline: dict[str, float]) -> list[str]:
    """Body parts moving more than they usually do in this dance, most active first (at most two).

    Compared with the whole dance rather than in absolute terms, because hands always move fastest.
    """
    means = _part_speeds(segment)
    ratios = {p: m / baseline[p] for p, m in means.items() if baseline.get(p)}
    if not ratios:
        return []
    above = sorted((p for p, r in ratios.items() if r >= 1.1), key=lambda p: -ratios[p])
    return above[:2] or [max(ratios, key=ratios.get)]
