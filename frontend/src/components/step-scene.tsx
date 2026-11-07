// Kaitlyn's step screen design (Figma "Dance step detail"), shared by the sample lesson (/steps)
// and real dances (/dance/[id]). Layout and styles are hers; the screens supply the content.
import Ionicons from '@expo/vector-icons/Ionicons';
import { Asset } from 'expo-asset';
import type { ReactNode } from 'react';
import { Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient, Rect, Stop, SvgUri } from 'react-native-svg';

import { PrimaryButton } from '@/components/primary-button';
import { colors, lessonColors as palette, radius } from '@/theme';

const icons = {
  signal: require('../../assets/steps/signal.svg'),
  wifi: require('../../assets/steps/wifi.svg'),
  battery: require('../../assets/steps/battery.svg'),
  back: require('../../assets/steps/back.svg'),
  volume: require('../../assets/steps/volume.svg'),
  travel: require('../../assets/steps/travel-left.svg'),
  sparkles: require('../../assets/steps/sparkles.svg'),
  previous: require('../../assets/steps/previous.svg'),
  next: require('../../assets/steps/next.svg'),
};

// Keep the exported Figma icons at their original dimensions on both platforms.
export function DesignIcon({ name, size = 16, width = size }: { name: keyof typeof icons; size?: number; width?: number }) {
  const source = icons[name];
  return Platform.OS === 'web'
    ? <Image source={source} style={{ width, height: size }} resizeMode="contain" />
    : <SvgUri uri={Asset.fromModule(source).uri} width={width} height={size} />;
}

/**
 * One count/step tile. done: dark number (mastered). active: highlighted (selected).
 * current: the step to master next, when it isn't the selected one. upcoming: greyed; locked ones can't be tapped.
 */
export type SceneTile = {
  action: string;
  foot: string;
  state: 'done' | 'active' | 'current' | 'upcoming';
  locked?: boolean;
  accessibilityLabel: string;
};

type Props = {
  testID?: string;
  lessonLabel: string;
  /** 0 to 1, the bar under the lesson label. */
  progress: number;
  level: string;
  title: string;
  cue: string;
  /** The demo area: a photo or a looping step clip. */
  media: ReactNode;
  badge: string;
  showAudio?: boolean;
  travel?: { text: string; icon?: 'travel' | 'check' | 'lock' | 'target' };
  sectionTitle: string;
  sectionMeta: string;
  tiles: SceneTile[];
  onTilePress?: (index: number) => void;
  tip: { label: string; text: string };
  /** Shown between the tip and the buttons (e.g. a notice or a link). */
  extra?: ReactNode;
  onBack: () => void;
  onPrevious: () => void;
  onPractice: () => void;
  practiceDisabled?: boolean;
};

export function StepScene(props: Props) {
  const insets = useSafeAreaInsets();
  const scroll = props.tiles.length > 4; // Figma fits four; longer dances scroll sideways
  const tiles = props.tiles.map((tile, index) => {
    const active = tile.state === 'active';
    const upcoming = tile.state === 'upcoming';
    const current = tile.state === 'current';
    return (
      <Pressable
        key={index}
        disabled={!props.onTilePress}
        onPress={() => props.onTilePress?.(index)}
        accessibilityRole={props.onTilePress ? 'button' : undefined}
        accessibilityState={{ selected: active, disabled: tile.locked }}
        accessibilityLabel={tile.accessibilityLabel}
        style={[styles.count, scroll && styles.scrollCount, active && styles.activeCount, current && styles.currentCount]}
      >
        <View style={[styles.marker, upcoming && styles.upcomingMarker, (active || current) && styles.activeMarker]}>
          <Text style={styles.number}>{index + 1}</Text>
        </View>
        <Text style={[styles.action, upcoming && styles.upcomingText]} numberOfLines={2}>{tile.action}</Text>
        <View style={styles.footRow}>
          {tile.locked && <Ionicons name="lock-closed" size={8} color={palette.upcoming} />}
          <Text style={[styles.foot, upcoming && styles.upcomingText]} numberOfLines={1}>{tile.foot}</Text>
        </View>
      </Pressable>
    );
  });

  return (
    <ScrollView style={styles.fill} contentContainerStyle={styles.canvas} showsVerticalScrollIndicator={false}>
      <View testID={props.testID} style={[styles.screen, { paddingTop: Platform.OS === 'web' ? 0 : insets.top, paddingBottom: Math.max(18, insets.bottom) }]}>
        {Platform.OS === 'web' && (
          <View style={styles.status} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
            <Text style={styles.time}>9:41</Text>
            <View style={styles.statusIcons}>
              <DesignIcon name="signal" size={15} />
              <DesignIcon name="wifi" size={15} />
              <DesignIcon name="battery" size={15} width={21} />
            </View>
          </View>
        )}

        <View style={styles.header}>
          <Pressable accessibilityRole="button" accessibilityLabel="Back to home" onPress={props.onBack} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
            <DesignIcon name="back" size={17} />
          </Pressable>
          <View style={styles.lesson}>
            <Text style={styles.lessonLabel}>{props.lessonLabel}</Text>
            <View style={styles.track}><View style={[styles.progress, { width: `${Math.round(Math.min(1, Math.max(0, props.progress)) * 100)}%` }]} /></View>
          </View>
          <View style={styles.balance} />
        </View>

        <View style={styles.content}>
          <View style={styles.introduction}>
            <Text style={styles.level}>{props.level}</Text>
            <Text style={styles.title} accessibilityRole="header" numberOfLines={2}>{props.title}</Text>
            <Text style={styles.cue}>{props.cue}</Text>
          </View>

          <View style={styles.demo}>
            {props.media}
            <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} pointerEvents="none">
              <Defs><LinearGradient id="demoShade" x1="0" y1="0" x2="0" y2="1"><Stop offset="0.35" stopColor="#17120B" stopOpacity={0} /><Stop offset="1" stopColor="#17120B" stopOpacity={0.44} /></LinearGradient></Defs>
              <Rect width="100%" height="100%" fill="url(#demoShade)" />
            </Svg>
            <View style={styles.demoBadge} pointerEvents="none"><View style={styles.dot} /><Text style={styles.demoLabel}>{props.badge}</Text></View>
            {props.showAudio !== false && <View style={styles.audio} pointerEvents="none"><DesignIcon name="volume" size={15} /></View>}
            {props.travel && (
              <View style={styles.travel} pointerEvents="none">
                {!props.travel.icon || props.travel.icon === 'travel'
                  ? <DesignIcon name="travel" />
                  : <Ionicons name={props.travel.icon === 'check' ? 'checkmark-circle' : props.travel.icon === 'lock' ? 'lock-closed' : 'flag'} size={14} color={colors.onPrimary} />}
                <Text style={styles.travelText}>{props.travel.text}</Text>
              </View>
            )}
          </View>

          <View style={styles.footwork}>
            <View style={styles.sectionHeading}><Text style={styles.sectionTitle}>{props.sectionTitle}</Text><Text style={styles.tempo}>{props.sectionMeta}</Text></View>
            {scroll ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.counts}>{tiles}</ScrollView>
            ) : (
              <View style={styles.counts} accessibilityLiveRegion="polite">{tiles}</View>
            )}
          </View>

          <View style={styles.tip}>
            <View style={styles.tipIcon}><DesignIcon name="sparkles" /></View>
            <View style={styles.tipCopy}><Text style={styles.tipLabel}>{props.tip.label}</Text><Text style={styles.tipText}>{props.tip.text}</Text></View>
          </View>

          {props.extra}

          <View style={styles.navigation}>
            <Pressable accessibilityRole="button" onPress={props.onPrevious} style={({ pressed }) => [styles.previous, pressed && styles.pressed]}>
              <DesignIcon name="previous" /><Text style={styles.previousLabel}>Previous</Text>
            </Pressable>
            <PrimaryButton
              label="Practice Now"
              onPress={props.onPractice}
              disabled={props.practiceDisabled}
              style={styles.next}
              labelStyle={styles.nextLabel}
              trailingIcon={<View style={styles.nextIcon}><DesignIcon name="next" /></View>}
            />
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

/** The demo area's photo or video fills it edge to edge. */
export const sceneMediaStyle = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' } as const;

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: palette.background },
  canvas: { flexGrow: 1, alignItems: 'center' },
  screen: { width: '100%', maxWidth: 390, minHeight: Platform.OS === 'web' ? 844 : undefined, backgroundColor: palette.background },
  status: { height: 42, paddingHorizontal: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  time: { fontSize: 12, color: palette.text },
  statusIcons: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  header: { height: 54, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  back: { width: 36, height: 36, borderRadius: radius.pill, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center' },
  balance: { width: 36, height: 36 },
  lesson: { width: 136, alignItems: 'center', gap: 6 },
  lessonLabel: { color: palette.secondary, fontSize: 10, fontWeight: '700', letterSpacing: 1.1, lineHeight: 12 },
  track: { height: 4, width: '100%', borderRadius: radius.pill, backgroundColor: palette.track, overflow: 'hidden' },
  progress: { height: 4, borderRadius: radius.pill, backgroundColor: palette.accent },
  content: { paddingHorizontal: 20, paddingTop: 12, gap: 16 },
  introduction: { gap: 5 },
  level: { color: palette.accent, fontSize: 10, lineHeight: 12, fontWeight: '700', letterSpacing: 1.2 },
  title: { color: palette.text, fontSize: 32, lineHeight: 34, letterSpacing: -0.8 },
  cue: { color: palette.muted, fontSize: 13, lineHeight: 16 },
  demo: { width: '100%', height: 332, borderRadius: 24, overflow: 'hidden', backgroundColor: '#17120B', boxShadow: '0px 8px 22px rgba(58,45,33,0.08)' },
  demoBadge: { position: 'absolute', top: 12, left: 12, paddingHorizontal: 10, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: 'rgba(255,252,247,0.91)', flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: radius.pill, backgroundColor: palette.accent },
  demoLabel: { color: palette.text, fontSize: 10, fontWeight: '700', letterSpacing: 0.7, lineHeight: 12 },
  audio: { position: 'absolute', top: 12, right: 12, width: 34, height: 34, borderRadius: radius.pill, backgroundColor: 'rgba(255,252,247,0.91)', alignItems: 'center', justifyContent: 'center' },
  travel: { position: 'absolute', bottom: 16, left: 16, paddingHorizontal: 10, paddingVertical: 7, borderRadius: radius.pill, backgroundColor: 'rgba(27,25,22,0.8)', flexDirection: 'row', alignItems: 'center', gap: 7 },
  travelText: { color: colors.onPrimary, fontSize: 12, lineHeight: 15 },
  footwork: { gap: 8 },
  sectionHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sectionTitle: { color: palette.text, fontSize: 13, lineHeight: 16, fontWeight: '700' },
  tempo: { color: palette.muted, fontSize: 10, fontWeight: '600' },
  counts: { flexDirection: 'row', gap: 7 },
  count: { flex: 1, minWidth: 0, height: 76, paddingTop: 7, gap: 4, alignItems: 'center', borderRadius: 16, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface },
  scrollCount: { flexGrow: 0, flexShrink: 0, flexBasis: 74, width: 74 },
  activeCount: { borderColor: palette.accent, backgroundColor: palette.selected },
  currentCount: { borderColor: palette.accent },
  marker: { width: 22, height: 22, borderRadius: radius.pill, backgroundColor: palette.text, alignItems: 'center', justifyContent: 'center' },
  activeMarker: { backgroundColor: palette.accent },
  upcomingMarker: { backgroundColor: palette.upcoming },
  number: { color: colors.onPrimary, fontSize: 10, fontWeight: '700', lineHeight: 12 },
  action: { color: palette.text, fontSize: 10, lineHeight: 11, textAlign: 'center', fontWeight: '700', letterSpacing: 0.3 },
  footRow: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 4 },
  foot: { color: palette.muted, fontSize: 9, lineHeight: 11, fontWeight: '500' },
  upcomingText: { color: palette.upcoming },
  tip: { minHeight: 71, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, borderRadius: 16, paddingHorizontal: 13, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 12 },
  tipIcon: { width: 34, height: 34, borderRadius: radius.pill, backgroundColor: palette.selected, alignItems: 'center', justifyContent: 'center' },
  tipCopy: { flex: 1, gap: 3 },
  tipLabel: { color: palette.accent, fontSize: 10, letterSpacing: 0.8, lineHeight: 12 },
  tipText: { color: palette.secondary, fontSize: 12, fontWeight: '500', lineHeight: 15.6 },
  navigation: { flexDirection: 'row', gap: 12 },
  previous: { flex: 1, height: 52, borderRadius: radius.pill, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  previousLabel: { color: palette.text, fontSize: 13 },
  next: { flex: 1, height: 52, borderRadius: radius.pill, backgroundColor: palette.text, paddingHorizontal: 10 },
  nextLabel: { fontSize: 13, fontWeight: '400' },
  nextIcon: { marginLeft: 8 },
  pressed: { opacity: 0.75 },
});
