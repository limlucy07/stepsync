import {
  CameraView,
  useCameraPermissions,
  useMicrophonePermissions,
  type CameraType,
} from 'expo-camera';
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { PickedVideo } from '@/api/types';
import { StepClip } from '@/components/step-clip';
import { recordingKey, useSession } from '@/state/session';
import { colors } from '@/theme';

const COUNTDOWN_SECONDS = 3;
// If the preview hasn't started by then, say so and offer to restart the camera.
const CAMERA_START_TIMEOUT_MS = 4000;
const MAX_SECONDS = 180;

type Phase = 'idle' | 'countdown' | 'recording';

export default function RecordScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { slot, step, key, clip, clipStart, clipEnd } = useLocalSearchParams<{
    slot?: string;
    step?: string;
    /** Session key for a step recording (see recordingKey). */
    key?: string;
    /** The step's part of the tutorial video, shown above the camera. */
    clip?: string;
    clipStart?: string;
    clipEnd?: string;
  }>();
  const target = slot === 'reference' ? 'reference' : 'practice';
  const { setReference, setPractice, setStepRecording } = useSession();

  const [cameraPermission, requestCamera] = useCameraPermissions();
  const [micPermission, requestMic] = useMicrophonePermissions();

  const camera = useRef<CameraView>(null);
  const cancelCountdown = useRef(false);
  const discardRecording = useRef(false);
  const startedAt = useRef(0);

  const [facing, setFacing] = useState<CameraType>(step ? 'front' : 'back');
  const [cameraReady, setCameraReady] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [count, setCount] = useState(COUNTDOWN_SECONDS);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // The camera is mounted once the screen has finished sliding in (on iOS a camera started mid-animation
  // can stay black), runs only while this screen is showing, and is remounted by "Try again".
  const [mounted, setMounted] = useState(false);
  const [focused, setFocused] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [stuck, setStuck] = useState(false);

  const navigation = useNavigation();
  useEffect(() => {
    const unsubscribe = navigation.addListener('transitionEnd' as never, () => setMounted(true));
    const fallback = setTimeout(() => setMounted(true), 600);
    return () => {
      unsubscribe();
      clearTimeout(fallback);
    };
  }, [navigation]);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  const cameraAllowed = Boolean(cameraPermission?.granted);
  useEffect(() => {
    if (!mounted || !cameraAllowed || cameraReady || Platform.OS === 'web') return;
    setStuck(false);
    const timer = setTimeout(() => setStuck(true), CAMERA_START_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [mounted, cameraAllowed, cameraReady, attempt]);

  function restartCamera() {
    setStuck(false);
    setError(null);
    setCameraReady(false);
    setAttempt((n) => n + 1);
  }

  useEffect(() => () => {
    discardRecording.current = true;
    cancelCountdown.current = true;
    camera.current?.stopRecording();
  }, []);

  // Tick the on-screen timer while recording.
  useEffect(() => {
    if (phase !== 'recording') return;
    const id = setInterval(() => setElapsed((Date.now() - startedAt.current) / 1000), 250);
    return () => clearInterval(id);
  }, [phase]);

  // (The browser uses record.web.tsx instead of this screen.)

  // Permission hooks are still loading.
  if (!cameraPermission || !micPermission) return <View style={styles.fill} />;

  if (!cameraPermission.granted) {
    const canAsk = cameraPermission.canAskAgain;
    return (
      <Message
        title="Camera access"
        body="StepSync films your dancing so it can compare you with the reference. Audio helps line the two videos up with the music."
        action={canAsk ? 'Allow camera and microphone' : 'Open Settings'}
        onAction={async () => {
          if (!canAsk) return Linking.openSettings();
          const result = await requestCamera();
          if (result.granted && !micPermission.granted && micPermission.canAskAgain) {
            await requestMic();
          }
        }}
        onCancel={() => router.back()}
      />
    );
  }

  async function startCountdown() {
    setError(null);
    cancelCountdown.current = false;
    discardRecording.current = false;
    setPhase('countdown');
    for (let n = COUNTDOWN_SECONDS; n > 0; n--) {
      setCount(n);
      await sleep(1000);
      if (cancelCountdown.current) return setPhase('idle');
    }
    await record();
  }

  async function record() {
    setPhase('recording');
    setElapsed(0);
    startedAt.current = Date.now();
    try {
      const video = await camera.current?.recordAsync({
        maxDuration: MAX_SECONDS,
        ...(Platform.OS === 'ios' ? { codec: 'avc1' as const } : {}),
      });
      const durationMs = Date.now() - startedAt.current;
      if (discardRecording.current) return;
      if (!video?.uri) return setPhase('idle');

      const picked = toPickedVideo(video.uri, target, durationMs);
      if (step && target === 'practice') setStepRecording(key || recordingKey(null, Math.max(0, Number(step) - 1)), picked);
      else if (target === 'reference') setReference(picked);
      else setPractice(picked);
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Recording failed.');
      setPhase('idle');
    }
  }

  function onShutter() {
    if (phase === 'idle') startCountdown();
    else if (phase === 'countdown') cancelCountdown.current = true;
    else camera.current?.stopRecording(); // resolves the recordAsync promise above
  }

  return (
    <View style={styles.fill}>
      {mounted && (
        <CameraView
          key={attempt}
          ref={camera}
          style={step ? styles.stepCamera : StyleSheet.absoluteFill}
          mode="video"
          facing={facing}
          videoQuality="720p"
          active={focused}
          mute={!micPermission.granted}
          onCameraReady={() => {
            setCameraReady(true);
            setStuck(false);
          }}
          onMountError={(e) => setError(`The camera couldn't start: ${e.message}`)}
        />
      )}

      {(stuck || !cameraReady) && phase === 'idle' && (
        <View style={[styles.center, step ? { top: '45%' } : undefined]} pointerEvents="box-none">
          {stuck || error ? (
            <View style={styles.stuck}>
              <Text style={styles.stuckTitle}>The camera isn't showing</Text>
              <Text style={styles.stuckBody}>
                Close other apps that use the camera (FaceTime, Camera, video calls), and check Settings › Expo Go ›
                Camera is on. Then try again.
              </Text>
              <Pressable onPress={restartCamera} style={styles.primary} accessibilityLabel="Restart the camera">
                <Text style={styles.primaryText}>Try again</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.hint}>Starting camera…</Text>
          )}
        </View>
      )}

      {step && (clip ? (
        <StepClip testID="step-clip" source={clip} startMs={Number(clipStart) || 0} endMs={Number(clipEnd) || 0} muted style={styles.stepReference} />
      ) : (
        <View testID="step-clip-placeholder" style={styles.stepReference}><Text style={styles.hint}>Step clip coming soon</Text></View>
      ))}

      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <RoundButton
          label="✕"
          onPress={() => {
            discardRecording.current = true;
            cancelCountdown.current = true;
            camera.current?.stopRecording();
            router.back();
          }}
        />
        {phase === 'recording' ? (
          <View style={styles.timer}>
            <View style={styles.recDot} />
            <Text style={styles.timerText}>{formatClock(elapsed)}</Text>
          </View>
        ) : (
          <Text style={styles.topTitle}>
            {target === 'reference' ? 'Record reference' : 'Record practice'}
          </Text>
        )}
        <View style={styles.spacer} />
      </View>

      {phase === 'countdown' && (
        <View style={[styles.center, step ? { top: '45%' } : undefined]} pointerEvents="none">
          <Text style={styles.countdown}>{count}</Text>
        </View>
      )}

      <View style={[styles.bottom, { paddingBottom: insets.bottom + 20 }]}>
        {error ? (
          <Text style={styles.error}>{error}</Text>
        ) : (
          phase === 'idle' && (
            <Text style={styles.hint}>
              Prop the phone up so your whole body stays in frame.
              {!micPermission.granted && ' Recording without sound.'}
            </Text>
          )
        )}
        <View style={styles.controls}>
          <View style={styles.spacer} />
          <Pressable
            onPress={onShutter}
            disabled={!cameraReady}
            accessibilityLabel={phase === 'recording' ? 'Stop recording' : 'Start recording'}
            style={[styles.shutter, !cameraReady && styles.disabled]}
          >
            <View style={phase === 'recording' ? styles.stopSquare : styles.recCircle} />
          </Pressable>
          <View style={styles.spacer}>
            <RoundButton
              label="⟲"
              disabled={phase !== 'idle'}
              onPress={() => setFacing((f) => (f === 'back' ? 'front' : 'back'))}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

function toPickedVideo(uri: string, target: string, durationMs: number): PickedVideo {
  const ext = uri.split('.').pop()?.toLowerCase() ?? 'mp4';
  return {
    uri,
    fileName: `${target}-${Date.now()}.${ext}`,
    mimeType: ext === 'mov' ? 'video/quicktime' : 'video/mp4',
    durationMs,
  };
}

function RoundButton(props: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={props.onPress}
      disabled={props.disabled}
      style={({ pressed }) => [
        styles.round,
        props.disabled && styles.disabled,
        pressed && styles.pressed,
      ]}
    >
      <Text style={styles.roundLabel}>{props.label}</Text>
    </Pressable>
  );
}

function Message(props: {
  title: string;
  body: string;
  action: string;
  onAction: () => void;
  onCancel?: () => void;
}) {
  return (
    <View style={styles.message}>
      <Text style={styles.messageTitle}>{props.title}</Text>
      <Text style={styles.messageBody}>{props.body}</Text>
      <Pressable onPress={props.onAction} style={styles.primary}>
        <Text style={styles.primaryText}>{props.action}</Text>
      </Pressable>
      {props.onCancel && (
        <Pressable onPress={props.onCancel}>
          <Text style={styles.cancel}>Not now</Text>
        </Pressable>
      )}
    </View>
  );
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatClock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  stepReference: { position: 'absolute', top: 0, left: 0, right: 0, height: '45%', backgroundColor: '#000', borderBottomWidth: 1, borderBottomColor: '#444', alignItems: 'center', justifyContent: 'center' },
  stepCamera: { position: 'absolute', top: '45%', bottom: 0, left: 0, right: 0 },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
  },
  topTitle: { flex: 2, textAlign: 'center', color: '#fff', fontSize: 16, fontWeight: '600' },
  timer: {
    flex: 2,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.bad },
  timerText: { color: '#fff', fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] },
  spacer: { flex: 1, alignItems: 'flex-end' },
  center: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  countdown: {
    color: '#fff',
    fontSize: 120,
    fontWeight: '800',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 12,
  },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 24, gap: 18 },
  hint: { color: '#fff', textAlign: 'center', fontSize: 14, opacity: 0.9 },
  error: { color: colors.bad, textAlign: 'center', fontSize: 14 },
  stuck: { marginHorizontal: 28, padding: 20, gap: 12, borderRadius: 18, backgroundColor: 'rgba(20,18,15,0.92)', alignItems: 'center' },
  stuckTitle: { color: '#fff', fontSize: 17, fontWeight: '700' },
  stuckBody: { color: '#fff', opacity: 0.85, fontSize: 14, lineHeight: 20, textAlign: 'center' },
  controls: { flexDirection: 'row', alignItems: 'center' },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    borderColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  recCircle: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.bad },
  stopSquare: { width: 30, height: 30, borderRadius: 6, backgroundColor: colors.bad },
  round: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundLabel: { color: '#fff', fontSize: 20 },
  disabled: { opacity: 0.35 },
  pressed: { opacity: 0.6 },
  message: {
    flex: 1,
    backgroundColor: colors.background,
    padding: 28,
    justifyContent: 'center',
    gap: 14,
  },
  messageTitle: { color: colors.text, fontSize: 24, fontWeight: '700' },
  messageBody: { color: colors.muted, fontSize: 16, lineHeight: 23 },
  primary: {
    marginTop: 10,
    height: 52,
    borderRadius: 14,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: colors.onPrimary, fontSize: 17, fontWeight: '600' },
  cancel: { color: colors.muted, textAlign: 'center', fontSize: 15, padding: 8 },
});
