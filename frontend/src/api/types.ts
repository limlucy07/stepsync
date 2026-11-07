// The contract between the app and the FastAPI backend.
// Change it here first, then mirror it in the backend's response model.

export type PickedVideo = {
  uri: string;
  fileName: string;
  mimeType: string;
  durationMs: number | null;
  /** Set when the video came from a YouTube link instead of the phone. */
  youtube?: YouTubeSource;
};

export type YouTubeSource = {
  url: string;
  videoId: string;
  isShort: boolean;
  title: string;
  /** Name the backend saved it under; null in mock mode (nothing was downloaded). */
  serverFilename: string | null;
  /** Set when the video saved but Kaitlyn's pose extraction failed on it. */
  poseWarning?: string;
  /** Learnable steps the backend found in the dance. */
  steps?: DanceStep[];
};

/** One learnable step found by backend/app/segmentation.py. */
export type DanceStep = {
  /** Supabase steps.id; set on steps read from a saved dance. */
  id?: string;
  step_index: number;
  label: string;
  start_ms: number;
  end_ms: number;
  intensity: 'slow' | 'medium' | 'fast';
  /** Body parts moving more than usual in this step. */
  focus: ('arms' | 'legs' | 'head' | 'torso')[];
};

/** A dance saved in Supabase, as GET /dances lists it. */
export type DanceSummary = {
  /** Steps mastered in a row from the first one (user_dance_progress.steps_completed). */
  steps_completed?: number;
  id: string;
  title: string;
  source_url: string | null;
  /** Filename on the backend that saved it (GET /videos/{video_path}). */
  video_path: string | null;
  /** False when another teammate's backend saved it, so this backend can't play it. */
  video_available: boolean;
  duration_ms: number | null;
  status: 'processing' | 'ready' | 'failed';
  is_public: boolean;
  /** True for the signed-in user's own dances (only those can be edited). */
  mine: boolean;
  step_count: number;
  created_at: string | null;
};

/** GET /dances/{id}: a dance with its steps. */
export type DanceDetail = DanceSummary & { steps: DanceStep[]; progress: DanceProgress };

/** The signed-in user's mastery of a dance. A step is mastered with a score over 80. */
export type DanceProgress = {
  mastered_step_ids: string[];
  /** Best score per step id, for steps practiced at least once. */
  best_scores: Record<string, number>;
  /** Index of the step to practice next (first one not mastered); equals the step count when done. */
  current_step: number;
  steps_completed: number;
  completed: boolean;
};

/** POST /dances/{id}/steps/{step_id}/practice: a scored attempt at one step. */
export type StepPracticeResult = AnalysisResult & {
  stepId: string;
  stepIndex: number;
  passed: boolean;
  progress: DanceProgress;
  /** Set when the score couldn't be saved (so it doesn't count yet). */
  progress_error?: string;
};

/** Response of POST /reference-videos (Rodrigo's YouTube intake). */
export type YouTubeImportResponse = {
  status: 'uploaded' | 'processing' | 'completed' | 'failed';
  source_url: string;
  filename: string;
  size_bytes: number;
  metadata: { duration_seconds: number; width: number; height: number; fps: number };
  pose_processing: string;
  persisted: boolean;
  pose_error?: string | null;
  /** Whether the keypoints and motion features reached Supabase. */
  supabase_status: 'saved' | 'not_configured' | 'skipped' | 'failed';
  supabase_dance_id?: string | null;
  supabase_error?: string | null;
  frames_saved?: number | null;
  steps?: DanceStep[];
};

export type StepFeedback = {
  id: string;
  label: string;
  /** Seconds into the practice video. */
  start: number;
  end: number;
  /** Similarity to the reference, 0 to 100. */
  score: number;
  feedback: string;
  /** Seconds into the reference video this section covers. */
  referenceStart?: number;
  referenceEnd?: number;
};

/** POST /analyze, scored by Satwik's DTW comparison (backend/app/dtw_compare.py). */
export type AnalysisResult = {
  /** Set by the backend so a result can be looked up later. */
  sessionId?: string;
  /** 80% movement + 20% timing, 0 to 100. Over 80 passes a step. */
  overallScore: number;
  movementScore?: number;
  timingScore?: number;
  /** Practice duration divided by the reference's: above 1 means slower than the tutorial. */
  tempoRatio?: number;
  steps: StepFeedback[];
};
