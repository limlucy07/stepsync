import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PrimaryButton } from '@/components/primary-button';
import { lessonColors as palette, radius } from '@/theme';
import type { StepVideoInputProps } from './step-video-input.types';

type Phase = 'idle' | 'requesting' | 'ready' | 'recording' | 'saving';
const MAX_SECONDS = 180;

export function StepVideoInput({ step, hasVideo, onRecorded, onActiveChange, previewHeight = 332 }: StepVideoInputProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [silent, setSilent] = useState(false);
  const preview = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const startedAt = useRef(0);
  const generation = useRef(0);
  const callbacks = useRef({ onRecorded, onActiveChange });
  callbacks.current = { onRecorded, onActiveChange };

  const releaseCamera = useCallback(() => {
    stream.current?.getTracks().forEach(track => track.stop());
    stream.current = null;
    if (preview.current) preview.current.srcObject = null;
  }, []);

  const discard = useCallback(() => {
    generation.current++;
    const active = recorder.current;
    recorder.current = null;
    if (active && active.state !== 'inactive') active.stop();
    releaseCamera();
  }, [releaseCamera]);

  useFocusEffect(useCallback(() => () => {
    discard();
    setPhase('idle');
    callbacks.current.onActiveChange(false);
  }, [discard]));

  useEffect(() => {
    if (phase === 'ready' && preview.current && stream.current) preview.current.srcObject = stream.current;
  }, [phase]);

  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = setInterval(() => {
      const seconds = (Date.now() - startedAt.current) / 1000;
      setElapsed(seconds);
      if (seconds >= MAX_SECONDS && recorder.current?.state === 'recording') {
        setPhase('saving');
        recorder.current.stop();
      }
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  async function enableCamera() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('Camera recording is unavailable in this browser. Open StepSync on localhost or HTTPS in a browser that supports recording.');
      return;
    }
    const id = ++generation.current;
    setPhase('requesting');
    callbacks.current.onActiveChange(true);
    try {
      let media: MediaStream;
      try {
        media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: true });
      } catch {
        // A denied/unavailable microphone should not prevent video capture.
        if (id !== generation.current) return;
        media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      }
      if (id !== generation.current) {
        media.getTracks().forEach(track => track.stop());
        return;
      }
      stream.current = media;
      setSilent(media.getAudioTracks().length === 0);
      setPhase('ready');
    } catch (e) {
      if (id !== generation.current) return;
      releaseCamera();
      setPhase('idle');
      callbacks.current.onActiveChange(false);
      setError(e instanceof Error && e.name === 'NotAllowedError'
        ? 'Camera access was denied. Allow camera access in your browser, then try again.'
        : 'Could not open your camera. Check that it is connected and not being used by another app, then try again.');
    }
  }

  function startRecording() {
    if (!stream.current) return;
    const id = generation.current;
    const chunks: Blob[] = [];
    try {
      const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'].find(type => MediaRecorder.isTypeSupported(type));
      const capture = new MediaRecorder(stream.current, mimeType ? { mimeType } : undefined);
      recorder.current = capture;
      capture.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      capture.onerror = () => {
        if (id !== generation.current) return;
        discard();
        setError('Recording failed. Please try again.');
        setPhase('idle');
        callbacks.current.onActiveChange(false);
      };
      capture.onstop = () => {
        if (id !== generation.current) return;
        const durationMs = Date.now() - startedAt.current;
        const type = capture.mimeType || chunks[0]?.type || 'video/webm';
        const blob = new Blob(chunks, { type });
        recorder.current = null;
        releaseCamera();
        setPhase('idle');
        callbacks.current.onActiveChange(false);
        if (!blob.size) return setError('No video was captured. Please try again.');
        callbacks.current.onRecorded({
          uri: URL.createObjectURL(blob),
          fileName: `grapevine-step-${step + 1}-${Date.now()}.${type.includes('mp4') ? 'mp4' : 'webm'}`,
          mimeType: type.split(';')[0],
          durationMs,
        });
      };
      startedAt.current = Date.now();
      setElapsed(0);
      capture.start(250);
      setPhase('recording');
    } catch {
      discard();
      setPhase('idle');
      callbacks.current.onActiveChange(false);
      setError('Your browser could not start recording. Please try another browser.');
    }
  }

  return (
    <View style={styles.content}>
      {phase !== 'idle' && phase !== 'requesting' && (
        <View style={styles.camera}>
          <video ref={preview} autoPlay muted playsInline aria-label="Live camera preview" style={{ width: '100%', height: previewHeight, objectFit: 'contain', transform: 'scaleX(-1)', background: '#000' }} />
        </View>
      )}
      {(phase === 'ready' || phase === 'recording') && <Text style={styles.hint}>{silent ? 'Recording without sound. ' : ''}Keep your whole body in frame. Maximum 3 minutes.</Text>}
      {phase === 'recording' && <Text accessibilityLiveRegion="polite" style={styles.timer}>Recording {Math.floor(elapsed / 60)}:{String(Math.floor(elapsed % 60)).padStart(2, '0')}</Text>}
      <PrimaryButton
        label={phase === 'idle' ? (hasVideo ? 'Record again' : 'Record video') : phase === 'requesting' ? 'Opening camera…' : phase === 'ready' ? 'Start recording' : phase === 'saving' ? 'Saving video…' : 'Stop recording'}
        arrow={false}
        disabled={phase === 'requesting' || phase === 'saving'}
        onPress={() => {
          if (phase === 'idle') void enableCamera();
          else if (phase === 'ready') startRecording();
          else if (phase === 'recording') { setPhase('saving'); recorder.current?.stop(); }
        }}
      />
      {phase !== 'idle' && <Pressable accessibilityRole="button" onPress={() => { discard(); setPhase('idle'); callbacks.current.onActiveChange(false); }} style={styles.cancel}><Text style={styles.hint}>Cancel recording</Text></Pressable>}
      {error && <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { gap: 12 },
  camera: { overflow: 'hidden', borderRadius: 24 },
  hint: { fontSize: 13, lineHeight: 19, color: palette.secondary, textAlign: 'center' },
  timer: { fontSize: 18, color: palette.accent, fontWeight: '600', textAlign: 'center' },
  cancel: { padding: 12, borderRadius: radius.pill },
  error: { fontSize: 14, lineHeight: 20, color: '#C0392B' },
});
