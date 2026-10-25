'use client';

import { createContext, type ReactNode, useContext, useState } from 'react';
import type { ClientFaceConfig } from '@/lib/face/config';
import { createMediaPipeDetectorLoader, type DetectorLoader } from '@/lib/face/detector';
import { browserCanvasOps, type CanvasOps } from '@/lib/face/selfie';

/** Browser capabilities of the scan flow; tests replace them (no canvas or camera in jsdom). */
export interface FaceTools {
  config: ClientFaceConfig;
  canvas: CanvasOps;
  loadDetector: DetectorLoader;
  navigator: Navigator | undefined;
}

const FaceToolsContext = createContext<FaceTools | null>(null);

export function useFaceTools(): FaceTools {
  const value = useContext(FaceToolsContext);
  if (value === null) throw new Error('useFaceTools outside <FaceToolsProvider>');
  return value;
}

export function FaceToolsProvider({
  config,
  overrides,
  children,
}: {
  config: ClientFaceConfig;
  overrides?: Partial<Omit<FaceTools, 'config'>>;
  children: ReactNode;
}) {
  const [tools] = useState<FaceTools>(() => ({
    config,
    canvas: overrides?.canvas ?? browserCanvasOps,
    // MediaPipe is imported only when the first selfie is checked.
    loadDetector: overrides?.loadDetector ?? createMediaPipeDetectorLoader(config),
    navigator:
      overrides && 'navigator' in overrides
        ? overrides.navigator
        : typeof navigator === 'undefined'
          ? undefined
          : navigator,
  }));
  return <FaceToolsContext.Provider value={tools}>{children}</FaceToolsContext.Provider>;
}
