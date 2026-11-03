import Ionicons from '@expo/vector-icons/Ionicons';
import { useEvent } from 'expo';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useRef, useState } from 'react';
import { Image, PanResponder, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { updateSteps } from '@/api/client';
import type { DanceStep } from '@/api/types';
import { PrimaryButton } from '@/components/primary-button';
import { colors, radius } from '@/theme';

type Props = {
  /** Streamable video URL; null shows the thumbnail only (mock mode). */
  source: string | null;
  thumbnail: string;
  steps: DanceStep[];
  durationMs: number | null;
  /** Supabase dance id; when set (and there is a video), step boundaries can be edited and saved. */
  danceId?: string | null;
  /** Called with the saved steps after an edit is saved. */
  onStepsSaved?: (steps: DanceStep[]) => void;
};

const SEGMENT_COLORS = { slow: '#E3CDB6', medium: colors.accentSoft, fast: colors.accent } as const;
const INTENSITY = { slow: 'Slow', medium: 'Medium', fast: 'Fast' } as const;
// Treat times this close to a boundary as being on it (players report time in ~0.05 s steps).
const EPSILON = 0.06;
// Shortest step allowed while editing; the backend enforces the same.
const MIN_STEP_MS = 200;
const NUDGE_MS = 100;

/** A step while editing: source is the saved step (by position) it continues, null for a new one. */
type DraftStep = DanceStep & { source: number | null; key: string };
let draftKey = 0;
const toDraft = (steps: DanceStep[]): DraftStep[] =>
  steps.map((s, i) => ({ ...s, source: i, key: `d${draftKey++}` }));

/**
 * Video preview of an uploaded dance with its segmentation: a timeline marks where each step
 * starts and stops, tapping a step plays just that step, and "Pause after each step" stops the
 * video at every boundary. In edit mode the boundaries become draggable handles, a step can be
 * split at any frame, and removing a cut merges the two steps around it.
 */
export function StepPlayer({ source, thumbnail, steps: initialSteps, durationMs, danceId, onStepsSaved }: Props) {
  const player = useVideoPlayer(source, (p) => {
    p.timeUpdateEventInterval = 0.05;
    p.loop = false;
  });
  const { currentTime } = useEvent(player, 'timeUpdate', {
    currentTime: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });
  const { isPlaying } = useEvent(player, 'playingChange', { isPlaying: false });

  const [savedSteps, setSavedSteps] = useState(initialSteps);
  const [draft, setDraft] = useState<DraftStep[] | null>(null); // non-null while editing
  const [selected, setSelected] = useState(0); // boundary index while editing (between step i and i+1)
  // While editing, the video shows either the selected cut or a point picked on the timeline (to split at).
  const [point, setPoint] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const steps: (DanceStep & { key?: string })[] = draft ?? savedSteps;
  const editing = draft !== null;
  const canEdit = Boolean(source && danceId && savedSteps.length > 0);
  const hasCuts = editing && draft.length > 1;

  const [pauseEachStep, setPauseEachStep] = useState(true);
  const stopAt = useRef<number | null>(null);
  // After stopping at a boundary the video sits on the next step's first frame;
  // keep showing the step that just finished until playback resumes.
  const [heldStep, setHeldStep] = useState<number | null>(null);

  const totalSeconds = Math.max(
    (durationMs ?? 0) / 1000,
    player.duration || 0,
    steps.length ? steps[steps.length - 1].end_ms / 1000 : 0,
    0.001,
  );
  const stepAt = (t: number) =>
    steps.findIndex((s) => t + EPSILON >= s.start_ms / 1000 && t + EPSILON < s.end_ms / 1000);
  const playingStep = stepAt(currentTime);
  const active = !isPlaying && heldStep !== null ? heldStep : playingStep;

  // Stop at the end of the current step, either because one step was tapped
  // or because "Pause after each step" is on.
  useEffect(() => {
    if (!source || !isPlaying) return;
    if (heldStep !== null) setHeldStep(null);
    if (stopAt.current === null && pauseEachStep && playingStep >= 0) {
      stopAt.current = steps[playingStep].end_ms / 1000;
    }
    if (stopAt.current !== null && currentTime >= stopAt.current - EPSILON) {
      const boundary = stopAt.current;
      const finished = steps.findIndex((step) => Math.abs(step.end_ms / 1000 - boundary) < 0.001);
      player.pause();
      setHeldStep(finished >= 0 ? finished : null);
      // Land exactly on the boundary so the next play continues with the next step.
      player.currentTime = boundary;
      stopAt.current = null;
    }
  }, [currentTime, isPlaying, pauseEachStep, playingStep, heldStep, source, steps, player]);

  function playStep(index: number) {
    if (!source) return;
    const step = steps[index];
    player.currentTime = step.start_ms / 1000;
    stopAt.current = step.end_ms / 1000;
    player.play();
  }

  function togglePlay() {
    if (!source) return;
    if (isPlaying) {
      player.pause();
      return;
    }
    if (currentTime >= totalSeconds - EPSILON) player.currentTime = 0;
    stopAt.current = null;
    player.play();
  }

  function restart() {
    if (!source) return;
    setHeldStep(null);
    player.pause();
    stopAt.current = null;
    player.currentTime = 0;
  }

  // --- editing ---------------------------------------------------------------

  function startEditing() {
    player.pause();
    stopAt.current = null;
    setHeldStep(null);
    setEditError(null);
    setDraft(toDraft(savedSteps));
    setSelected(0);
    measureTimeline();
    if (savedSteps.length > 1) {
      setPoint(null);
      player.currentTime = savedSteps[0].end_ms / 1000;
    } else {
      pickPoint((savedSteps[0].start_ms + savedSteps[0].end_ms) / 2);
    }
  }

  /** Where boundary i may go: both neighbouring steps stay at least MIN_STEP_MS long. */
  function clampBoundary(index: number, ms: number): number {
    if (!draft) return ms;
    const low = draft[index].start_ms + MIN_STEP_MS;
    const high = draft[index + 1].end_ms - MIN_STEP_MS;
    return Math.round(Math.min(high, Math.max(low, ms)));
  }

  /** Move boundary i (end of step i, start of step i+1) and, if asked, show the frame at the new cut. */
  function moveBoundary(index: number, ms: number, seek = true) {
    const value = clampBoundary(index, ms);
    setDraft((current) => {
      if (!current || value === current[index].end_ms) return current;
      const next = current.map((s) => ({ ...s }));
      next[index].end_ms = value;
      next[index + 1].start_ms = value;
      return next;
    });
    setPoint(null);
    if (seek) seekPreview(value);
  }

  function seekPreview(ms: number) {
    player.pause();
    player.currentTime = ms / 1000;
  }

  function selectCut(index: number) {
    if (!draft || index < 0 || index > draft.length - 2) return;
    setSelected(index);
    setPoint(null);
    seekPreview(draft[index].end_ms);
  }

  function nudge(deltaMs: number) {
    if (!draft) return;
    if (point !== null) pickPoint(point + deltaMs);
    else moveBoundary(selected, draft[selected].end_ms + deltaMs);
  }

  /** Show the frame at ms as the place to split (kept inside the steps). */
  function pickPoint(ms: number, seek = true) {
    const list = latest.current.draft ?? savedSteps;
    if (!list.length) return;
    const value = Math.round(Math.min(list[list.length - 1].end_ms, Math.max(list[0].start_ms, ms)));
    setPoint(value);
    if (seek) seekPreview(value);
  }

  // Splitting needs both halves to be at least MIN_STEP_MS long.
  const splitIndex =
    editing && point !== null
      ? draft.findIndex((s) => point >= s.start_ms + MIN_STEP_MS && point <= s.end_ms - MIN_STEP_MS)
      : -1;

  function split() {
    if (!draft || point === null || splitIndex < 0) return;
    const step = draft[splitIndex];
    const left: DraftStep = { ...step, end_ms: point };
    const right: DraftStep = { ...step, start_ms: point, source: null, key: `d${draftKey++}` };
    setDraft([...draft.slice(0, splitIndex), left, right, ...draft.slice(splitIndex + 1)]);
    setSelected(splitIndex);
    setPoint(null);
    seekPreview(point);
  }

  /** Remove cut i: steps i and i+1 become one, keeping the saved id of the first (or the second if the first is new). */
  function removeCut(index: number) {
    if (!draft || index < 0 || index > draft.length - 2) return;
    const [a, b] = [draft[index], draft[index + 1]];
    const merged: DraftStep = { ...a, end_ms: b.end_ms, source: a.source ?? b.source };
    const next = [...draft.slice(0, index), merged, ...draft.slice(index + 2)];
    setDraft(next);
    const nextSelected = Math.max(0, Math.min(index, next.length - 2));
    setSelected(nextSelected);
    if (next.length > 1) {
      setPoint(null);
      seekPreview(next[nextSelected].end_ms);
    } else {
      setPoint(a.end_ms);
      seekPreview(a.end_ms);
    }
  }

  const changed =
    editing &&
    (draft.length !== savedSteps.length ||
      draft.some(
        (s, i) => s.source !== i || s.start_ms !== savedSteps[i].start_ms || s.end_ms !== savedSteps[i].end_ms,
      ));

  async function save() {
    if (!draft || !danceId) return;
    setSaving(true);
    setEditError(null);
    try {
      const updated = await updateSteps(danceId, draft, savedSteps.length);
      setSavedSteps(updated);
      setDraft(null);
      setPoint(null);
      onStepsSaved?.(updated);
    } catch (e) {
      setEditError(e instanceof Error ? e.message : 'Saving failed.');
    } finally {
      setSaving(false);
    }
  }

  // --- layout ----------------------------------------------------------------

  const [timelineWidth, setTimelineWidth] = useState(0);
  const timelineRef = useRef<View>(null);
  const timelinePageX = useRef(0);
  const measureTimeline = () =>
    timelineRef.current?.measureInWindow((x, _y, width) => {
      timelinePageX.current = x;
      if (width) setTimelineWidth(width);
    });

  // While editing, the whole timeline takes the drag: it grabs the cut nearest the press and follows
  // the finger's absolute position, so the drag keeps working even if the finger slides off the handle.
  const msPerPx = timelineWidth ? (totalSeconds * 1000) / timelineWidth : 0;
  // index: the cut being dragged; 'point' when scrubbing the split point instead.
  const drag = useRef({ index: null as number | 'point' | null, lastSeek: 0 });
  const latest = useRef({ editing, draft, msPerPx, moveBoundary, pickPoint, select: (i: number) => setSelected(i) });
  latest.current = { editing, draft, msPerPx, moveBoundary, pickPoint, select: (i: number) => setSelected(i) };
  const timelineResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => latest.current.editing,
      onStartShouldSetPanResponderCapture: () => latest.current.editing,
      onMoveShouldSetPanResponder: () => latest.current.editing,
      onMoveShouldSetPanResponderCapture: () => latest.current.editing,
      // Keep the drag even if the surrounding card tries to scroll.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (_e, gesture) => {
        const { draft: current, msPerPx: scale } = latest.current;
        drag.current.index = null;
        if (!current || !scale) return;
        const pressMs = (gesture.x0 - timelinePageX.current) * scale;
        let best = -1;
        let bestPx = Infinity;
        current.slice(0, -1).forEach((step, i) => {
          const px = Math.abs(step.end_ms - pressMs) / scale;
          if (px < bestPx) [best, bestPx] = [i, px];
        });
        // Grab a cut within 28px, less on narrow steps so the middle of a short step can still be picked.
        const inside = current.find((step) => pressMs >= step.start_ms && pressMs < step.end_ms);
        const widthPx = inside ? (inside.end_ms - inside.start_ms) / scale : Infinity;
        if (best >= 0 && bestPx <= Math.min(28, Math.max(6, widthPx * 0.3))) {
          drag.current.index = best;
          latest.current.select(best);
        } else {
          // Away from a cut: pick the frame there (a place to split) and scrub it while dragging.
          drag.current.index = 'point';
          drag.current.lastSeek = Date.now();
          latest.current.pickPoint(pressMs);
        }
      },
      onPanResponderMove: (_e, gesture) => {
        const index = drag.current.index;
        if (index === null) return;
        // Move the cut on every event, but seek the video at most ~12 times a second.
        const now = Date.now();
        const seek = now - drag.current.lastSeek >= 80;
        if (seek) drag.current.lastSeek = now;
        const ms = (gesture.moveX - timelinePageX.current) * latest.current.msPerPx;
        if (index === 'point') latest.current.pickPoint(ms, seek);
        else latest.current.moveBoundary(index, ms, seek);
      },
      onPanResponderRelease: (_e, gesture) => {
        const index = drag.current.index;
        const current = latest.current.draft;
        if (index === 'point') {
          if (gesture.moveX !== 0) latest.current.pickPoint((gesture.moveX - timelinePageX.current) * latest.current.msPerPx);
        } else if (index !== null && current) {
          // A tap (no movement) only selects the cut and shows its frame; a drag ends where the finger lifts.
          const ms = gesture.moveX === 0 ? current[index].end_ms : (gesture.moveX - timelinePageX.current) * latest.current.msPerPx;
          latest.current.moveBoundary(index, ms, true);
        }
        drag.current.index = null;
      },
    }),
  ).current;
  const pct = (seconds: number) => `${Math.min(100, Math.max(0, (seconds / totalSeconds) * 100))}%` as const;
  const firstStart = steps.length ? steps[0].start_ms / 1000 : 0;
  const lastEnd = steps.length ? steps[steps.length - 1].end_ms / 1000 : 0;

  return (
    <View style={styles.container}>
      <View style={styles.video}>
        {source ? (
          // Explicit 100% size: on web a <video> ignores absolute edges and keeps its own size.
          <VideoView player={player} style={styles.videoView} contentFit="contain" nativeControls={false} />
        ) : (
          <Image source={{ uri: thumbnail }} style={StyleSheet.absoluteFill} resizeMode="cover" />
        )}
        {editing ? (
          (point !== null || hasCuts) && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {point !== null
                  ? `Split point: ${formatSeconds(point)}`
                  : `Cut ${selected + 1}: ${formatSeconds(draft[selected].end_ms)}`}
              </Text>
            </View>
          )
        ) : (
          active >= 0 && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                Step {active + 1} of {steps.length}
              </Text>
            </View>
          )
        )}
      </View>

      {steps.length > 0 && (
        <View>
          {/* Timeline: one segment per step; the gaps between segments are the stop points. */}
          <View
            ref={timelineRef}
            style={[styles.timeline, editing && styles.timelineEditing]}
            onLayout={measureTimeline}
            {...(editing ? timelineResponder.panHandlers : {})}
            accessibilityLabel={`Timeline with ${steps.length} steps`}
          >
            {firstStart > 0 && <View style={[styles.filler, { left: 0, width: pct(firstStart) }]} />}
            {lastEnd < totalSeconds && (
              <View style={[styles.filler, { left: pct(lastEnd), width: pct(totalSeconds - lastEnd) }]} />
            )}
            {steps.map((step, index) => (
              <Pressable
                key={step.key ?? step.step_index}
                onPress={() => (editing ? undefined : playStep(index))}
                disabled={editing}
                accessibilityLabel={`Play step ${index + 1}`}
                style={[
                  styles.segment,
                  {
                    left: pct(step.start_ms / 1000),
                    width: pct((step.end_ms - step.start_ms) / 1000),
                  },
                ]}
              >
                <View
                  style={[
                    styles.segmentFill,
                    { backgroundColor: SEGMENT_COLORS[step.intensity] },
                    !editing && index === active && styles.activeSegment,
                  ]}
                />
              </Pressable>
            ))}
            {source && !editing && (
              <View pointerEvents="none" style={[styles.playhead, { left: pct(currentTime) }]} />
            )}
            {editing && point !== null && (
              <View pointerEvents="none" style={[styles.splitMarker, { left: pct(point / 1000) }]}>
                <Ionicons name="cut" size={14} color={colors.text} style={styles.splitIcon} />
                <View style={styles.splitLine} />
              </View>
            )}
            {editing &&
              draft.slice(0, -1).map((step, index) => (
                <View
                  key={step.key}
                  pointerEvents="none"
                  accessibilityLabel={`Boundary between step ${index + 1} and ${index + 2}`}
                  style={[styles.handle, { left: pct(step.end_ms / 1000) }]}
                >
                  <View style={[styles.handleBar, point === null && index === selected && styles.handleBarSelected]} />
                  <View style={[styles.handleKnob, point === null && index === selected && styles.handleKnobSelected]} />
                </View>
              ))}
          </View>
          <View style={styles.timeRow}>
            <Text style={styles.time}>{formatSeconds(currentTime * 1000)}</Text>
            <Text style={styles.time}>{formatSeconds(totalSeconds * 1000)}</Text>
          </View>
        </View>
      )}

      {editing ? (
        <View style={styles.editPanel}>
          <Text style={styles.editHint}>
            Drag a handle to move a cut. Tap anywhere else on the timeline to pick a frame, then Split to make a new
            step there. Remove cut joins the two steps around it.
          </Text>
          <View style={styles.nudgeRow}>
            {hasCuts ? (
              <>
            <Pressable
              onPress={() => selectCut(selected - 1)}
              disabled={selected === 0}
              style={[styles.cutArrow, selected === 0 && styles.linkDisabled]}
              accessibilityLabel="Previous cut"
            >
              <Ionicons name="chevron-back" size={18} color={colors.text} />
            </Pressable>
            <Text style={styles.nudgeLabel}>
              {point !== null ? 'Split point' : `Cut ${selected + 1} of ${draft.length - 1}`}
            </Text>
            <Pressable
              onPress={() => selectCut(selected + 1)}
              disabled={selected >= draft.length - 2}
              style={[styles.cutArrow, selected >= draft.length - 2 && styles.linkDisabled]}
              accessibilityLabel="Next cut"
            >
              <Ionicons name="chevron-forward" size={18} color={colors.text} />
            </Pressable>
              </>
            ) : (
              <Text style={styles.nudgeLabel}>Split point</Text>
            )}
            <Pressable
              onPress={() => nudge(-NUDGE_MS)}
              disabled={point === null && !hasCuts}
              style={styles.nudgeButton}
              accessibilityLabel={point !== null ? 'Move split point earlier' : 'Move cut earlier'}
            >
              <Text style={styles.nudgeText}>−0.1s</Text>
            </Pressable>
            <Pressable
              onPress={() => nudge(NUDGE_MS)}
              disabled={point === null && !hasCuts}
              style={styles.nudgeButton}
              accessibilityLabel={point !== null ? 'Move split point later' : 'Move cut later'}
            >
              <Text style={styles.nudgeText}>+0.1s</Text>
            </Pressable>
          </View>
          <View style={styles.structureRow}>
            <Pressable
              onPress={split}
              disabled={splitIndex < 0}
              style={[styles.structureButton, splitIndex < 0 && styles.linkDisabled]}
              accessibilityLabel="Split step here"
            >
              <Ionicons name="cut-outline" size={16} color={colors.text} />
              <Text style={styles.structureText}>
                {point !== null ? `Split at ${formatSeconds(point)}` : 'Split'}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => removeCut(selected)}
              disabled={point !== null || !hasCuts}
              style={[styles.structureButton, (point !== null || !hasCuts) && styles.linkDisabled]}
              accessibilityLabel="Remove cut"
            >
              <Ionicons name="git-merge-outline" size={16} color={colors.text} />
              <Text style={styles.structureText}>{hasCuts && point === null ? `Remove cut ${selected + 1}` : 'Remove cut'}</Text>
            </Pressable>
          </View>
          {point !== null && splitIndex < 0 && (
            <Text style={styles.editHint}>Pick a spot at least 0.2s away from a cut to split there.</Text>
          )}
          {editError && <Text style={styles.editError}>{editError}</Text>}
          <PrimaryButton label="Save steps" onPress={save} loading={saving} disabled={!changed} arrow={false} />
          <View style={styles.editLinks}>
            <Pressable
              onPress={() => {
                setDraft(toDraft(savedSteps));
                setSelected(0);
                setPoint(null);
                if (savedSteps.length > 1) seekPreview(savedSteps[0].end_ms);
              }}
              disabled={!changed || saving}
            >
              <Text style={[styles.link, (!changed || saving) && styles.linkDisabled]}>Undo changes</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setDraft(null);
                setPoint(null);
              }}
              disabled={saving}
            >
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        source && (
          <View style={styles.controls}>
            <Pressable onPress={restart} hitSlop={8} accessibilityLabel="Back to start" style={styles.iconButton}>
              <Ionicons name="play-skip-back" size={18} color={colors.text} />
            </Pressable>
            <Pressable onPress={togglePlay} accessibilityLabel={isPlaying ? 'Pause' : 'Play'} style={styles.playButton}>
              <Ionicons name={isPlaying ? 'pause' : 'play'} size={22} color={colors.onPrimary} />
            </Pressable>
            {canEdit && (
              <Pressable onPress={startEditing} accessibilityLabel="Edit steps" style={styles.editButton}>
                <Ionicons name="cut-outline" size={16} color={colors.text} />
                <Text style={styles.editButtonText}>Edit</Text>
              </Pressable>
            )}
            <View style={styles.toggle}>
              <Text style={styles.toggleText}>Pause after each step</Text>
              <Switch
                value={pauseEachStep}
                onValueChange={(on) => {
                  setPauseEachStep(on);
                  stopAt.current = null;
                }}
                trackColor={{ true: colors.accentSoft, false: colors.hairline }}
                thumbColor={colors.surface}
              />
            </View>
          </View>
        )
      )}

      <View style={styles.steps}>
        {steps.map((step, index) => {
          const focus = step.focus.map((part) => part[0].toUpperCase() + part.slice(1)).join(' + ');
          const current = !editing && index === active;
          return (
            <Pressable
              key={step.key ?? step.step_index}
              onPress={() => playStep(index)}
              disabled={!source || editing}
              style={({ pressed }) => [styles.stepRow, current && styles.stepRowActive, pressed && styles.pressed]}
            >
              <View style={[styles.stepNumber, current && styles.stepNumberActive]}>
                <Text style={[styles.stepNumberText, current && styles.stepNumberTextActive]}>{index + 1}</Text>
              </View>
              <View style={styles.stepText}>
                <Text style={styles.stepTime}>
                  {formatSeconds(step.start_ms)} to {formatSeconds(step.end_ms)}
                </Text>
                <Text style={styles.stepDetail}>
                  {editing
                    ? (step as DraftStep).source === null
                      ? 'New step · labels update after saving'
                      : 'Labels update after saving'
                    : `${INTENSITY[step.intensity]}${focus ? ` · ${focus}` : ''}`}
                </Text>
              </View>
              {source && !editing && (
                <Ionicons name={current && isPlaying ? 'pause-circle' : 'play-circle'} size={26} color={colors.accent} />
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

// Steps are short, so show tenths: 1.5s, 1:02.3
export function formatSeconds(ms: number): string {
  const total = ms / 1000;
  const minutes = Math.floor(total / 60);
  const rest = (total - minutes * 60).toFixed(1);
  return minutes > 0 ? `${minutes}:${rest.padStart(4, '0')}` : `${rest}s`;
}

const styles = StyleSheet.create({
  container: { gap: 12 },
  video: { height: 360, borderRadius: radius.md, overflow: 'hidden', backgroundColor: colors.primary },
  videoView: { width: '100%', height: '100%' },
  badge: {
    position: 'absolute',
    left: 10,
    top: 10,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  badgeText: { color: colors.onPrimary, fontSize: 13, fontWeight: '600' },
  timeline: { height: 22 },
  timelineEditing: { height: 34, marginTop: 18, marginBottom: 4 },
  filler: { position: 'absolute', top: 0, bottom: 0, borderRadius: 4, backgroundColor: colors.hairline },
  segment: { position: 'absolute', top: 0, bottom: 0, paddingHorizontal: 1 },
  segmentFill: { flex: 1, borderRadius: 4 },
  activeSegment: { borderWidth: 2, borderColor: colors.text },
  playhead: {
    position: 'absolute',
    top: -4,
    bottom: -4,
    width: 3,
    marginLeft: -1.5,
    borderRadius: 2,
    backgroundColor: colors.text,
  },
  handle: {
    position: 'absolute',
    top: -8,
    bottom: -8,
    width: 32,
    marginLeft: -16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  handleBar: { position: 'absolute', top: 4, bottom: 4, width: 2, borderRadius: 1, backgroundColor: colors.muted },
  handleBarSelected: { top: 0, bottom: 0, width: 3, backgroundColor: colors.accent },
  handleKnob: {
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
    borderColor: colors.surface,
    backgroundColor: colors.muted,
  },
  handleKnobSelected: { width: 20, height: 20, borderRadius: 10, borderWidth: 3, backgroundColor: colors.accent },
  splitMarker: { position: 'absolute', top: -20, bottom: -4, width: 20, marginLeft: -10, alignItems: 'center' },
  splitIcon: { height: 16 },
  splitLine: { flex: 1, width: 2, borderRadius: 1, backgroundColor: colors.text },
  structureRow: { flexDirection: 'row', gap: 8 },
  structureButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 9,
    borderRadius: radius.sm,
    backgroundColor: colors.pill,
  },
  structureText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  time: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  controls: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  playButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingLeft: 2,
  },
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 40,
    paddingHorizontal: 12,
    borderRadius: 20,
    backgroundColor: colors.surface,
  },
  editButtonText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  toggle: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 8 },
  toggleText: { color: colors.text, fontSize: 13, flexShrink: 1, textAlign: 'right' },
  editPanel: { gap: 10, padding: 12, borderRadius: radius.md, backgroundColor: colors.surface },
  editHint: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  nudgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cutArrow: {
    width: 32,
    height: 34,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.pill,
  },
  nudgeLabel: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  nudgeButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.pill,
  },
  nudgeText: { color: colors.accent, fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },
  editError: { color: colors.bad, fontSize: 13, lineHeight: 18 },
  editLinks: { flexDirection: 'row', justifyContent: 'space-around' },
  link: { color: colors.accent, fontSize: 15, fontWeight: '600' },
  linkDisabled: { opacity: 0.4 },
  steps: { gap: 8 },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    borderWidth: 1.5,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
  },
  stepRowActive: { borderColor: colors.accentSoft },
  pressed: { opacity: 0.7 },
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumberActive: { backgroundColor: colors.accent },
  stepNumberText: { color: colors.pillText, fontSize: 13, fontWeight: '700' },
  stepNumberTextActive: { color: colors.onPrimary },
  stepText: { flex: 1, gap: 1 },
  stepTime: { color: colors.text, fontSize: 14, fontWeight: '600', fontVariant: ['tabular-nums'] },
  stepDetail: { color: colors.muted, fontSize: 13 },
});
