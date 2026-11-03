import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PrimaryButton } from '@/components/primary-button';
import { StepVideoInput } from '@/components/step-video-input';
import { grapevineCounts, lessonStepIndex } from '@/data/lesson';
import { useSession } from '@/state/session';
import { lessonColors as palette, radius } from '@/theme';

export default function StepRecordingScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const previewHeight = Math.max(180, Math.min(332, (height - insets.top - insets.bottom - 300) / 2));
  const params = useLocalSearchParams<{ step?: string }>();
  const step = lessonStepIndex(params.step);
  const count = grapevineCounts[step];
  const { stepRecordings, setStepRecording } = useSession();
  const video = stepRecordings[step];
  const [cameraActive, setCameraActive] = useState(false);
  const returnToStep = () => {
    if (router.canGoBack()) router.back();
    else router.replace({ pathname: '/steps', params: { step: String(step + 1) } });
  };

  return (
    <ScrollView style={styles.fill} contentContainerStyle={[styles.container, { paddingTop: insets.top + 20, paddingBottom: insets.bottom + 24 }]}>
      <View style={styles.content}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to step" onPress={returnToStep} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
          <Ionicons name="arrow-back" size={20} color={palette.text} />
        </Pressable>
        <Text style={styles.kicker}>THE GRAPEVINE · STEP {step + 1} OF {grapevineCounts.length}</Text>
        <Text accessibilityRole="header" style={styles.title}>Practice your step</Text>
        <Text style={styles.action}>{count.action.replace('\n', ' ')} · {count.foot}</Text>

        <View style={styles.section}>
          <Text accessibilityRole="header" style={styles.panelLabel}>Step clip</Text>
          <View testID="step-clip-placeholder" accessibilityLabel="Step clip placeholder" style={[styles.reference, { height: previewHeight }]}>
            <Text style={styles.placeholderLabel}>Step clip coming soon</Text>
          </View>
        </View>

        <View testID="user-recording-panel" style={styles.section}>
          <Text accessibilityRole="header" style={styles.panelLabel}>Your recording</Text>
        {!cameraActive && (video ? <View style={styles.saved}><VideoPreview key={video.uri} uri={video.uri} height={previewHeight} /><Text style={styles.description}>Your recording is ready to review. Scoring is coming soon.</Text></View> : <View style={[styles.preview, { minHeight: previewHeight }]}>
          <View style={styles.cameraIcon}><Ionicons name="videocam-outline" size={42} color={palette.accent} /></View>
          <Text style={styles.previewTitle}>Record yourself dancing</Text>
          <Text style={styles.description}>Set up your camera so your whole body is visible, then record yourself doing this step.</Text>
        </View>)}

        <StepVideoInput step={step} hasVideo={Boolean(video)} previewHeight={previewHeight} onRecorded={recorded => setStepRecording(step, recorded)} onActiveChange={setCameraActive} />
        </View>

        <PrimaryButton label="Back to step" onPress={returnToStep} arrow={false} style={styles.button} />
      </View>
    </ScrollView>
  );
}

function VideoPreview({ uri, height }: { uri: string; height: number }) {
  const player = useVideoPlayer(uri);
  return <VideoView player={player} nativeControls contentFit="contain" style={[styles.video, { height }]} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: palette.background },
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
  pressed: { opacity: 0.75 },
});
