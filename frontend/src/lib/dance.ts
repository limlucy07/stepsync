// Helpers for showing dances saved in Supabase.
import type { DanceDetail, DanceStep, DanceSummary, PickedVideo } from '@/api/types';
import { parseYouTubeUrl, youtubeThumbnail } from '@/api/youtube';

export function danceVideoId(dance: DanceSummary): string | null {
  if (!dance.source_url) return null;
  const parsed = parseYouTubeUrl(dance.source_url);
  return 'videoId' in parsed ? parsed.videoId : null;
}

/** The YouTube thumbnail of the dance's source video, or null if it didn't come from YouTube. */
export function danceThumbnail(dance: DanceSummary): string | null {
  const id = danceVideoId(dance);
  return id ? youtubeThumbnail(id) : null;
}

/** 20500 -> "0:21" */
export function formatClock(ms: number | null): string {
  if (ms === null) return '–';
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/** A saved dance as the practice reference, the same shape a fresh upload gives. */
export function danceToVideo(dance: DanceDetail): PickedVideo {
  const parsed = dance.source_url ? parseYouTubeUrl(dance.source_url) : null;
  const videoId = parsed && 'videoId' in parsed ? parsed.videoId : '';
  return {
    uri: videoId ? youtubeThumbnail(videoId) : '',
    fileName: dance.video_path ?? `${dance.id}.mp4`,
    mimeType: 'video/mp4',
    durationMs: dance.duration_ms,
    youtube: {
      url: dance.source_url ?? '',
      videoId,
      isShort: Boolean(parsed && 'isShort' in parsed && parsed.isShort),
      title: dance.title,
      serverFilename: dance.video_available ? dance.video_path : null,
      steps: dance.steps,
    },
  };
}

const PACE: Record<DanceStep['intensity'], string> = { slow: 'Slow', medium: 'Medium', fast: 'Fast' };

/** "Fast", "Slow"… */
export function stepPace(step: DanceStep): string {
  return PACE[step.intensity] ?? 'Medium';
}

/** "Arms + Legs", or "Full body" when no part stands out. */
export function stepFocus(step: DanceStep): string {
  return step.focus.length ? step.focus.map((p) => p[0].toUpperCase() + p.slice(1)).join(' + ') : 'Full body';
}

/** 1500 -> "1.5s" */
export function formatStepLength(step: DanceStep): string {
  return `${((step.end_ms - step.start_ms) / 1000).toFixed(1)}s`;
}

/** What the user may do with step `index` given their progress on the dance. */
export function stepStatus(dance: DanceDetail, index: number): 'mastered' | 'current' | 'locked' {
  const step = dance.steps[index];
  if (step?.id && dance.progress.mastered_step_ids.includes(step.id)) return 'mastered';
  return index === dance.progress.current_step ? 'current' : index < dance.progress.current_step ? 'mastered' : 'locked';
}
