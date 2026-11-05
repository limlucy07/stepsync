// Helpers for showing dances saved in Supabase.
import type { DanceDetail, DanceSummary, PickedVideo } from '@/api/types';
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
