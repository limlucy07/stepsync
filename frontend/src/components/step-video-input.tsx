import { useRouter } from 'expo-router';
import { PrimaryButton } from '@/components/primary-button';
import type { StepVideoInputProps } from './step-video-input.types';

// Native recording uses the existing full-screen Expo camera flow.
export function StepVideoInput({ step, hasVideo }: StepVideoInputProps) {
  const router = useRouter();
  return <PrimaryButton label={hasVideo ? 'Record again' : 'Record video'} arrow={false} onPress={() => router.push({ pathname: '/record', params: { slot: 'practice', step: String(step + 1) } })} />;
}
