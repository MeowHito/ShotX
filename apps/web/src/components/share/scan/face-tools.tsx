'use client';

import { createContext, type ReactNode, useContext, useState } from 'react';
import { createTurnstileLoader, type TurnstileLoader } from '@/lib/captcha/turnstile';
import type { ClientFaceConfig } from '@/lib/face/config';
import { createMediaPipeDetectorLoader, type DetectorLoader } from '@/lib/face/detector';
import { browserCanvasOps, type CanvasOps } from '@/lib/face/selfie';

/** Browser capabilities of the scan flow; tests replace them (no canvas or camera in jsdom). */
export interface FaceTools {
  config: ClientFaceConfig;
  canvas: CanvasOps;
  loadDetector: DetectorLoader;
  navigator: Navigator | undefined;
  /** Turnstile, loaded only when the API asks for a challenge; null without `turnstile`. */
  loadTurnstile: TurnstileLoader | null;
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
    loadTurnstile:
      overrides?.loadTurnstile ??
      (config.captcha.provider === 'turnstile'
        ? createTurnstileLoader(config.captcha.scriptUrl)
        : null),
    navigator:
      overrides && 'navigator' in overrides
        ? overrides.navigator
        : typeof navigator === 'undefined'
          ? undefined
          : navigator,
  }));
  return <FaceToolsContext.Provider value={tools}>{children}</FaceToolsContext.Provider>;
}
