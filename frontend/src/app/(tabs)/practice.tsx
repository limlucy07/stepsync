import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { analyze, usingMockApi } from '@/api/client';
import type { PickedVideo } from '@/api/types';
import { formatSeconds } from '@/components/step-player';
import { VideoSlot } from '@/components/video-slot';
import { useSession } from '@/state/session';
import { colors } from '@/theme';

export default function HomeScreen() {
  const router = useRouter();
  const { reference, practice, setReference, setPractice, setResult, currentStep, setCurrentStep, completedSteps } =
    useSession();
  const tutorialSteps = reference?.youtube?.steps ?? [];
  const step = currentStep !== null ? tutorialSteps[currentStep] : undefined;
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = reference !== null && practice !== null && !loading;

  async function onAnalyze() {
    if (!reference || !practice) return;
    setLoading(true);
    setError(null);
    setProgress(null);
    try {
      setResult(
        await analyze(reference, practice, setProgress, step ? { start_ms: step.start_ms, end_ms: step.end_ms } : undefined),
      );
      router.push('/results');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.lead}>
        Add the routine you are learning and a take of you dancing it. Record one now or choose a saved video.
      </Text>

      <VideoSlot
        title="Reference video"
        hint="The choreography you want to learn"
        video={reference}
        onChoose={async () => setReference((await pickVideo()) ?? reference)}
        onRecord={canRecord ? () => router.push('/record?slot=reference') : undefined}
        onYouTube={() => router.push('/youtube?from=practice')}
      />
      {tutorialSteps.length > 0 && (
        <View style={styles.stepPicker}>
          <Text style={styles.pickerTitle}>What to score</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
            <Chip label="Whole dance" selected={currentStep === null} onPress={() => setCurrentStep(null)} />
            {tutorialSteps.map((s, i) => (
              <Chip
                key={s.step_index}
                label={`${completedSteps.includes(i) ? '✓ ' : ''}Step ${i + 1}`}
                selected={currentStep === i}
                done={completedSteps.includes(i)}
                onPress={() => setCurrentStep(i)}
              />
            ))}
          </ScrollView>
          <Text style={styles.pickerHint}>
            {step
              ? `Step ${currentStep! + 1}: ${formatSeconds(step.start_ms)} to ${formatSeconds(step.end_ms)} of the tutorial. ` +
                'Record just this step for a fair score. Over 80 unlocks the next step.'
              : 'Your whole recording is compared with the whole tutorial.'}
          </Text>
        </View>
      )}

      <VideoSlot
        title="Practice video"
        hint="Your attempt"
        video={practice}
        onChoose={async () => setPractice((await pickVideo()) ?? practice)}
        onRecord={canRecord ? () => router.push('/record?slot=practice') : undefined}
      />

      <Pressable
        onPress={onAnalyze}
        disabled={!ready}
        style={({ pressed }) => [styles.button, !ready && styles.disabled, pressed && styles.pressed]}
      >
        {loading ? (
          <View style={styles.loadingRow}>
            <ActivityIndicator color={colors.onPrimary} />
            {progress !== null && (
              <Text style={styles.buttonText}>
                {progress < 1 ? `Uploading ${Math.round(progress * 100)}%` : 'Analyzing…'}
              </Text>
            )}
          </View>
        ) : (
          <Text style={styles.buttonText}>{step ? `Score step ${currentStep! + 1}` : 'Analyze'}</Text>
        )}
      </Pressable>

      {error && <Text style={styles.error}>{error}</Text>}
      {usingMockApi && (
        <Text style={styles.note}>Mock mode: feedback is sample data, nothing is uploaded.</Text>
      )}
    </ScrollView>
  );
}

function Chip({ label, selected, done, onPress }: { label: string; selected: boolean; done?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={[styles.chip, done && styles.chipDone, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipText, done && styles.chipDoneText, selected && styles.chipSelectedText]}>{label}</Text>
    </Pressable>
  );
}

// expo-camera can only record in the native app, not the browser.
const canRecord = Platform.OS !== 'web';

async function pickVideo(): Promise<PickedVideo | null> {
  const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'] });
  if (picked.canceled) return null;

  const asset = picked.assets[0];
  return {
    uri: asset.uri,
    fileName: asset.fileName ?? asset.uri.split('/').pop() ?? 'video.mp4',
    mimeType: asset.mimeType ?? 'video/mp4',
    durationMs: asset.duration ?? null,
  };
}

const styles = StyleSheet.create({
  container: { padding: 20, paddingBottom: 120, gap: 16 },
  lead: { color: colors.muted, fontSize: 16, lineHeight: 22, marginBottom: 4 },
  button: {
    height: 52,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    marginTop: 8,
  },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.8 },
  loadingRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  buttonText: { color: colors.onPrimary, fontSize: 17, fontWeight: '600' },
  error: { color: colors.bad, fontSize: 14 },
  note: { color: colors.muted, fontSize: 13, textAlign: 'center' },
  stepPicker: { gap: 8 },
  pickerTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  pickerHint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  chips: { gap: 8, paddingVertical: 2 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipDone: { borderColor: colors.good },
  chipText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  chipSelectedText: { color: colors.onPrimary },
  chipDoneText: { color: colors.good },
});
