import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { PickedVideo } from '@/api/types';
import { StepClip } from '@/components/step-clip';
import { recordingKey, useSession } from '@/state/session';
import { colors } from '@/theme';

const COUNTDOWN_SECONDS = 3;
const MAX_SECONDS = 180;
const MIME_TYPES = ['video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

type Phase = 'starting' | 'idle' | 'countdown' | 'recording' | 'failed';

/**
 * Browser version of the camera screen (record.tsx is the phone version): films with the computer's
 * webcam using getUserMedia and MediaRecorder. Same params and result as the phone version:
 *   ?slot=practice&step=N&key=…&clip=…   a step recording, with the step's clip shown above the camera
 * Browsers only allow the camera on localhost or HTTPS.
 */
export default function RecordScreen() {
  const router = useRouter();
  const { slot, step, key, clip, clipStart, clipEnd } = useLocalSearchParams<{
    slot?: string;
    step?: string;
    key?: string;
    clip?: string;
    clipStart?: string;
    clipEnd?: string;
  }>();
  const target = slot === 'reference' ? 'reference' : 'practice';
  const { setReference, setPractice, setStepRecording } = useSession();

  const preview = useRef<HTMLVideoElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const cancelled = useRef(false);
  const startedAt = useRef(0);
  const [phase, setPhase] = useState<Phase>('starting');
  const [count, setCount] = useState(COUNTDOWN_SECONDS);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [silent, setSilent] = useState(false);
  const [mirrored, setMirrored] = useState(true);

  const stopCamera = useCallback(() => {
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }, []);

  const startCamera = useCallback(async () => {
    setError(null);
    setPhase('starting');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('This browser can\'t record video. Open StepSync on localhost or HTTPS in Chrome, Edge, Firefox or Safari.');
      setPhase('failed');
      return;
    }
    try {
      let media: MediaStream;
      try {
        media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 1280, height: 720 }, audio: true });
      } catch {
        // No microphone (or it was blocked): still film, just without sound.
        media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      }
      if (cancelled.current) return media.getTracks().forEach((track) => track.stop());
      stream.current = media;
      setSilent(media.getAudioTracks().length === 0);
      setMirrored(media.getVideoTracks()[0]?.getSettings().facingMode !== 'environment');
      if (preview.current) preview.current.srcObject = media;
      setPhase('idle');
    } catch (e) {
      setError(
        e instanceof Error && e.name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow the camera for this site in your browser (the camera icon in the address bar), then try again.'
          : 'Could not open your camera. Check that it is connected and not being used by another app, then try again.',
      );
      setPhase('failed');
    }
  }, []);

  useEffect(() => {
    cancelled.current = false;
    startCamera();
    return () => {
      cancelled.current = true;
      if (recorder.current && recorder.current.state !== 'inactive') recorder.current.stop();
      stopCamera();
    };
  }, [startCamera, stopCamera]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setInterval(() => {
      const seconds = (Date.now() - startedAt.current) / 1000;
      setElapsed(seconds);
      if (seconds >= MAX_SECONDS) recorder.current?.stop();
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  async function startCountdown() {
    setPhase('countdown');
    for (let n = COUNTDOWN_SECONDS; n > 0; n--) {
      setCount(n);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (cancelled.current) return;
    }
    record();
  }

  function record() {
    if (!stream.current) return;
    const chunks: Blob[] = [];
    const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const capture = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined);
    recorder.current = capture;
    capture.ondataavailable = (event) => event.data.size && chunks.push(event.data);
    capture.onerror = () => {
      setError('Recording failed. Please try again.');
      setPhase('idle');
    };
    capture.onstop = () => {
      recorder.current = null;
      if (cancelled.current) return;
      const type = capture.mimeType || chunks[0]?.type || 'video/webm';
      const blob = new Blob(chunks, { type });
      if (!blob.size) {
        setError('No video was captured. Please try again.');
        setPhase('idle');
        return;
      }
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      const video: PickedVideo = {
        uri: URL.createObjectURL(blob),
        fileName: `${target}-${Date.now()}.${ext}`,
        mimeType: type.split(';')[0],
        durationMs: Date.now() - startedAt.current,
      };
      if (step && target === 'practice') setStepRecording(key || recordingKey(null, Math.max(0, Number(step) - 1)), video);
      else if (target === 'reference') setReference(video);
      else setPractice(video);
      stopCamera();
      close();
    };
    startedAt.current = Date.now();
    setElapsed(0);
    capture.start(1000);
    setPhase('recording');
  }

  function close() {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  }

  function onShutter() {
    if (phase === 'idle') startCountdown();
    else if (phase === 'recording') recorder.current?.stop();
  }

  return (
    <View style={styles.fill}>
      {step && (
        <StepClip
          testID="step-clip"
          source={clip || null}
          startMs={Number(clipStart) || 0}
          endMs={Number(clipEnd) || 0}
          muted
          style={styles.stepReference}
        />
      )}
      <View style={step ? styles.stepCamera : styles.camera}>
        <video
          ref={preview}
          autoPlay
          muted
          playsInline
          aria-label="Live camera preview"
          style={{ width: '100%', height: '100%', objectFit: 'cover', background: '#000', transform: mirrored ? 'scaleX(-1)' : undefined }}
        />
        {phase === 'starting' && <Text style={[styles.hint, styles.overlay]}>Starting camera…</Text>}
        {phase === 'countdown' && <Text style={[styles.countdown, styles.overlay]}>{count}</Text>}
      </View>

      <View style={styles.topBar}>
        <Pressable onPress={close} accessibilityLabel="Close" style={styles.round}>
          <Text style={styles.roundLabel}>✕</Text>
        </Pressable>
        {phase === 'recording' ? (
          <View style={styles.timer}>
            <View style={styles.recDot} />
            <Text style={styles.timerText}>
              {Math.floor(elapsed / 60)}:{String(Math.floor(elapsed % 60)).padStart(2, '0')}
            </Text>
          </View>
        ) : (
          <Text style={styles.topTitle}>{target === 'reference' ? 'Record reference' : 'Record practice'}</Text>
        )}
        <View style={styles.spacer} />
      </View>

      <View style={styles.bottom}>
        {error ? (
          <View style={styles.errorBox}>
            <Text style={styles.error}>{error}</Text>
            {phase === 'failed' && (
              <Pressable onPress={startCamera} style={styles.primary}>
                <Text style={styles.primaryText}>Try again</Text>
              </Pressable>
            )}
          </View>
        ) : (
          phase === 'idle' && (
            <Text style={styles.hint}>
              Step back so your whole body is in frame.{silent ? ' Recording without sound.' : ''}
            </Text>
          )
        )}
        <Pressable
          onPress={onShutter}
          disabled={phase !== 'idle' && phase !== 'recording'}
          accessibilityLabel={phase === 'recording' ? 'Stop recording' : 'Start recording'}
          style={[styles.shutter, phase !== 'idle' && phase !== 'recording' && styles.disabled]}
        >
          <View style={phase === 'recording' ? styles.stopSquare : styles.recCircle} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: '#000' },
  camera: { ...StyleSheet.absoluteFill },
  stepReference: { position: 'absolute', top: 0, left: 0, right: 0, height: '45%', borderBottomWidth: 1, borderBottomColor: '#444' },
  stepCamera: { position: 'absolute', top: '45%', bottom: 0, left: 0, right: 0 },
  overlay: { position: 'absolute', top: '45%', left: 0, right: 0, textAlign: 'center' },
  topBar: { position: 'absolute', top: 12, left: 16, right: 16, flexDirection: 'row', alignItems: 'center' },
  topTitle: { flex: 2, textAlign: 'center', color: '#fff', fontSize: 16, fontWeight: '600' },
  timer: { flex: 2, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  recDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.bad },
  timerText: { color: '#fff', fontSize: 18, fontWeight: '600', fontVariant: ['tabular-nums'] },
  spacer: { flex: 1 },
  round: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  roundLabel: { color: '#fff', fontSize: 20 },
  countdown: { color: '#fff', fontSize: 120, fontWeight: '800', textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 12 },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 28, paddingHorizontal: 24, gap: 18, alignItems: 'center' },
  hint: { color: '#fff', textAlign: 'center', fontSize: 14, opacity: 0.9 },
  errorBox: { gap: 12, alignItems: 'center', padding: 16, borderRadius: 16, backgroundColor: 'rgba(20,18,15,0.92)', maxWidth: 420 },
  error: { color: '#fff', textAlign: 'center', fontSize: 14, lineHeight: 20 },
  primary: { paddingHorizontal: 24, paddingVertical: 12, borderRadius: 999, backgroundColor: colors.accent },
  primaryText: { color: colors.onPrimary, fontSize: 15, fontWeight: '600' },
  shutter: { width: 78, height: 78, borderRadius: 39, borderWidth: 4, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  recCircle: { width: 60, height: 60, borderRadius: 30, backgroundColor: colors.bad },
  stopSquare: { width: 30, height: 30, borderRadius: 6, backgroundColor: colors.bad },
  disabled: { opacity: 0.4 },
});
