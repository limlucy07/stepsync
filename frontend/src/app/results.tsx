import { Redirect, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import type { StepFeedback } from '@/api/types';
import { useSession } from '@/state/session';
import { colors, radius, scoreColor } from '@/theme';

// From Satwik's results screen: a step passes with an overall DTW score over 80 (80 itself does not).
const PASS_SCORE = 80;

export default function ResultsScreen() {
  const router = useRouter();
  const { reference, practice, result, currentStep, setCurrentStep, completedSteps, markStepCompleted, setPractice, setResult } =
    useSession();
  const player = useVideoPlayer(practice?.uri ?? null);

  if (!practice || !result) return <Redirect href="/" />;

  const tutorialSteps = reference?.youtube?.steps ?? [];
  const stepMode = currentStep !== null && currentStep < tutorialSteps.length;
  const passed = result.overallScore > PASS_SCORE;
  const isLast = stepMode && currentStep === tutorialSteps.length - 1;
  const duration = Math.max(practice.durationMs ? practice.durationMs / 1000 : 0, ...result.steps.map((s) => s.end), 1);

  function jumpTo(step: StepFeedback) {
    player.currentTime = step.start;
    player.play();
  }

  function advance() {
    if (!stepMode || !passed) return;
    markStepCompleted(currentStep);
    if (!isLast) setCurrentStep(currentStep + 1);
    backToPractice(); // the next take starts fresh
  }

  function retry() {
    backToPractice();
  }

  function backToPractice() {
    setPractice(null);
    setResult(null);
    // Results is opened from Practice, so going back returns to it instead of stacking another copy.
    if (router.canGoBack()) router.back();
    else router.replace('/practice');
  }

  return (
    <FlatList
      data={result.steps}
      keyExtractor={(step) => step.id}
      contentContainerStyle={styles.container}
      ListHeaderComponent={
        <View style={styles.header}>
          <VideoView player={player} style={styles.video} contentFit="contain" nativeControls />

          <View style={styles.overall}>
            <Text style={styles.overallLabel}>{stepMode ? `Step ${currentStep + 1} score` : 'Overall match'}</Text>
            <Text style={[styles.overallScore, { color: scoreColor(result.overallScore) }]}>{result.overallScore}</Text>
          </View>
          <View style={styles.subScores}>
            <SubScore label="Movement" value={result.movementScore} />
            <SubScore label="Timing" value={result.timingScore} />
            <SubScore
              label="Tempo"
              text={result.tempoRatio ? `${result.tempoRatio.toFixed(2)}×` : '–'}
              hint={result.tempoRatio ? (result.tempoRatio > 1.05 ? 'slower' : result.tempoRatio < 0.95 ? 'faster' : 'on pace') : ''}
            />
          </View>

          {stepMode && (
            <>
              <View style={[styles.passBox, passed ? styles.passSuccess : styles.passRetry]}>
                <Text style={styles.passTitle}>{passed ? 'Step passed!' : 'Try this step again'}</Text>
                <Text style={styles.passBody}>
                  {passed
                    ? `Your movement and timing score is over ${PASS_SCORE}.`
                    : `You need a score over ${PASS_SCORE} to unlock the next step.`}
                </Text>
              </View>
              {passed ? (
                <Pressable onPress={advance} style={({ pressed }) => [styles.nextButton, pressed && styles.pressed]}>
                  <Text style={styles.nextText}>
                    {isLast ? 'Finish this dance' : `Next step: Step ${currentStep + 2}`}
                  </Text>
                </Pressable>
              ) : (
                <Pressable onPress={retry} style={({ pressed }) => [styles.retryButton, pressed && styles.pressed]}>
                  <Text style={styles.retryText}>Record step {currentStep + 1} again</Text>
                </Pressable>
              )}
              {completedSteps.length > 0 && (
                <Text style={styles.hint}>
                  Passed so far: {completedSteps.length} of {tutorialSteps.length} steps.
                </Text>
              )}
            </>
          )}

          <Text style={styles.timelineTitle}>Mistake timeline</Text>
          <Text style={styles.hint}>
            Red and amber marks are the weaker moments in your recording. Tap one to replay it.
          </Text>
          <MistakeTimeline steps={result.steps} duration={duration} onJump={jumpTo} />
          <Text style={styles.sectionTitle}>Feedback by section</Text>
        </View>
      }
      ListFooterComponent={
        <Text style={styles.footnote}>
          Scores compare joint angles and body position with dynamic time warping. They are estimates, not a
          judge's grade.
        </Text>
      }
      renderItem={({ item }) => (
        <Pressable onPress={() => jumpTo(item)} style={({ pressed }) => [styles.step, pressed && styles.pressed]}>
          <View style={styles.stepTop}>
            <Text style={styles.stepLabel}>{item.label}</Text>
            <Text style={styles.time}>
              {formatTime(item.start)} to {formatTime(item.end)}
            </Text>
            <Text style={[styles.score, { color: scoreColor(item.score) }]}>{item.score}</Text>
          </View>
          <Text style={styles.feedback}>{item.feedback}</Text>
        </Pressable>
      )}
    />
  );
}

function SubScore({ label, value, text, hint }: { label: string; value?: number; text?: string; hint?: string }) {
  return (
    <View style={styles.subScore}>
      <Text style={[styles.subValue, value !== undefined && { color: scoreColor(value) }]}>
        {text ?? (value !== undefined ? String(value) : '–')}
      </Text>
      <Text style={styles.subLabel}>{hint ? `${label} · ${hint}` : label}</Text>
    </View>
  );
}

function MistakeTimeline({
  steps,
  duration,
  onJump,
}: {
  steps: StepFeedback[];
  duration: number;
  onJump: (step: StepFeedback) => void;
}) {
  const mistakes = steps.filter((s) => s.score <= PASS_SCORE && Number.isFinite(s.start));
  return (
    <View style={styles.timelineContainer}>
      <View style={styles.timelineBar}>
        {mistakes.map((step) => (
          <Pressable
            key={step.id}
            accessibilityLabel={`Mistake at ${formatTime(step.start)}, score ${step.score}`}
            onPress={() => onJump(step)}
            hitSlop={6}
            style={[
              styles.timelineMark,
              {
                left: `${Math.min(97, Math.max(0, (step.start / duration) * 100))}%`,
                backgroundColor: step.score < 60 ? colors.bad : colors.okay,
              },
            ]}
          />
        ))}
      </View>
      <View style={styles.timeLabels}>
        <Text style={styles.hint}>0:00</Text>
        <Text style={styles.hint}>{formatTime(duration)}</Text>
      </View>
      {mistakes.length === 0 ? (
        <Text style={styles.hint}>No weak sections found. Nice work.</Text>
      ) : (
        mistakes.map((step) => (
          <Pressable key={`${step.id}-row`} onPress={() => onJump(step)} style={styles.mistakeRow}>
            <Text style={[styles.mistakeTime, { color: step.score < 60 ? colors.bad : colors.okay }]}>
              {formatTime(step.start)}
            </Text>
            <Text style={styles.mistakeText}>
              {step.feedback.split('. ')[0].replace(/\.$/, '')} ({step.score})
            </Text>
          </Pressable>
        ))
      )}
    </View>
  );
}

function formatTime(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 12 },
  header: { gap: 14, marginBottom: 4 },
  video: { width: '100%', aspectRatio: 16 / 9, borderRadius: 14, backgroundColor: '#000' },
  overall: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  overallLabel: { color: colors.text, fontSize: 18, fontWeight: '600' },
  overallScore: { fontSize: 34, fontWeight: '700', fontVariant: ['tabular-nums'] },
  subScores: { flexDirection: 'row', gap: 10 },
  subScore: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: 10,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  subValue: { color: colors.text, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  subLabel: { color: colors.muted, fontSize: 12 },
  passBox: { borderRadius: 12, padding: 14, gap: 5, borderWidth: 1 },
  passSuccess: { backgroundColor: '#E4F2E9', borderColor: colors.good },
  passRetry: { backgroundColor: '#FBF0E6', borderColor: colors.okay },
  passTitle: { fontSize: 17, fontWeight: '700', color: colors.text },
  passBody: { color: colors.text, fontSize: 13 },
  nextButton: { backgroundColor: colors.good, borderRadius: radius.pill, padding: 16, alignItems: 'center' },
  nextText: { color: colors.onPrimary, fontWeight: '700', fontSize: 15 },
  retryButton: { backgroundColor: colors.primary, borderRadius: radius.pill, padding: 16, alignItems: 'center' },
  retryText: { color: colors.onPrimary, fontWeight: '700', fontSize: 15 },
  timelineTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginTop: 6 },
  timelineContainer: { backgroundColor: colors.surface, padding: 14, borderRadius: 14, gap: 12 },
  timelineBar: { height: 14, backgroundColor: colors.hairline, borderRadius: 7, marginTop: 8 },
  timelineMark: { position: 'absolute', width: 10, height: 26, top: -6, marginLeft: -5, borderRadius: 4 },
  timeLabels: { flexDirection: 'row', justifyContent: 'space-between' },
  mistakeRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
  },
  mistakeTime: { fontWeight: '700', width: 40, fontVariant: ['tabular-nums'] },
  mistakeText: { flex: 1, color: colors.text, fontSize: 13, lineHeight: 18 },
  sectionTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginTop: 6 },
  hint: { color: colors.muted, fontSize: 13 },
  step: {
    padding: 14,
    borderRadius: 14,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  pressed: { opacity: 0.7 },
  stepTop: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  stepLabel: { color: colors.text, fontSize: 16, fontWeight: '600' },
  time: { flex: 1, color: colors.muted, fontSize: 13, fontVariant: ['tabular-nums'] },
  score: { fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  feedback: { color: colors.text, fontSize: 15, lineHeight: 21 },
  footnote: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 8 },
});
