import { useEvent } from 'expo';
import { useFocusEffect } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useState } from 'react';
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

type Props = {
  /** URL of the whole dance video, or null when it can't be played here (then the thumbnail shows). */
  source: string | null;
  thumbnail?: string | null;
  startMs: number;
  endMs: number;
  muted?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

/**
 * Plays one step of a dance on a loop: from startMs to endMs, then back to startMs.
 * Pauses while its screen isn't showing, and never takes over the audio session, so it doesn't
 * fight the camera (on iOS a playing video can keep the camera from starting).
 */
export function StepClip({ source, thumbnail, startMs, endMs, muted = false, style, testID }: Props) {
  const player = useVideoPlayer(source, (p) => {
    p.timeUpdateEventInterval = 0.05;
    p.muted = muted;
    p.audioMixingMode = 'mixWithOthers';
  });
  const [focused, setFocused] = useState(true);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const { currentTime } = useEvent(player, 'timeUpdate', {
    currentTime: 0,
    currentLiveTimestamp: null,
    currentOffsetFromLive: null,
    bufferedPosition: 0,
  });

  // Start (again) at the beginning of the step whenever the step changes or the screen comes back.
  useEffect(() => {
    if (!source) return;
    if (!focused) {
      player.pause();
      return;
    }
    player.currentTime = startMs / 1000;
    player.play();
  }, [player, source, startMs, endMs, focused]);

  useEffect(() => {
    player.muted = muted;
  }, [player, muted]);

  useEffect(() => {
    if (!source || !focused) return;
    if (currentTime >= endMs / 1000 || currentTime < startMs / 1000 - 0.25) {
      player.currentTime = startMs / 1000;
      if (!player.playing) player.play();
    }
  }, [currentTime, player, source, startMs, endMs, focused]);

  return (
    <View testID={testID} style={[styles.frame, style]}>
      {source ? (
        <VideoView
          player={player}
          style={styles.fill}
          contentFit="contain"
          nativeControls={false}
        />
      ) : thumbnail ? (
        <Image source={{ uri: thumbnail }} style={styles.fill} resizeMode="cover" />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: '#000', overflow: 'hidden' },
  fill: { width: '100%', height: '100%' },
});
