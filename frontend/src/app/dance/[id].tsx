import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { getDance, savedVideoUrl } from '@/api/client';
import type { DanceDetail, DanceStep } from '@/api/types';
import { PrimaryButton } from '@/components/primary-button';
import { StepPlayer } from '@/components/step-player';
import { danceThumbnail, danceToVideo, formatClock } from '@/lib/dance';
import { useSession } from '@/state/session';
import { colors, radius } from '@/theme';

/** A dance saved in Supabase: its video, its steps, and (for your own dances) the step editor. */
export default function DanceScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { setReference } = useSession();
  const [dance, setDance] = useState<DanceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setDance(await getDance(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load this dance.');
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  function practice() {
    if (!dance) return;
    setReference(danceToVideo(dance));
    router.navigate('/practice');
  }

  const onStepsSaved = (steps: DanceStep[]) =>
    setDance((current) => (current ? { ...current, steps, step_count: steps.length } : current));

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 32 }]}
    >
      <Pressable onPress={back} accessibilityLabel="Back" style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
        <Ionicons name="arrow-back" size={20} color={colors.text} />
      </Pressable>

      {error ? (
        <View style={styles.center}>
          <Text style={styles.error}>{error}</Text>
          <PrimaryButton label="Try again" onPress={load} arrow={false} />
        </View>
      ) : !dance ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <>
          <Text style={styles.kicker}>{dance.mine ? 'YOUR DANCE' : 'SHARED DANCE'}</Text>
          <Text accessibilityRole="header" style={styles.title} numberOfLines={3}>
            {dance.title}
          </Text>

          <View style={styles.stats}>
            <Stat label="Length" value={formatClock(dance.duration_ms)} />
            <Stat label="Steps" value={String(dance.steps.length)} />
            <Stat label="Visibility" value={dance.is_public ? 'Public' : 'Private'} />
          </View>

          {!dance.video_available && (
            <Text style={styles.note}>
              This video was uploaded through another teammate's backend, so it can't play here. The steps are
              still shown.
            </Text>
          )}

          <StepPlayer
            source={dance.video_available && dance.video_path ? savedVideoUrl(dance.video_path) : null}
            thumbnail={danceThumbnail(dance) ?? ''}
            steps={dance.steps}
            durationMs={dance.duration_ms}
            danceId={dance.mine ? dance.id : null}
            onStepsSaved={onStepsSaved}
          />

          <PrimaryButton label="Practice this dance" onPress={practice} />
        </>
      )}
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 18, gap: 14 },
  back: {
    width: 40,
    height: 40,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pressed: { opacity: 0.75 },
  center: { paddingVertical: 60, alignItems: 'center', gap: 16 },
  error: { color: colors.bad, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  kicker: { color: colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.5, marginTop: 4 },
  title: { color: colors.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.5 },
  stats: { flexDirection: 'row', gap: 10 },
  stat: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: 12,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  statValue: { color: colors.text, fontSize: 18, fontWeight: '700' },
  statLabel: { color: colors.muted, fontSize: 12 },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19 },
});
