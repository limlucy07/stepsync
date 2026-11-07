"""Step mastery: a step is mastered once a practice attempt scores over PASS_SCORE.

Steps unlock in order. The current step is the first one not mastered yet; every step after it is
locked until it's mastered. Mastered steps (and the current one) can always be practiced again.
"""

import re

PASS_SCORE = 80  # an overall DTW score over 80 masters a step; exactly 80 does not
MAX_TITLE_LENGTH = 80


def passed(score: float) -> bool:
    return score > PASS_SCORE


def dance_progress(steps: list[dict], attempts: list[dict]) -> dict:
    """steps: saved step rows in order (need "id"); attempts: {"step_id", "score"} rows of one user."""
    best: dict[str, int] = {}
    for attempt in attempts:
        score = attempt.get("score")
        if score is None:
            continue
        step_id = attempt["step_id"]
        best[step_id] = max(best.get(step_id, 0), round(float(score)))
    ids = [step["id"] for step in steps]
    mastered = [step_id for step_id in ids if passed(best.get(step_id, 0))]
    current = next((i for i, step_id in enumerate(ids) if step_id not in mastered), len(ids))
    return {
        "mastered_step_ids": mastered,
        "best_scores": {step_id: score for step_id, score in best.items() if step_id in ids},
        # Index of the step to practice next; equal to the step count once every step is mastered.
        "current_step": current,
        "steps_completed": current,
        "completed": current == len(ids) and bool(ids),
    }


def can_practice(progress: dict, index: int) -> bool:
    """The current step and anything before it can be practiced; later steps are locked."""
    return index <= progress["current_step"]


def clean_title(title: str) -> str:
    """Trim and collapse spaces; the name shown everywhere."""
    return re.sub(r"\s+", " ", title or "").strip()


def title_key(title: str) -> str:
    """Two names are the same dance name if they match ignoring case and extra spaces."""
    return clean_title(title).casefold()
