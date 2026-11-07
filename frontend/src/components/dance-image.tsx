import Ionicons from '@expo/vector-icons/Ionicons';
import { Image, StyleSheet, View } from 'react-native';

import type { DanceSummary } from '@/api/types';
import { danceThumbnail } from '@/lib/dance';
import { colors } from '@/theme';

/** YouTube thumbnail of a dance filling its parent, or a plain tile with an icon when it has none. */
export function DanceImage({ dance }: { dance: DanceSummary }) {
  const uri = danceThumbnail(dance);
  return (
    <View style={[StyleSheet.absoluteFill, styles.empty]}>
      <Ionicons name="musical-notes" size={24} color={colors.accentSoft} />
      {uri && <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" />}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { backgroundColor: colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
});
