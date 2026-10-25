'use client';

import { Alert, Button, buttonVariants, cn } from '@shotx/ui';
import { CameraIcon, ImageIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import { canUseLiveCamera, isInAppBrowser, openFrontCamera, stopStream } from '@/lib/face/camera';
import type { SelfieSource } from '@/lib/face/selfie';
import { useFaceTools } from './face-tools';

type CameraState = 'idle' | 'starting' | 'live' | 'blocked';

/** Shows a stream in a video element; autoplay failures are harmless (the user taps capture). */
function attach(video: HTMLVideoElement | null, stream: MediaStream | null) {
  if (video === null || stream === null || video.srcObject === stream) return;
  video.srcObject = stream;
  try {
    void Promise.resolve(video.play()).catch(() => undefined);
  } catch {
    // Some engines throw synchronously; the muted inline video autoplays anyway.
  }
}

/**
 * Takes one selfie: a live front-camera preview via getUserMedia where it works, otherwise
 * `<input type="file" accept="image/*" capture="user">` (LINE and Facebook in-app browsers, or a
 * refused permission), which opens the phone's camera app. "Choose from gallery" only when
 * `allowGallery` (gallery-mode shares). The image goes straight to `onCaptured`, in memory.
 */
export function SelfieCapture({
  onCaptured,
  allowGallery,
  busy,
}: {
  onCaptured: (source: SelfieSource) => void;
  allowGallery: boolean;
  busy: boolean;
}) {
  const t = useTranslations('capture');
  const { navigator: nav } = useFaceTools();
  const [liveSupported] = useState(() => canUseLiveCamera(nav));
  const inApp = nav !== undefined && isInAppBrowser(nav.userAgent);
  const [camera, setCamera] = useState<CameraState>('idle');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  useEffect(() => () => stopStream(streamRef.current), []);

  async function start() {
    if (nav === undefined) return;
    setCamera('starting');
    let stream: MediaStream;
    try {
      stream = await openFrontCamera(nav);
    } catch {
      // Refused, no camera, or blocked by the (in-app) browser: offer the file input instead.
      setCamera('blocked');
      return;
    }
    streamRef.current = stream;
    setCamera('live');
    attach(videoRef.current, stream);
  }

  useEffect(() => {
    // The <video> may mount after the stream arrives; attach it then.
    if (camera === 'live') attach(videoRef.current, streamRef.current);
  }, [camera]);

  function takePhoto() {
    const video = videoRef.current;
    if (video === null) return;
    onCaptured({
      kind: 'frame',
      source: video,
      width: video.videoWidth,
      height: video.videoHeight,
    });
    stopStream(streamRef.current);
    streamRef.current = null;
    setCamera('idle');
  }

  function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clear the input so the same photo can be picked again and no reference lingers.
    event.target.value = '';
    if (file !== undefined) onCaptured({ kind: 'file', blob: file });
  }

  const showFallback = !liveSupported || camera === 'blocked';

  return (
    <div className="space-y-3">
      <p className="text-sm font-medium">{t('guidance')}</p>
      {camera === 'live' || camera === 'starting' ? (
        <div className="space-y-3">
          <video
            ref={videoRef}
            aria-label={t('preview')}
            className="aspect-[3/4] w-full -scale-x-100 rounded-xl bg-black object-cover"
            autoPlay
            muted
            playsInline
          />
          <Button size="lg" className="w-full" onClick={takePhoto} disabled={camera !== 'live'}>
            <CameraIcon aria-hidden />
            {t('takePhoto')}
          </Button>
        </div>
      ) : null}
      {liveSupported && camera === 'idle' ? (
        <Button size="lg" className="w-full" onClick={() => void start()} disabled={busy}>
          <CameraIcon aria-hidden />
          {t('openCamera')}
        </Button>
      ) : null}
      {camera === 'blocked' ? <Alert variant="warning">{t('cameraBlocked')}</Alert> : null}
      {showFallback ? (
        <label className={cn(buttonVariants({ size: 'lg' }), 'w-full cursor-pointer')}>
          <CameraIcon aria-hidden />
          {t('useCameraApp')}
          <input
            type="file"
            accept="image/*"
            capture="user"
            className="sr-only"
            onChange={onFile}
            disabled={busy}
          />
        </label>
      ) : null}
      {allowGallery ? (
        <label
          className={cn(
            buttonVariants({ size: 'lg', variant: 'outline' }),
            'w-full cursor-pointer',
          )}
        >
          <ImageIcon aria-hidden />
          {t('chooseFromGallery')}
          <input
            type="file"
            accept="image/*"
            className="sr-only"
            onChange={onFile}
            disabled={busy}
          />
        </label>
      ) : null}
      {inApp ? <p className="text-xs text-muted-foreground">{t('inAppHint')}</p> : null}
    </div>
  );
}
