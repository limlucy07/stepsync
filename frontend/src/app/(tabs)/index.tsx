import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DanceImage } from '@/components/dance-image';
import { ProgressRing } from '@/components/progress-ring';
import { continueWatching, progress, routines } from '@/data/home';
import { formatClock } from '@/lib/dance';
import { useDances } from '@/lib/use-dances';
import { colors, radius } from '@/theme';

// Kaitlyn's step lesson, still on sample data; kept on the home screen so it stays reachable.
const sampleLesson = routines.find((r) => r.id === 'perfect-night') ?? routines[0];

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { dances } = useDances();
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
              {latest.steps_completed ?? 0} of {latest.step_count} {latest.step_count === 1 ? 'step' : 'steps'} mastered
              {latest.mine ? '' : ' · Shared'}
            </Text>
            <View style={styles.track}>
              <View
                style={[
                  styles.trackFill,
                  { width: `${latest.step_count ? ((latest.steps_completed ?? 0) / latest.step_count) * 100 : 0}%` },
                ]}
              />
            </View>
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

      {/* Lessons; every dance is listed in the Explore tab */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.routines}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Learn ${sampleLesson.title}`} onPress={openLesson} style={styles.routine}>
          <View style={[styles.routineImageWrap, !latest && styles.routineSelected]}>
            <Image source={sampleLesson.image} style={styles.routineImage} resizeMode="cover" />
          </View>
          <Text style={styles.routineLabel} numberOfLines={1}>
            {sampleLesson.title}
          </Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="All dances" onPress={() => router.navigate('/explore')} style={styles.routine}>
          <View style={[styles.routineImageWrap, styles.addTile]}>
            <Ionicons name="albums-outline" size={28} color={colors.text} />
          </View>
          <Text style={styles.routineLabel}>All dances</Text>
        </Pressable>
        <Pressable onPress={goUpload} style={styles.routine}>
          <View style={[styles.routineImageWrap, styles.addTile]}>
            <Ionicons name="add" size={30} color={colors.text} />
          </View>
          <Text style={styles.routineLabel}>Add More</Text>
        </Pressable>
      </ScrollView>
    </ScrollView>
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
  addTile: { backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
});
