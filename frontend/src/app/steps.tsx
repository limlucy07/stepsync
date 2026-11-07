import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Image } from 'react-native';

import { sceneMediaStyle, StepScene } from '@/components/step-scene';
import { grapevineCounts as counts, lessonStepIndex } from '@/data/lesson';

/** The sample Grapevine lesson (still image, fixed counts). Real dances use /dance/[id]. */
export default function StepsScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ step?: string }>();
  const [step, setStep] = useState(() => lessonStepIndex(params.step));
  const leave = () => router.canGoBack() ? router.back() : router.replace('/');

  return (
    <StepScene
      testID="grapevine-lesson"
      lessonLabel="LESSON 2 OF 6"
      progress={45 / 136}
      level="SIDE-TRAVELING STEP · BEGINNER"
      title="The Grapevine"
      cue="Step, cross behind, step, tap."
      media={<Image testID="grapevine-demo-image" source={require('../../assets/steps/grapevine.png')} accessibilityLabel="Grapevine demonstration: dancer crossing one foot behind the other in a studio" style={sceneMediaStyle} resizeMode="cover" />}
      badge="DEMO · 0:08"
      travel={{ text: 'Travel to your left' }}
      sectionTitle="Four-count footwork"
      sectionMeta="92 BPM"
      tiles={counts.map((count, index) => ({
        action: count.action,
        foot: count.foot,
        state: index < step ? 'done' : index === step ? 'active' : 'upcoming',
        accessibilityLabel: `Count ${index + 1}: ${count.action.replace('\n', ' ')}, ${count.foot}${index === step ? ', current step' : ''}`,
      }))}
      tip={{ label: 'COACHING TIP', text: 'Keep your hips forward as the right foot crosses behind.' }}
      onBack={leave}
      onPrevious={() => step === 0 ? leave() : setStep(step - 1)}
      onPractice={() => router.push({ pathname: '/step-recording', params: { step: String(step + 1) } })}
    />
  );
}
