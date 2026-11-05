import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { listDances, usingMockApi } from '@/api/client';
import type { DanceSummary } from '@/api/types';
import { ProgressRing } from '@/components/progress-ring';
import { continueWatching, progress, routines } from '@/data/home';
import { danceThumbnail, formatClock } from '@/lib/dance';
import { colors, radius } from '@/theme';

// Kaitlyn's step lesson, still on sample data; kept on the home screen so it stays reachable.
const sampleLesson = routines.find((r) => r.id === 'perfect-night') ?? routines[0];

/** Dances from Supabase (through the backend), reloaded whenever the home screen comes back into view. */
function useDances() {
  const [dances, setDances] = useState<DanceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (usingMockApi) return;
    setLoading(true);
    try {
      setDances(await listDances());
      setError(null);
    } catch (e) {
      // Keep showing the last list if a refresh fails.
      setError(e instanceof Error ? e.message : 'Could not load your dances.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );
  return { dances, error, loading, reload: load };
}

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { dances, error, loading, reload } = useDances();
  const latest = dances?.find((d) => d.mine) ?? dances?.[0] ?? null;
  const fraction = progress.movesCompleted / progress.movesTotal;
  const goPractice = () => router.push('/practice');
  const goUpload = () => router.push('/youtube?from=home');
  const openDance = (id: string) => router.push({ pathname: '/dance/[id]', params: { id } });
  const openLesson = () => router.push('/steps');

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 110 }]}
      showsVerticalScrollIndicator={false}
    >
      {/* Top bar */}
      <View style={styles.topBar}>
        <Image source={require('../../../assets/images/logo-mark.png')} style={styles.logoMark} resizeMode="contain" />
        <Pressable
          onPress={() => router.push('/profile')}
          accessibilityLabel="Profile"
          style={({ pressed }) => [styles.avatar, pressed && styles.pressed]}
        >
          <Ionicons name="person-outline" size={22} color={colors.onPrimary} />
        </Pressable>
      </View>

      {/* Hero */}
      <View style={styles.hero}>
        <Image
          source={require('../../../assets/images/hero-dancer.png')}
          style={styles.heroImage}
          resizeMode="contain"
        />
        <View style={styles.heroText}>
          <Text style={styles.kicker}>DANCE / LEARN / GROW</Text>
          <Text style={styles.headline}>Move</Text>
          <Text style={[styles.headline, styles.headlineAccent]}>Better.</Text>
          <Text style={styles.subhead}>Build your skills, one step at a time.</Text>
          <View style={styles.rule} />
        </View>
      </View>

      <View style={styles.ctaRow}>
        <Pressable onPress={goPractice} style={({ pressed }) => [styles.cta, pressed && styles.pressed]}>
          <Ionicons name="play" size={16} color={colors.onPrimary} />
          <Text style={styles.ctaText}>Start Learning</Text>
          <Ionicons name="arrow-forward" size={18} color={colors.onPrimary} />
        </Pressable>
        <Pressable
          onPress={goUpload}
          accessibilityLabel="Upload a YouTube Short"
          style={({ pressed }) => [styles.uploadButton, pressed && styles.pressed]}
        >
          <Ionicons name="cloud-upload-outline" size={18} color={colors.text} />
          <Text style={styles.uploadText}>Upload</Text>
        </Pressable>
      </View>

      {/* Progress */}
      <Pressable onPress={goPractice} style={({ pressed }) => [styles.card, styles.row, pressed && styles.pressed]}>
        <ProgressRing fraction={fraction} />
        <View style={styles.flex}>
          <View style={styles.rowBetween}>
            <Text style={styles.cardTitle}>Your Progress</Text>
            <View style={styles.pill}>
              <Text style={styles.pillText}>Level {progress.level}</Text>
            </View>
          </View>
          <Text style={styles.count}>
            {progress.movesCompleted}
            <Text style={styles.countTotal}> / {progress.movesTotal}</Text>
          </Text>
          <Text style={styles.caption}>Moves Completed</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.muted} />
      </Pressable>

      {/* Continue: the newest dance from Supabase, or the sample lesson until there is one */}
      {latest ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${latest.title}`}
          onPress={() => openDance(latest.id)}
          style={({ pressed }) => [styles.card, styles.row, pressed && styles.pressed]}
        >
          <View style={styles.thumb}>
            <DanceImage dance={latest} />
            <View style={styles.thumbShade} />
            <View style={styles.playBadge}>
              <Ionicons name="play" size={16} color={colors.onPrimary} />
            </View>
            <Text style={styles.duration}>{formatClock(latest.duration_ms)}</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.cardTitle} numberOfLines={2}>
              {latest.title}
            </Text>
            <Text style={styles.caption}>
              {latest.step_count} {latest.step_count === 1 ? 'step' : 'steps'}
              {latest.mine ? '' : ' · Shared'}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>
      ) : (
        <Pressable accessibilityRole="button" accessibilityLabel={`Learn ${sampleLesson.title}`} onPress={openLesson} style={({ pressed }) => [styles.card, styles.row, pressed && styles.pressed]}>
          <View style={styles.thumb}>
            <Image source={sampleLesson.image} style={StyleSheet.absoluteFill} resizeMode="cover" />
            <View style={styles.thumbShade} />
            <View style={styles.playBadge}>
              <Ionicons name="play" size={16} color={colors.onPrimary} />
            </View>
            <Text style={styles.duration}>{continueWatching.durationLabel}</Text>
          </View>
          <View style={styles.flex}>
            <Text style={styles.cardTitle}>{sampleLesson.title}</Text>
            <Text style={styles.caption}>
              {sampleLesson.style} · {sampleLesson.steps} steps
            </Text>
            <View style={styles.track}>
              <View style={[styles.trackFill, { width: `${continueWatching.fractionDone * 100}%` }]} />
            </View>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.muted} />
        </Pressable>
      )}

      {/* Dances from Supabase */}
      {!usingMockApi && (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Your dances</Text>
          {loading && dances !== null && <ActivityIndicator size="small" color={colors.muted} />}
        </View>
      )}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.routines}>
        {dances === null && loading &&
          [0, 1, 2].map((i) => (
            <View key={i} style={styles.routine} accessibilityLabel="Loading dances">
              <View style={[styles.routineImageWrap, styles.skeleton]} />
              <View style={styles.skeletonLabel} />
            </View>
          ))}
        {dances?.map((dance) => (
          <Pressable
            key={dance.id}
            accessibilityRole="button"
            accessibilityLabel={`Open ${dance.title}`}
            onPress={() => openDance(dance.id)}
            style={styles.routine}
          >
            <View style={[styles.routineImageWrap, styles.danceTile, dance.id === latest?.id && styles.routineSelected]}>
              <DanceImage dance={dance} />
              <Text style={styles.tileSteps}>{dance.step_count}</Text>
            </View>
            <Text style={styles.routineLabel} numberOfLines={1}>
              {dance.title}
            </Text>
          </Pressable>
        ))}
        <Pressable accessibilityRole="button" accessibilityLabel={`Learn ${sampleLesson.title}`} onPress={openLesson} style={styles.routine}>
          <View style={styles.routineImageWrap}>
            <Image source={sampleLesson.image} style={styles.routineImage} resizeMode="cover" />
          </View>
          <Text style={styles.routineLabel} numberOfLines={1}>
            {sampleLesson.title}
          </Text>
        </Pressable>
        <Pressable onPress={goUpload} style={styles.routine}>
          <View style={[styles.routineImageWrap, styles.addTile]}>
            <Ionicons name="add" size={30} color={colors.text} />
          </View>
          <Text style={styles.routineLabel}>{dances?.length === 0 ? 'Upload one' : 'Add More'}</Text>
        </Pressable>
      </ScrollView>
      {error && (
        <Pressable onPress={reload} style={styles.errorRow} accessibilityLabel="Retry loading dances">
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.retry}>Retry</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

/** YouTube thumbnail of a dance, or a plain tile with an icon when it has none. */
function DanceImage({ dance }: { dance: DanceSummary }) {
  const uri = danceThumbnail(dance);
  return uri ? (
    <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
  ) : (
    <View style={[StyleSheet.absoluteFill, styles.noThumb]}>
      <Ionicons name="musical-notes" size={24} color={colors.accentSoft} />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 18, gap: 16 },
  flex: { flex: 1, gap: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  pressed: { opacity: 0.75 },

  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logoMark: { width: 40, height: 34 },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },

  hero: { height: 240, justifyContent: 'center' },
  heroImage: { position: 'absolute', right: -18, top: 0, width: '68%', height: '100%' },
  heroText: { width: '48%', gap: 2 },
  kicker: { color: colors.muted, fontSize: 10, letterSpacing: 2.5, marginBottom: 10 },
  headline: { color: colors.text, fontSize: 42, fontWeight: '800', letterSpacing: -1, lineHeight: 46 },
  headlineAccent: { color: colors.accent },
  subhead: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 8, maxWidth: 150 },
  rule: { width: 32, height: 1.5, backgroundColor: colors.accentSoft, marginTop: 14 },

  ctaRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 50,
    paddingHorizontal: 20,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    borderColor: colors.primary,
  },
  uploadText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  cta: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: 50,
    paddingHorizontal: 24,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  ctaText: { color: colors.onPrimary, fontSize: 15, fontWeight: '600' },

  card: {
    padding: 14,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    shadowColor: '#5A4632',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  cardTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  pill: { backgroundColor: colors.pill, paddingHorizontal: 10, paddingVertical: 3, borderRadius: radius.pill },
  pillText: { color: colors.pillText, fontSize: 12, fontWeight: '600' },
  count: { color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 6 },
  countTotal: { color: colors.muted, fontSize: 14, fontWeight: '500' },
  caption: { color: colors.muted, fontSize: 13 },

  thumb: {
    width: 140,
    height: 88,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbShade: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.25)' },
  playBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 2,
  },
  duration: {
    position: 'absolute',
    left: 8,
    bottom: 6,
    color: colors.onPrimary,
    fontSize: 13,
    fontWeight: '700',
  },
  track: { height: 5, borderRadius: 3, backgroundColor: colors.hairline, marginTop: 10, overflow: 'hidden' },
  trackFill: { height: '100%', borderRadius: 3, backgroundColor: colors.accentSoft },

  routines: { gap: 12, paddingVertical: 2 },
  routine: { width: 84, alignItems: 'center', gap: 6 },
  routineImageWrap: {
    width: 84,
    height: 76,
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  routineSelected: { borderColor: colors.accentSoft },
  routineImage: { width: '100%', height: '100%' },
  routineLabel: { color: colors.text, fontSize: 12, fontWeight: '500' },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: -6 },
  sectionTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
  skeleton: { backgroundColor: colors.hairline },
  skeletonLabel: { width: 56, height: 10, borderRadius: 5, backgroundColor: colors.hairline },
  danceTile: { backgroundColor: colors.surfaceAlt },
  noThumb: { backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
  tileSteps: {
    position: 'absolute',
    right: 5,
    bottom: 5,
    minWidth: 20,
    paddingHorizontal: 5,
    borderRadius: radius.pill,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.6)',
    color: colors.onPrimary,
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  errorText: { flex: 1, color: colors.bad, fontSize: 13, lineHeight: 18 },
  retry: { color: colors.accent, fontSize: 14, fontWeight: '600' },
  addTile: { backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
});
