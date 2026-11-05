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
  /** Which tutorial step of the reference is being practiced; null scores the whole dance. */
  currentStep: number | null;
  setCurrentStep: (step: number | null) => void;
  /** Steps passed (score over 80) for the current reference, this session only. */
  completedSteps: number[];
  markStepCompleted: (step: number) => void;
};

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [reference, setReference] = useState<PickedVideo | null>(null);
  const [practice, setPractice] = useState<PickedVideo | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [stepRecordings, setStepRecordings] = useState<Record<number, PickedVideo>>({});
  const [currentStep, setCurrentStep] = useState<number | null>(null);
  const [completedSteps, setCompletedSteps] = useState<number[]>([]);

  // A new reference starts its step practice from the first step.
  const referenceKey = reference ? `${reference.fileName}:${reference.youtube?.steps?.length ?? 0}` : null;
  useEffect(() => {
    setCurrentStep(reference?.youtube?.steps?.length ? 0 : null);
    setCompletedSteps([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceKey]);

  function markStepCompleted(step: number) {
    setCompletedSteps((previous) => (previous.includes(step) ? previous : [...previous, step]));
  }
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
      value={{
        reference,
        practice,
        result,
        setReference,
        setPractice,
        setResult,
        stepRecordings,
        setStepRecording,
        currentStep,
        setCurrentStep,
        completedSteps,
        markStepCompleted,
      }}
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
