import { Platform } from 'react-native';

import { supabase, supabaseConfigured } from '@/lib/supabase';

import { mockAnalyze } from './mock';
import type { AnalysisResult, DanceStep, PickedVideo, YouTubeImportResponse } from './types';

const API_URL = process.env.EXPO_PUBLIC_API_URL;

/** True until EXPO_PUBLIC_API_URL is set in .env. */
export const usingMockApi = !API_URL;

/**
 * Uploads the practice video and the reference to POST /analyze and returns the feedback.
 * A YouTube reference is already on the server, so only its saved filename is sent.
 * `onProgress` gets 0 to 1 as the upload goes; at 1 the server is analyzing.
 */
export async function analyze(
  reference: PickedVideo,
  practice: PickedVideo,
  onProgress?: (fraction: number) => void,
): Promise<AnalysisResult> {
  if (!API_URL) return mockAnalyze(practice);

  const body = new FormData();
  const savedYouTube = reference.youtube?.serverFilename;
  if (savedYouTube) body.append('reference_video', savedYouTube);
  else await appendVideo(body, 'reference', reference);
  await appendVideo(body, 'practice', practice);

  return postForm<AnalysisResult>(`${API_URL}/analyze`, body, onProgress);
}

/**
 * Asks the backend to download a YouTube video or Short (POST /reference-videos).
 * The backend also runs pose extraction before answering, so this can take minutes.
 */
export async function importYouTube(url: string): Promise<YouTubeImportResponse> {
  if (!API_URL) throw new Error('Connect the backend (EXPO_PUBLIC_API_URL) to import YouTube links.');

  const controller = new AbortController();
  // Matches the backend's 10-minute pose-processing limit, plus download time.
  const timer = setTimeout(() => controller.abort(), 12 * 60 * 1000);
  try {
    const response = await fetch(`${API_URL}/reference-videos`, {
      method: 'POST',
      // The login token lets the backend save the dance under this user in Supabase.
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(errorMessage(text, response.status));
    return JSON.parse(text) as YouTubeImportResponse;
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('The import timed out. Try a shorter video.');
    if (e instanceof TypeError) throw new Error(unreachable());
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  if (!supabaseConfigured) return {};
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// fetch() can't report upload progress, so this uses XMLHttpRequest,
// which works the same in React Native and the browser.
function postForm<T>(
  url: string,
  body: FormData,
  onProgress?: (fraction: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.timeout = 5 * 60 * 1000;

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(errorMessage(xhr.responseText, xhr.status)));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as T);
      } catch {
        reject(new Error('The server sent back something that is not JSON.'));
      }
    };
    xhr.onerror = () => reject(new Error(unreachable()));
    xhr.ontimeout = () => reject(new Error('The upload timed out.'));

    xhr.send(body);
  });
}

function unreachable(): string {
  return (
    `Couldn't reach ${API_URL}. Is the backend running with --host 0.0.0.0, ` +
    'and is your phone on the same Wi-Fi?'
  );
}

// The backend uses two error shapes: FastAPI's {"detail": "..."} and
// Rodrigo's {"error": {"code": "...", "message": "..."}}.
function errorMessage(responseText: string, status: number): string {
  try {
    const body = JSON.parse(responseText);
    if (typeof body?.error?.message === 'string') return body.error.message;
    if (typeof body?.detail === 'string') return body.detail;
  } catch {
    // fall through to the generic message
  }
  return `Request failed (${status}).`;
}

async function appendVideo(body: FormData, field: string, video: PickedVideo) {
  if (Platform.OS === 'web') {
    // In the browser the picked uri is a blob: URL, so read it into a real Blob.
    const blob = await (await fetch(video.uri)).blob();
    body.append(field, blob, video.fileName);
    return;
  }
  // React Native's FormData takes a { uri, name, type } object for file uploads.
  body.append(field, {
    uri: video.uri,
    name: video.fileName,
    type: video.mimeType,
  } as unknown as Blob);
}

/** URL the video player can stream a backend-saved video from (GET /videos/{filename}). */
export function savedVideoUrl(filename: string): string | null {
  return API_URL ? `${API_URL}/videos/${encodeURIComponent(filename)}` : null;
}

/**
 * Save steps edited in the app: cuts moved, steps split or merged (PUT /dances/{id}/steps).
 * Returns the steps with fresh pace and body-part labels.
 */
export async function updateSteps(
  danceId: string,
  steps: { start_ms: number; end_ms: number; source: number | null }[],
  savedCount: number,
): Promise<DanceStep[]> {
  if (!API_URL) throw new Error('Connect the backend (EXPO_PUBLIC_API_URL) to save steps.');
  let response: Response;
  try {
    response = await fetch(`${API_URL}/dances/${encodeURIComponent(danceId)}/steps`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      // source: which saved step (by position) each step continues, so it keeps its id; null for a new step.
      body: JSON.stringify({
        steps: steps.map(({ start_ms, end_ms, source }) => ({ start_ms, end_ms, source })),
        saved_count: savedCount,
      }),
    });
  } catch {
    throw new Error(unreachable());
  }
  const text = await response.text();
  if (!response.ok) throw new Error(errorMessage(text, response.status));
  return (JSON.parse(text) as { steps: DanceStep[] }).steps;
}
