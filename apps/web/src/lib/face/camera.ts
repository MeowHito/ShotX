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
