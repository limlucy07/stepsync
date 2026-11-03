import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import type { AnalysisResult, PickedVideo } from '@/api/types';

type Session = {
  reference: PickedVideo | null;
  practice: PickedVideo | null;
  result: AnalysisResult | null;
  stepRecordings: Record<number, PickedVideo>;
  setStepRecording: (step: number, video: PickedVideo) => void;
  setReference: (video: PickedVideo | null) => void;
  setPractice: (video: PickedVideo | null) => void;
  setResult: (result: AnalysisResult | null) => void;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [reference, setReference] = useState<PickedVideo | null>(null);
  const [practice, setPractice] = useState<PickedVideo | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [stepRecordings, setStepRecordings] = useState<Record<number, PickedVideo>>({});
  const ownedUrls = useRef(new Set<string>());

  useEffect(() => {
    const current = new Set(Object.values(stepRecordings).map(video => video.uri));
    for (const uri of ownedUrls.current) {
      if (!current.has(uri)) URL.revokeObjectURL(uri);
    }
    ownedUrls.current = new Set([...current].filter(uri => uri.startsWith('blob:')));
  }, [stepRecordings]);

  useEffect(() => () => {
    for (const uri of ownedUrls.current) URL.revokeObjectURL(uri);
  }, []);

  function setStepRecording(step: number, video: PickedVideo) {
    setStepRecordings(previous => ({ ...previous, [step]: video }));
  }

  return (
    <SessionContext.Provider
      value={{ reference, practice, result, setReference, setPractice, setResult, stepRecordings, setStepRecording }}
    >
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside SessionProvider');
  return session;
}
