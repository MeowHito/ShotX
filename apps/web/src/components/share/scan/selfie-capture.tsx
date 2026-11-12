'use client';

import { Alert, Button, buttonVariants, cn } from '@shotx/ui';
import { CameraIcon, ImageIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { type ChangeEvent, useEffect, useRef, useState } from 'react';
import {
  canUseLiveCamera,
  centerCrop,
  isInAppBrowser,
  openFrontCamera,
  stopStream,
} from '@/lib/face/camera';
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
 * The face outline inside the round frame: the size a face should have for the quality gate
 * (about half the frame's width), so nobody needs written tips.
 */
function FaceGuide() {
  return (
    <svg
      viewBox="0 0 100 100"
      className="pointer-events-none absolute inset-0 size-full"
      aria-hidden
      data-testid="face-guide"
    >
      <ellipse
        cx="50"
        cy="47"
        rx="19"
        ry="25"
        fill="none"
        stroke="white"
        strokeOpacity="0.9"
        strokeWidth="1.2"
        strokeDasharray="3 2.5"
      />
    </svg>
  );
}

/**
 * Takes one selfie (ADR 0011): the front camera starts by itself in a round frame with a face
 * outline, one tap takes the photo. Where getUserMedia doesn't work (LINE and Facebook in-app
 * browsers, a refused permission) it falls back to `<input type="file" accept="image/*"
 * capture="user">`, which opens the phone's camera app. "Choose from gallery" only when
 * `allowGallery` (gallery-mode shares). The image goes straight to `onCaptured`, in memory.
 * The live camera is zoomed (WEB_FACE_CAMERA_ZOOM) so it looks like the phone's camera app, not
 * the front camera's full wide-angle view: always by the page (preview scaled, photo cropped to
 * the same centre), since a camera's own `zoom` support can't be checked from the page. The face
 * outline is small enough that the phone is held at arm's length: up close a front camera
 * distorts the face, which reads as "wide angle" however much the frame is zoomed.
 */
export function SelfieCapture({
  onCaptured,
  allowGallery,
  startWith = 'camera',
  busy,
}: {
  onCaptured: (source: SelfieSource) => void;
  allowGallery: boolean;
  /**
   * `gallery` (ADR 0013, the "use a photo" button): the gallery picker comes first and the camera only
   * starts when asked. Ignored without `allowGallery`.
   */
  startWith?: 'camera' | 'gallery';
  busy: boolean;
}) {
  const galleryFirst = allowGallery && startWith === 'gallery';
  const t = useTranslations('capture');
  const { navigator: nav, config } = useFaceTools();
  const [liveSupported] = useState(() => canUseLiveCamera(nav));
  const inApp = nav !== undefined && isInAppBrowser(nav.userAgent);
  const [camera, setCamera] = useState<CameraState>('idle');
  const digitalZoom = Math.max(1, config.cameraZoom);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startedRef = useRef(false);

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

  // Start the camera right away (consent was just given); once per mount, also in Strict Mode.
  // Not when the viewer asked to use a photo from the device.
  useEffect(() => {
    if (!liveSupported || galleryFirst || startedRef.current) return;
    startedRef.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSupported]);

  useEffect(() => {
    // The <video> may mount after the stream arrives; attach it then.
    if (camera === 'live') attach(videoRef.current, streamRef.current);
  }, [camera]);

  function takePhoto() {
    const video = videoRef.current;
    if (video === null) return;
    const width = video.videoWidth;
    const height = video.videoHeight;
    onCaptured({
      kind: 'frame',
      source: video,
      width,
      height,
      crop: digitalZoom > 1 ? centerCrop(width, height, digitalZoom) : undefined,
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
  const showFrame = camera === 'live' || camera === 'starting';

  const galleryPicker = allowGallery ? (
    <label
      className={cn(
        buttonVariants({ size: 'lg', variant: galleryFirst ? 'default' : 'outline' }),
        'w-full cursor-pointer',
      )}
    >
      <ImageIcon aria-hidden />
      {t('chooseFromGallery')}
      <input type="file" accept="image/*" className="sr-only" onChange={onFile} disabled={busy} />
    </label>
  ) : null;

  return (
    <div className="space-y-4">
      {galleryFirst && !showFrame ? galleryPicker : null}
      {showFrame ? (
        <div className="space-y-5">
          <div className="relative mx-auto aspect-square w-full max-w-[17rem] overflow-hidden rounded-full bg-black shadow-float ring-4 ring-primary/40">
            <video
              ref={videoRef}
              aria-label={t('preview')}
              className="absolute inset-0 size-full object-cover"
              // Mirrored like a mirror; scaled by the digital zoom (the crop taken on capture).
              style={{ transform: `scale(${-digitalZoom}, ${digitalZoom})` }}
              autoPlay
              muted
              playsInline
            />
            <FaceGuide />
          </div>
          <div className="flex justify-center">
            <Button
              size="lg"
              className="h-16 w-16 rounded-full p-0"
              onClick={takePhoto}
              disabled={camera !== 'live' || busy}
              aria-label={t('takePhoto')}
            >
              <CameraIcon className="size-7" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}
      {liveSupported && camera === 'idle' ? (
        <Button
          size="lg"
          variant={galleryFirst ? 'outline' : 'default'}
          className="w-full"
          onClick={() => void start()}
          disabled={busy}
        >
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
      {galleryFirst && !showFrame ? null : galleryPicker}
      {inApp ? <p className="text-xs text-muted-foreground">{t('inAppHint')}</p> : null}
    </div>
  );
}
