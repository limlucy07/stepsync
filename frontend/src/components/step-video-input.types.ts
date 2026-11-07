import type { PickedVideo } from '@/api/types';

export type StepVideoInputProps = {
  step: number;
  /** Where the recording is kept in the session (see recordingKey). */
  recordingKey: string;
  /** The step's part of the tutorial, shown above the camera while recording in the app. */
  clip?: { source: string | null; startMs: number; endMs: number };
  hasVideo: boolean;
  previewHeight?: number;
  onRecorded: (video: PickedVideo) => void;
  onActiveChange: (active: boolean) => void;
};
