/**
 * Camera access for the selfie step. LINE's and Facebook's in-app browsers often block or break
 * getUserMedia, so there the page goes straight to `<input type="file" capture="user">`, which
 * opens the phone's own camera app.
 */

const IN_APP_BROWSER = /\bLine\/|FBAN|FBAV|FB_IAB|FBIOS|Instagram|MicroMessenger/i;

export function isInAppBrowser(userAgent: string): boolean {
  return IN_APP_BROWSER.test(userAgent);
}

export function isIOS(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints' | 'platform'>): boolean {
  return (
    /iPad|iPhone|iPod/.test(nav.userAgent) ||
    // iPadOS reports itself as a Mac.
    (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
  );
}

/** Live camera preview is worth trying: the API exists and this isn't an in-app browser. */
export function canUseLiveCamera(nav: Navigator | undefined): boolean {
  if (nav === undefined) return false;
  return typeof nav.mediaDevices?.getUserMedia === 'function' && !isInAppBrowser(nav.userAgent);
}

/** The front camera, video only. Rejects when the person or the browser refuses. */
export function openFrontCamera(nav: Navigator): Promise<MediaStream> {
  return nav.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 1280 } },
  });
}

export function stopStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

/** A rectangle in a video frame's pixels. */
export interface FrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The centered part of a `width` × `height` frame that a digital `zoom` keeps. */
export function centerCrop(width: number, height: number, zoom: number): FrameRect {
  const z = Math.max(1, zoom);
  const w = Math.max(1, Math.round(width / z));
  const h = Math.max(1, Math.round(height / z));
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), width: w, height: h };
}

type ZoomCapabilities = MediaTrackCapabilities & { zoom?: { min?: number; max?: number } };
type ZoomSettings = MediaTrackSettings & { zoom?: number };

/**
 * Phones hand getUserMedia the front camera's full, wide field of view, while their own camera
 * app crops it, so a selfie looks like a wide-angle shot. Asks the camera itself for `zoom` where
 * the browser supports the constraint, and returns the zoom still to do digitally (preview scale
 * and frame crop): `zoom` when the camera can't, 1 when it did all of it.
 */
export async function zoomCamera(stream: MediaStream, zoom: number): Promise<number> {
  if (zoom <= 1) return 1;
  const track = stream.getVideoTracks?.()[0];
  if (track === undefined || typeof track.getCapabilities !== 'function') return zoom;
  try {
    const range = (track.getCapabilities() as ZoomCapabilities).zoom;
    if (range?.max === undefined || range.max <= (range.min ?? 1)) return zoom;
    const target = Math.min(range.max, Math.max(range.min ?? 1, zoom));
    await track.applyConstraints({ advanced: [{ zoom: target } as MediaTrackConstraintSet] });
    const applied = (track.getSettings() as ZoomSettings).zoom ?? 1;
    return Math.max(1, zoom / Math.max(1, applied));
  } catch {
    return zoom;
  }
}
