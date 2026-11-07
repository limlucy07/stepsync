import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getDance, practiceStep, savedVideoUrl } from '@/api/client';
import type { DanceDetail, StepPracticeResult } from '@/api/types';
import { PrimaryButton } from '@/components/primary-button';
import { StepClip } from '@/components/step-clip';
import { StepVideoInput } from '@/components/step-video-input';
import { grapevineCounts, lessonStepIndex } from '@/data/lesson';
import { danceThumbnail, formatClock, stepFocus, stepPace, stepStatus } from '@/lib/dance';
import { recordingKey, useSession } from '@/state/session';
import { colors, lessonColors as palette, radius, scoreColor } from '@/theme';

/**
 * Practice one step: the step's clip on top, your recording below.
 * With ?danceId&stepId (a saved dance) the recording is scored; over 80 masters the step and unlocks the next.
 * Without them it's Kaitlyn's sample Grapevine lesson (no scoring).
 */
export default function StepRecordingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const previewHeight = Math.max(180, Math.min(332, (height - insets.top - insets.bottom - 300) / 2));
  const params = useLocalSearchParams<{ step?: string; danceId?: string; stepId?: string }>();
  const danceId = params.danceId || null;
  const { stepRecordings, setStepRecording } = useSession();
  const [cameraActive, setCameraActive] = useState(false);

  // A saved dance: load its steps and the user's progress.
  const [dance, setDance] = useState<DanceDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scoring, setScoring] = useState(false);
  const [uploaded, setUploaded] = useState(0);
  const [result, setResult] = useState<StepPracticeResult | null>(null);
  const [scoreError, setScoreError] = useState<string | null>(null);

  useEffect(() => {
    if (!danceId) return;
    getDance(danceId).then(setDance, (e) => setLoadError(e instanceof Error ? e.message : 'Could not load this dance.'));
  }, [danceId]);

  const realIndex = dance ? dance.steps.findIndex((s) => s.id === params.stepId) : -1;
  const step = danceId ? Math.max(0, realIndex) : lessonStepIndex(params.step);
  const key = recordingKey(danceId, step);
  const video = stepRecordings[key];

  const returnToStep = () => {
    if (router.canGoBack()) router.back();
    else if (danceId) router.replace({ pathname: '/dance/[id]', params: { id: danceId } });
    else router.replace({ pathname: '/steps', params: { step: String(step + 1) } });
  };

  async function score() {
    if (!dance || !video || !params.stepId || scoring) return;
    setScoring(true);
    setScoreError(null);
    setUploaded(0);
    try {
      setResult(await practiceStep(dance.id, params.stepId, video, setUploaded));
    } catch (e) {
      setScoreError(e instanceof Error ? e.message : 'Scoring failed.');
    } finally {
      setScoring(false);
    }
  }

  function recordAgain() {
    setResult(null);
    setScoreError(null);
    setStepRecording(key, null);
  }

  // --- header text and the clip --------------------------------------------------
  let kicker: string;
  let detail: string;
  let clip: React.ReactNode;
  let clipInfo: { source: string | null; startMs: number; endMs: number } | undefined;
  if (danceId) {
    if (!dance || realIndex < 0) {
      return (
        <View style={[styles.fill, styles.center]}>
          <Text style={styles.description}>
            {loadError ?? (dance ? "That step isn't part of this dance anymore." : 'Loading…')}
          </Text>
          {(loadError || dance) && <PrimaryButton label="Back to steps" onPress={returnToStep} arrow={false} />}
        </View>
      );
    }
    const s = dance.steps[realIndex];
    const source = dance.video_available && dance.video_path ? savedVideoUrl(dance.video_path) : null;
    kicker = `${dance.title.toUpperCase()} · STEP ${realIndex + 1} OF ${dance.steps.length}`;
    detail = `${stepPace(s)} · ${stepFocus(s)} · ${formatClock(s.start_ms)} to ${formatClock(s.end_ms)} of the dance`;
    clipInfo = { source, startMs: s.start_ms, endMs: s.end_ms };
    clip = (
      <StepClip
        testID="step-clip"
        source={source}
        thumbnail={danceThumbnail(dance)}
        startMs={s.start_ms}
        endMs={s.end_ms}
        style={[styles.reference, { height: previewHeight }]}
      />
    );
  } else {
    const count = grapevineCounts[step];
    kicker = `THE GRAPEVINE · STEP ${step + 1} OF ${grapevineCounts.length}`;
    detail = `${count.action.replace('\n', ' ')} · ${count.foot}`;
    clip = (
      <View testID="step-clip-placeholder" accessibilityLabel="Step clip placeholder" style={[styles.reference, { height: previewHeight }]}>
        <Text style={styles.placeholderLabel}>Step clip coming soon</Text>
      </View>
    );
  }

  const locked = dance && realIndex >= 0 && stepStatus(dance, realIndex) === 'locked';
  const total = dance?.steps.length ?? 0;
  const isLast = realIndex === total - 1;

  return (
    <ScrollView style={styles.fill} contentContainerStyle={[styles.container, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.content}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to step" onPress={returnToStep} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
          <Ionicons name="arrow-back" size={20} color={palette.text} />
        </Pressable>
        <Text style={styles.kicker}>{kicker}</Text>
        <Text accessibilityRole="header" style={styles.title}>Practice your step</Text>
        <Text style={styles.action}>{detail}</Text>

        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.panelLabel}>Step clip</Text>
          {clip}
        </View>

        {locked ? (
          <Text style={styles.warning}>
            This step is locked. Master step {dance!.progress.current_step + 1} first (score over 80).
          </Text>
        ) : result ? (
          <ResultCard
            result={result}
            isLast={isLast}
            onNext={returnToStep}
            onAgain={recordAgain}
          />
        ) : (
          <View testID="user-recording-panel" style={styles.section}>
            <Text accessibilityRole="header" style={styles.panelLabel}>Your recording</Text>
            {!cameraActive && (video ? (
              <View style={styles.saved}>
                <VideoPreview key={video.uri} uri={video.uri} height={previewHeight} />
                <Text style={styles.description}>
                  {danceId ? 'Happy with this take? Score it to see if you mastered the step.' : 'Your recording is ready to review. Scoring is coming soon.'}
                </Text>
              </View>
            ) : (
              <View style={[styles.preview, { minHeight: previewHeight }]}>
                <View style={styles.cameraIcon}><Ionicons name="videocam-outline" size={42} color={palette.accent} /></View>
                <Text style={styles.previewTitle}>Record yourself dancing</Text>
                <Text style={styles.description}>
                  Set up your camera so your whole body is visible, then record yourself doing just this step.
                </Text>
              </View>
            ))}

            {danceId && video && !cameraActive && (
              <PrimaryButton
                label={scoring ? (uploaded < 1 ? `Uploading ${Math.round(uploaded * 100)}%` : 'Scoring…') : 'Score my step'}
                onPress={score}
                loading={scoring}
                arrow={false}
                style={styles.scoreButton}
              />
            )}
            {scoreError && <Text style={styles.warning}>{scoreError}</Text>}
            {!scoring && (
              <StepVideoInput
                step={step}
                recordingKey={key}
                clip={clipInfo}
                hasVideo={Boolean(video)}
                previewHeight={previewHeight}
                onRecorded={(recorded) => setStepRecording(key, recorded)}
                onActiveChange={setCameraActive}
              />
            )}
          </View>
        )}

        {!result && <PrimaryButton label="Back to step" onPress={returnToStep} arrow={false} style={styles.button} />}
      </View>
    </ScrollView>
  );
}

function ResultCard({
  result,
  isLast,
  onNext,
  onAgain,
}: {
  result: StepPracticeResult;
  isLast: boolean;
  onNext: () => void;
  onAgain: () => void;
}) {
  const weak = result.steps.filter((s) => s.score <= 80).slice(0, 3);
  const unlocked = result.passed && !result.progress_error;
  return (
    <View testID="step-result" style={styles.section}>
      <View style={styles.scoreRow}>
        <Text style={styles.panelLabel}>Your score</Text>
        <Text style={[styles.bigScore, { color: scoreColor(result.overallScore) }]}>{result.overallScore}</Text>
      </View>
      <View style={styles.subScores}>
        <SubScore label="Movement" value={result.movementScore} />
        <SubScore label="Timing" value={result.timingScore} />
      </View>
      <View style={[styles.passBox, result.passed ? styles.passSuccess : styles.passRetry]}>
        <Text style={styles.passTitle}>{result.passed ? 'Step mastered!' : 'Not mastered yet'}</Text>
        <Text style={styles.passBody}>
          {result.passed
            ? isLast
              ? 'That was the last step. You have mastered the whole dance.'
              : `Step ${result.stepIndex + 2} is unlocked.`
            : 'You need a score over 80 to master this step and unlock the next one.'}
        </Text>
      </View>
      {result.progress_error && <Text style={styles.warning}>{result.progress_error}</Text>}
      {weak.length > 0 && (
        <View style={styles.weak}>
          <Text style={styles.panelLabel}>Work on</Text>
          {weak.map((s) => (
            <Text key={s.id} style={styles.weakText}>
              {formatClock(s.start * 1000)} · {s.feedback.split('. ')[0].replace(/\.$/, '')} ({s.score})
            </Text>
          ))}
        </View>
      )}
      {unlocked ? (
        <PrimaryButton label={isLast ? 'Back to steps' : `Go to step ${result.stepIndex + 2}`} onPress={onNext} />
      ) : (
        <PrimaryButton label="Record again" onPress={onAgain} arrow={false} style={styles.button} />
      )}
      <Pressable onPress={unlocked ? onAgain : onNext} hitSlop={8} style={styles.linkWrap}>
        <Text style={styles.link}>{unlocked ? 'Practice this step again' : 'Back to steps'}</Text>
      </Pressable>
    </View>
  );
}

function SubScore({ label, value }: { label: string; value?: number }) {
  return (
    <View style={styles.subScore}>
      <Text style={[styles.subValue, value !== undefined && { color: scoreColor(value) }]}>{value ?? '–'}</Text>
      <Text style={styles.subLabel}>{label}</Text>
    </View>
  );
}

function VideoPreview({ uri, height }: { uri: string; height: number }) {
  const player = useVideoPlayer(uri);
  return <VideoView player={player} nativeControls contentFit="contain" style={[styles.video, { height }]} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: palette.background },
  center: { alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  container: { flexGrow: 1, alignItems: 'center', paddingHorizontal: 20 },
  content: { width: '100%', maxWidth: 350, gap: 16 },
  back: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: radius.pill, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface },
  kicker: { fontSize: 10, fontWeight: '700', letterSpacing: 1.2, color: palette.accent },
  title: { fontSize: 26, lineHeight: 30, letterSpacing: -0.8, color: palette.text },
  action: { fontSize: 13, color: palette.secondary },
  section: { gap: 12 },
  panelLabel: { fontSize: 13, fontWeight: '600', color: palette.secondary },
  reference: { width: '100%', borderRadius: 24, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  placeholderLabel: { color: '#AAA', fontSize: 13 },
  preview: { borderRadius: 24, borderWidth: 1, borderStyle: 'dashed', borderColor: palette.border, backgroundColor: palette.surface, padding: 18, alignItems: 'center', justifyContent: 'center', gap: 12 },
  cameraIcon: { width: 56, height: 56, borderRadius: radius.pill, backgroundColor: palette.selected, alignItems: 'center', justifyContent: 'center' },
  previewTitle: { fontSize: 18, fontWeight: '600', textAlign: 'center', color: palette.text },
  description: { fontSize: 14, lineHeight: 21, textAlign: 'center', color: palette.muted },
  saved: { gap: 12 },
  video: { width: '100%', height: 332, borderRadius: 24, backgroundColor: '#000' },
  button: { backgroundColor: palette.text, borderRadius: radius.pill },
  scoreButton: { backgroundColor: palette.accent, borderRadius: radius.pill },
  warning: { color: colors.bad, fontSize: 13, lineHeight: 19, textAlign: 'center' },
  scoreRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  bigScore: { fontSize: 40, fontWeight: '700', fontVariant: ['tabular-nums'] },
  subScores: { flexDirection: 'row', gap: 10 },
  subScore: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 10, borderRadius: 16, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface },
  subValue: { color: palette.text, fontSize: 18, fontWeight: '700', fontVariant: ['tabular-nums'] },
  subLabel: { color: palette.muted, fontSize: 12 },
  passBox: { borderRadius: 16, padding: 14, gap: 5, borderWidth: 1 },
  passSuccess: { backgroundColor: '#E4F2E9', borderColor: colors.good },
  passRetry: { backgroundColor: palette.surface, borderColor: palette.accent },
  passTitle: { fontSize: 17, fontWeight: '700', color: palette.text },
  passBody: { color: palette.text, fontSize: 13, lineHeight: 18 },
  weak: { gap: 6, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface },
  weakText: { color: palette.text, fontSize: 13, lineHeight: 18 },
  linkWrap: { alignSelf: 'center' },
  link: { color: palette.accent, fontSize: 13, fontWeight: '600' },
  pressed: { opacity: 0.75 },
});
