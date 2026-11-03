import type { PickedVideo } from '@/api/types';

export type StepVideoInputProps = {
  step: number;
  hasVideo: boolean;
  previewHeight?: number;
  onRecorded: (video: PickedVideo) => void;
  onActiveChange: (active: boolean) => void;
};
