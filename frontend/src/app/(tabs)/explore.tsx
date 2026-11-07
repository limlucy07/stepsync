import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { DanceSummary } from '@/api/types';
import { DanceImage } from '@/components/dance-image';
import { formatClock } from '@/lib/dance';
import { useDances } from '@/lib/use-dances';
import { colors, radius } from '@/theme';

/** Every dance: your own and the ones teammates shared. Tap one to open its step scene. */
export default function ExploreScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { dances, error, loading, reload, available } = useDances();
  const [query, setQuery] = useState('');

  const search = query.trim().toLowerCase();
  const shown = (dances ?? []).filter((d) => !search || d.title.toLowerCase().includes(search));
  const mine = shown.filter((d) => d.mine);
  const shared = shown.filter((d) => !d.mine);
  const open = (id: string) => router.push({ pathname: '/dance/[id]', params: { id } });
  const upload = () => router.push('/youtube?from=home');

  return (
    <ScrollView
      style={styles.fill}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 110 }]}
      keyboardShouldPersistTaps="handled"
      refreshControl={<RefreshControl refreshing={loading && dances !== null} onRefresh={reload} tintColor={colors.muted} />}
    >
      <View style={styles.titleRow}>
        <Text accessibilityRole="header" style={styles.title}>Explore</Text>
        <Pressable
          onPress={upload}
          accessibilityLabel="Upload a dance"
          style={({ pressed }) => [styles.uploadButton, pressed && styles.pressed]}
        >
          <Ionicons name="add" size={18} color={colors.onPrimary} />
          <Text style={styles.uploadText}>Upload</Text>
        </Pressable>
      </View>

      {!available ? (
        <Text style={styles.note}>Connect the backend (EXPO_PUBLIC_API_URL) to see your dances.</Text>
      ) : (
        <>
          <View style={styles.search}>
            <Ionicons name="search" size={18} color={colors.muted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search dances"
              placeholderTextColor={colors.muted}
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel="Search dances"
              style={styles.searchInput}
            />
            {!!query && (
              <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear search">
                <Ionicons name="close-circle" size={18} color={colors.muted} />
              </Pressable>
            )}
          </View>

          {error && (
            <Pressable onPress={reload} style={styles.errorRow} accessibilityLabel="Retry loading dances">
              <Text style={styles.errorText}>{error}</Text>
              <Text style={styles.retry}>Retry</Text>
            </Pressable>
          )}

          {dances === null ? (
            loading ? (
              <View style={styles.loading}>
                <ActivityIndicator color={colors.accent} />
              </View>
            ) : null
          ) : dances.length === 0 ? (
            <View style={styles.empty}>
              <Ionicons name="musical-notes-outline" size={40} color={colors.accentSoft} />
              <Text style={styles.emptyTitle}>No dances yet</Text>
              <Text style={styles.note}>Upload a YouTube Short to split it into steps and start learning it.</Text>
              <Pressable onPress={upload} style={({ pressed }) => [styles.uploadButton, pressed && styles.pressed]}>
                <Ionicons name="cloud-upload-outline" size={18} color={colors.onPrimary} />
                <Text style={styles.uploadText}>Upload a dance</Text>
              </Pressable>
            </View>
          ) : shown.length === 0 ? (
            <Text style={styles.note}>No dances match "{query.trim()}".</Text>
          ) : (
            <>
              <Section title="Your dances" dances={mine} onOpen={open} empty="You haven't uploaded a dance yet." />
              {shared.length > 0 && <Section title="Shared by others" dances={shared} onOpen={open} />}
            </>
          )}
        </>
      )}
    </ScrollView>
  );
}

function Section({
  title,
  dances,
  onOpen,
  empty,
}: {
  title: string;
  dances: DanceSummary[];
  onOpen: (id: string) => void;
  empty?: string;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        <Text style={styles.count}>{dances.length}</Text>
      </View>
      {dances.length === 0 && empty ? <Text style={styles.note}>{empty}</Text> : null}
      <View style={styles.grid}>
        {dances.map((dance) => (
          <DanceCard key={dance.id} dance={dance} onPress={() => onOpen(dance.id)} />
        ))}
      </View>
    </View>
  );
}

/** A dance as a card: tall thumbnail (Shorts are vertical), title, and how many steps are mastered. */
function DanceCard({ dance, onPress }: { dance: DanceSummary; onPress: () => void }) {
  const done = dance.steps_completed ?? 0;
  const total = dance.step_count;
  const finished = total > 0 && done >= total;
  const status = total === 0 ? 'No steps yet' : finished ? 'All mastered' : `${done}/${total} mastered`;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${dance.title}, ${status}`}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <View style={styles.cardImage}>
        <DanceImage dance={dance} />
        <View style={styles.shade} />
        {dance.duration_ms !== null && (
          <View style={styles.durationBadge}>
            <Ionicons name="play" size={10} color={colors.onPrimary} />
            <Text style={styles.durationText}>{formatClock(dance.duration_ms)}</Text>
          </View>
        )}
        {finished && (
          <View style={styles.doneBadge}>
            <Ionicons name="checkmark" size={14} color={colors.onPrimary} />
          </View>
        )}
        {dance.mine && dance.is_public && <Text style={styles.publicBadge}>PUBLIC</Text>}
      </View>
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {dance.title}
        </Text>
        <Text style={styles.caption}>
          {total} {total === 1 ? 'step' : 'steps'} · {status}
        </Text>
        <View style={styles.track}>
          <View
            style={[styles.trackFill, { width: `${total ? (done / total) * 100 : 0}%` }, finished && styles.trackDone]}
          />
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 18, gap: 16 },
  pressed: { opacity: 0.75 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 32, fontWeight: '800', letterSpacing: -0.8 },
  uploadButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 40,
    paddingHorizontal: 16,
    borderRadius: radius.pill,
    backgroundColor: colors.primary,
  },
  uploadText: { color: colors.onPrimary, fontSize: 14, fontWeight: '600' },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 46,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: { flex: 1, height: '100%', color: colors.text, fontSize: 15 },
  section: { gap: 10 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  count: {
    color: colors.pillText,
    backgroundColor: colors.pill,
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 14 },
  card: {
    width: '48%',
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    shadowColor: '#5A4632',
    shadowOpacity: 0.08,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  cardImage: { width: '100%', aspectRatio: 3 / 4, backgroundColor: colors.surfaceAlt },
  shade: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.12)' },
  durationBadge: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  durationText: { color: colors.onPrimary, fontSize: 11, fontWeight: '700' },
  doneBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.good,
  },
  publicBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    color: colors.text,
    backgroundColor: 'rgba(255,252,247,0.9)',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.8,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  cardBody: { padding: 10, gap: 4 },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '600', lineHeight: 19 },
  caption: { color: colors.muted, fontSize: 12 },
  track: { height: 4, borderRadius: 2, backgroundColor: colors.hairline, marginTop: 4, overflow: 'hidden' },
  trackFill: { height: '100%', borderRadius: 2, backgroundColor: colors.accentSoft },
  trackDone: { backgroundColor: colors.good },
  loading: { paddingVertical: 40, alignItems: 'center' },
  empty: { alignItems: 'center', gap: 10, paddingVertical: 40 },
  emptyTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  note: { color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  errorRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  errorText: { flex: 1, color: colors.bad, fontSize: 13, lineHeight: 18 },
  retry: { color: colors.accent, fontSize: 14, fontWeight: '600' },
});
