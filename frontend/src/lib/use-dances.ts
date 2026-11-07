import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { listDances, usingMockApi } from '@/api/client';
import type { DanceSummary } from '@/api/types';

/** Dances from Supabase (through the backend), reloaded whenever the screen comes back into view. */
export function useDances() {
  const [dances, setDances] = useState<DanceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (usingMockApi) return;
    setLoading(true);
    try {
      setDances(await listDances());
      setError(null);
    } catch (e) {
      // Keep showing the last list if a refresh fails.
      setError(e instanceof Error ? e.message : 'Could not load your dances.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );
  return { dances, error, loading, reload: load, available: !usingMockApi };
}
