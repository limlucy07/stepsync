import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { getDance, savedVideoUrl } from '@/api/client';
import type { DanceDetail } from '@/api/types';
import { PrimaryButton } from '@/components/primary-button';
import { StepClip } from '@/components/step-clip';
import { sceneMediaStyle, StepScene, type SceneTile } from '@/components/step-scene';
import { danceThumbnail, formatClock, formatStepLength, stepFocus, stepPace, stepStatus } from '@/lib/dance';
import { lessonColors as palette } from '@/theme';

/**
 * The step scene for a saved dance (Kaitlyn's design). Steps unlock in order: a step is mastered with a
 * practice score over 80, which unlocks the next one. Practice Now practices the selected step, which
 * starts on the current step (the first one not mastered); tap a mastered step to practice it again.
 */
export default function DanceStepsScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [dance, setDance] = useState<DanceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const lastCurrent = useRef<number | null>(null);

  // Reload whenever the screen comes back into view, so a step mastered in practice shows up.
  const load = useCallback(async () => {
    try {
      const next = await getDance(id);
      setError(null);
      setNotice(null);
      setDance(next);
      const last = Math.max(0, next.steps.length - 1);
      const current = Math.min(next.progress.current_step, last);
      const previous = lastCurrent.current; // read now: the updater below runs later
      lastCurrent.current = next.progress.current_step;
      setSelected((sel) => {
        // First load: start on the current step. After mastering the selected step, move on to the new one.
        if (previous === null) return current;
        if (next.progress.current_step > previous && sel === previous) return current;
        return Math.min(sel, last);
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this dance.');
    }
  }, [id]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const leave = () => (router.canGoBack() ? router.back() : router.replace('/'));

  if (!dance) {
    return (
      <View style={styles.center}>
        {error ? (
          <>
            <Text style={styles.error}>{error}</Text>
            <PrimaryButton label="Try again" onPress={load} arrow={false} />
            <Pressable onPress={leave}><Text style={styles.link}>Back</Text></Pressable>
          </>
        ) : (
          <ActivityIndicator color={palette.accent} />
        )}
      </View>
    );
  }

  const total = dance.steps.length;
  if (total === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>This dance has no steps yet. Upload it again to split it into steps.</Text>
        <Pressable onPress={leave}><Text style={styles.link}>Back</Text></Pressable>
      </View>
    );
  }

  const { progress } = dance;
  const step = dance.steps[selected];
  const status = stepStatus(dance, selected);
  const best = step.id ? progress.best_scores[step.id] : undefined;
  const mastered = progress.mastered_step_ids.length;

  function select(index: number) {
    if (!dance) return;
    if (stepStatus(dance, index) === 'locked') {
      setNotice(`Step ${index + 1} is locked. Master step ${progress.current_step + 1} first (score over 80).`);
      return;
    }
    setNotice(null);
    setSelected(index);
  }

  const tiles: SceneTile[] = dance.steps.map((s, index) => {
    const state = stepStatus(dance, index);
    return {
      action: stepPace(s).toUpperCase(),
      foot: state === 'locked' ? 'Locked' : stepFocus(s),
      state: index === selected ? 'active' : state === 'mastered' ? 'done' : state === 'current' ? 'current' : 'upcoming',
      locked: state === 'locked',
      accessibilityLabel: `Step ${index + 1}: ${stepPace(s)}, ${stepFocus(s)}, ${
        state === 'mastered' ? 'mastered' : state === 'current' ? 'current step' : 'locked'
      }${index === selected ? ', selected' : ''}`,
    };
  });

  const nextStep = selected + 2 <= total ? `step ${selected + 2}` : 'the end of the dance';
  const tipText = progress.completed && status === 'mastered'
    ? `You've mastered every step${best !== undefined ? `. Best on this one: ${best}` : ''}. Pick any step to practice it again.`
    : status === 'mastered'
      ? `Mastered${best !== undefined ? ` with ${best}` : ''}. Tap Practice Now to practice it again.`
      : best !== undefined
        ? `Best so far: ${best}. Score over 80 to master this step and unlock ${nextStep}.`
        : `Score over 80 to master this step and unlock ${nextStep}. Record just this step.`;

  return (
    <StepScene
      testID="dance-steps"
      lessonLabel={`STEP ${selected + 1} OF ${total}`}
      progress={progress.steps_completed / total}
      level={`${dance.mine ? 'YOUR DANCE' : 'SHARED DANCE'} · ${mastered} OF ${total} MASTERED`}
      title={dance.title}
      cue={`Step ${selected + 1}: ${formatClock(step.start_ms)} to ${formatClock(step.end_ms)} · ${stepPace(step)} · ${stepFocus(step)}`}
      media={
        <StepClip
          source={dance.video_available && dance.video_path ? savedVideoUrl(dance.video_path) : null}
          thumbnail={danceThumbnail(dance)}
          startMs={step.start_ms}
          endMs={step.end_ms}
          style={sceneMediaStyle}
        />
      }
      badge={`STEP ${selected + 1} · ${formatStepLength(step)}`}
      showAudio={dance.video_available}
      travel={
        status === 'mastered'
          ? { text: best !== undefined ? `Mastered · best ${best}` : 'Mastered', icon: 'check' }
          : { text: best !== undefined ? `Current step · best ${best}` : 'Current step', icon: 'target' }
      }
      sectionTitle="Steps"
      sectionMeta={`${mastered}/${total} mastered`}
      tiles={tiles}
      onTilePress={select}
      tip={{ label: status === 'mastered' ? 'MASTERED' : 'TO UNLOCK THE NEXT STEP', text: tipText }}
      extra={
        <View style={styles.extra}>
          {notice && <Text style={styles.notice}>{notice}</Text>}
          {!dance.video_available && (
            <Text style={styles.notice}>
              This video was uploaded through another teammate's backend, so it can't play or be scored here.
            </Text>
          )}
          {dance.mine && dance.video_available && (
            <Pressable onPress={() => router.push({ pathname: '/dance/[id]/edit', params: { id: dance.id } })} hitSlop={8}>
              <Text style={styles.link}>Edit steps</Text>
            </Pressable>
          )}
        </View>
      }
      onBack={leave}
      onPrevious={() => (selected === 0 ? leave() : select(selected - 1))}
      practiceDisabled={!dance.video_available || !step.id}
      onPractice={() =>
        router.push({
          pathname: '/step-recording',
          params: { danceId: dance.id, stepId: step.id ?? '', step: String(selected + 1) },
        })
      }
    />
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, backgroundColor: palette.background },
  error: { color: palette.text, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  extra: { gap: 8, alignItems: 'center' },
  notice: { color: palette.secondary, fontSize: 12, lineHeight: 17, textAlign: 'center' },
  link: { color: palette.accent, fontSize: 13, fontWeight: '600' },
});
