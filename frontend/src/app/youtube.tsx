import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { importYouTube, listDances, savedVideoUrl, usingMockApi } from '@/api/client';
import type { DanceStep, PickedVideo, YouTubeImportResponse, YouTubeSource } from '@/api/types';
import { parseYouTubeUrl, youtubeThumbnail } from '@/api/youtube';
import { PrimaryButton } from '@/components/primary-button';
import { StepPlayer } from '@/components/step-player';
import { useSession } from '@/state/session';
import { colors, radius } from '@/theme';

type Uploaded = { video: PickedVideo; result: YouTubeImportResponse };

/**
 * Paste a YouTube Short (or video) link, name the dance and upload it. The backend downloads it,
 * extracts the dancer's keypoints and saves them with motion features to Supabase.
 * Names are unique among the user's dances (ignoring capitals and extra spaces).
 *   ?from=home      opens the dance's step scene once it's saved
 *   ?from=practice  sets it as the reference and returns to Practice
 */
export default function UploadDanceScreen() {
  const router = useRouter();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const fromHome = from === 'home';
  const { setReference } = useSession();

  const [link, setLink] = useState('');
  const [name, setName] = useState('');
  // Names of the user's dances, to warn about a taken name before uploading (the backend checks too).
  const [taken, setTaken] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<Uploaded | null>(null);
  const alive = useRef(true);

  useEffect(() => () => void (alive.current = false), []);

  useEffect(() => {
    if (usingMockApi) return;
    listDances()
      .then((dances) => alive.current && setTaken(new Set(dances.filter((d) => d.mine).map((d) => nameKey(d.title)))))
      .catch(() => {}); // the backend still rejects a taken name
  }, []);

  // The backend downloads and runs pose extraction before answering; show how long it's been.
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, [busy]);

  const parsed = parseYouTubeUrl(link);
  const cleanName = name.replace(/\s+/g, ' ').trim();
  const nameTaken = taken.has(nameKey(cleanName));
  const nameError = nameTaken
    ? `You already have a dance called "${cleanName}". Pick a different name.`
    : cleanName.length > 80
      ? 'Keep the name under 80 characters.'
      : null;
  const nameOk = usingMockApi || (cleanName.length > 0 && !nameError);
  const valid = 'videoId' in parsed;
  const kind = valid && parsed.isShort ? 'YouTube Short' : 'YouTube video';

  function practice(video: PickedVideo) {
    setReference(video);
    router.back();
    router.navigate('/practice');
  }

  async function onUpload() {
    if (!valid || !nameOk || busy) return;
    setError(null);
    const url = `https://www.youtube.com/watch?v=${parsed.videoId}`;
    const base = { url, videoId: parsed.videoId, isShort: parsed.isShort };

    if (usingMockApi) {
      if (fromHome) {
        setError('Uploading needs the backend. Set EXPO_PUBLIC_API_URL in frontend/.env and restart Expo.');
        return;
      }
      // Practice can still be clicked through without a backend; nothing is downloaded.
      practice(toVideo({ ...base, title: kind, serverFilename: null }, null));
      return;
    }

    setBusy(true);
    setElapsed(0);
    try {
      const result = await importYouTube(url, cleanName);
      if (!alive.current) return;
      if (!result.persisted) throw new Error("The backend couldn't save that video.");
      const video = toVideo(
        {
          ...base,
          title: cleanName || result.filename.replace(/\.[^.]+$/, ''),
          serverFilename: result.filename,
          poseWarning: result.status === 'failed' ? (result.pose_error ?? 'Pose extraction failed.') : undefined,
          steps: result.steps ?? [],
        },
        result.metadata.duration_seconds * 1000,
      );
      if (fromHome && result.supabase_status === 'saved' && result.supabase_dance_id) {
        // Straight to the dance's step scene, starting on step 1.
        const id = result.supabase_dance_id;
        router.back();
        router.push({ pathname: '/dance/[id]', params: { id } });
      } else if (fromHome) setUploaded({ video, result });
      else practice(video);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const close = busy ? undefined : () => router.back();

  return (
    <Overlay title={uploaded ? undefined : 'Upload a dance'} onClose={close}>
      {uploaded ? (
        <UploadedView
          uploaded={uploaded}
          onPractice={() => practice(uploaded.video)}
          onAnother={() => {
            setUploaded(null);
            setLink('');
          }}
          onDone={() => router.back()}
          onStepsSaved={(steps) =>
            // Keep "Practice this dance" in sync with edited steps.
            setUploaded((current) =>
              current && current.video.youtube
                ? { ...current, video: { ...current.video, youtube: { ...current.video.youtube, steps } } }
                : current,
            )
          }
        />
      ) : (
        <>
          <Text style={styles.lead}>Paste a link to a YouTube Short of the dance you want to learn.</Text>

          <View style={[styles.field, !!link && !valid && parsed.error ? styles.fieldError : null]}>
            <Ionicons name="logo-youtube" size={20} color={colors.muted} />
            <TextInput
              value={link}
              onChangeText={(text) => {
                setLink(text);
                setError(null);
              }}
              placeholder="youtube.com/shorts/…"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              textContentType="URL"
              returnKeyType="go"
              onSubmitEditing={onUpload}
              editable={!busy}
              style={styles.input}
            />
          </View>
          {!valid && !!parsed.error && <Text style={styles.error}>{parsed.error}</Text>}

          {!usingMockApi && (
            <>
              <Text style={styles.label}>Dance name</Text>
              <View style={[styles.field, nameError ? styles.fieldError : null]}>
                <Ionicons name="musical-notes-outline" size={20} color={colors.muted} />
                <TextInput
                  value={name}
                  onChangeText={(text) => {
                    setName(text);
                    setError(null);
                  }}
                  placeholder="e.g. Perfect Night chorus"
                  placeholderTextColor={colors.muted}
                  autoCapitalize="words"
                  maxLength={100}
                  returnKeyType="go"
                  onSubmitEditing={onUpload}
                  editable={!busy}
                  accessibilityLabel="Dance name"
                  style={styles.input}
                />
              </View>
              {nameError && <Text style={styles.error}>{nameError}</Text>}
            </>
          )}

          {valid && (
            <View style={styles.preview}>
              <Image source={{ uri: youtubeThumbnail(parsed.videoId) }} style={styles.thumbnail} resizeMode="cover" />
              <View style={styles.badge}>
                <Ionicons name="logo-youtube" size={14} color={colors.onPrimary} />
                <Text style={styles.badgeText}>{kind}</Text>
              </View>
            </View>
          )}

          {error && <Text style={styles.error}>{error}</Text>}

          <View style={styles.uploadIcon}>
            <Ionicons name="cloud-upload-outline" size={36} color={valid ? colors.text : colors.border} />
          </View>
          <PrimaryButton label={busy ? 'Uploading…' : 'Upload'} onPress={onUpload} disabled={!valid || !nameOk} loading={busy} arrow={false} />
          {valid && !cleanName && !usingMockApi && <Text style={styles.note}>Give the dance a name to upload it.</Text>}

          {busy && (
            <Text style={styles.note}>
              Downloading the dance, mapping the dancer's movements and saving them. This usually takes under a
              minute ({formatClock(elapsed)} so far).
            </Text>
          )}
          {usingMockApi && !fromHome && (
            <Text style={styles.note}>Mock mode: the link is kept but not downloaded.</Text>
          )}
        </>
      )}
    </Overlay>
  );
}

/** Dimmed backdrop with a centered card, so the screen underneath stays visible. */
function Overlay({ title, onClose, children }: { title?: string; onClose?: () => void; children: React.ReactNode }) {
  return (
    <KeyboardAvoidingView style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle}>{title ?? ''}</Text>
          <Pressable
            onPress={onClose}
            disabled={!onClose}
            hitSlop={12}
            accessibilityLabel="Close"
            style={!onClose && styles.disabled}
          >
            <Ionicons name="close" size={24} color={colors.text} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.cardBody} keyboardShouldPersistTaps="handled" bounces={false}>
          {children}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

function UploadedView({
  uploaded: { video, result },
  onPractice,
  onAnother,
  onDone,
  onStepsSaved,
}: {
  uploaded: Uploaded;
  onPractice: () => void;
  onAnother: () => void;
  onDone: () => void;
  onStepsSaved: (steps: DanceStep[]) => void;
}) {
  const saved = result.supabase_status === 'saved';
  const yt = video.youtube!;
  const steps = yt.steps ?? [];
  return (
    <>
      <View style={styles.successHeader}>
        <View style={[styles.successIcon, !saved && styles.warnIcon]}>
          <Ionicons name={saved ? 'checkmark' : 'alert'} size={28} color={colors.onPrimary} />
        </View>
        <Text style={styles.successTitle}>{saved ? 'Dance uploaded' : 'Uploaded, not saved to Supabase'}</Text>
      </View>

      <Text style={styles.videoTitle} numberOfLines={2}>
        {yt.title}
      </Text>

      <View style={styles.stats}>
        <Stat label="Length" value={video.durationMs ? formatClock(Math.round(video.durationMs / 1000)) : '–'} />
        <Stat label="Steps" value={String(steps.length)} />
        <Stat label="Supabase" value={saved ? 'Saved' : 'Not saved'} />
      </View>

      {saved ? (
        <Text style={styles.note}>
          {result.frames_saved ?? 0} frames of keypoints, joint angles, movement speed and the steps below are
          stored in Supabase.
        </Text>
      ) : (
        <Text style={styles.warning}>{result.supabase_error ?? result.pose_error ?? 'Supabase save failed.'}</Text>
      )}

      <StepPlayer
        source={yt.serverFilename ? savedVideoUrl(yt.serverFilename) : null}
        thumbnail={youtubeThumbnail(yt.videoId)}
        steps={steps}
        durationMs={video.durationMs}
        danceId={saved ? result.supabase_dance_id : null}
        onStepsSaved={onStepsSaved}
      />

      <PrimaryButton label="Practice this dance" onPress={onPractice} />
      <View style={styles.secondaryRow}>
        <Pressable onPress={onAnother} hitSlop={8}>
          <Text style={styles.link}>Upload another</Text>
        </Pressable>
        <Pressable onPress={onDone} hitSlop={8}>
          <Text style={styles.link}>Done</Text>
        </Pressable>
      </View>
    </>
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

/** Names match ignoring capitals and extra spaces (same rule as the backend). */
function nameKey(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase();
}

function toVideo(youtube: YouTubeSource, durationMs: number | null): PickedVideo {
  return {
    uri: youtubeThumbnail(youtube.videoId),
    fileName: youtube.serverFilename ?? `${youtube.videoId}.mp4`,
    mimeType: 'video/mp4',
    durationMs,
    youtube,
  };
}

function formatClock(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    justifyContent: 'center',
    padding: 20,
    backgroundColor: 'rgba(20, 18, 16, 0.45)',
  },
  card: {
    maxHeight: '88%',
    borderRadius: 24,
    backgroundColor: colors.background,
    paddingTop: 18,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 22,
  },
  cardTitle: { color: colors.text, fontSize: 20, fontWeight: '700' },
  cardBody: { padding: 22, paddingTop: 14, gap: 14 },
  disabled: { opacity: 0.3 },
  uploadIcon: { alignItems: 'center', marginTop: 10 },
  lead: { color: colors.muted, fontSize: 15, lineHeight: 22 },
  label: { color: colors.text, fontSize: 14, fontWeight: '600', marginBottom: -6 },
  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    height: 54,
    paddingHorizontal: 16,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  fieldError: { borderColor: colors.bad },
  input: { flex: 1, height: '100%', color: colors.text, fontSize: 16 },
  preview: { borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.primary },
  thumbnail: { width: '100%', aspectRatio: 16 / 9 },
  badge: {
    position: 'absolute',
    left: 10,
    bottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  badgeText: { color: colors.onPrimary, fontSize: 13, fontWeight: '600' },
  error: { color: colors.bad, fontSize: 14, lineHeight: 20 },
  warning: { color: colors.okay, fontSize: 14, lineHeight: 20 },
  note: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: 'center' },

  successHeader: { alignItems: 'center', gap: 10, marginTop: 8 },
  successIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.good,
    alignItems: 'center',
    justifyContent: 'center',
  },
  warnIcon: { backgroundColor: colors.okay },
  successTitle: { color: colors.text, fontSize: 22, fontWeight: '700', textAlign: 'center' },
  videoTitle: { color: colors.text, fontSize: 16, fontWeight: '600' },
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
  secondaryRow: { flexDirection: 'row', justifyContent: 'space-around', paddingTop: 4 },
  link: { color: colors.accent, fontSize: 15, fontWeight: '600' },
});
