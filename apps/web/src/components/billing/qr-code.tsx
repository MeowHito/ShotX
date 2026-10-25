'use client';

import { useMemo } from 'react';
import { encodeQr, qrSvgPath } from '@/lib/billing/qr';

const QUIET_ZONE = 4;

/**
 * A PromptPay QR. Shows the gateway's image when the checkout response had one, else draws the
 * EMVCo payload locally as SVG (polled payments carry the payload only). Black on white with the
 * standard 4-module quiet zone so banking apps scan it from a screenshot too.
 */
export function PromptPayQr({
  payload,
  imageDataUrl,
  label,
}: {
  payload: string;
  imageDataUrl: string | null;
  label: string;
}) {
  const matrix = useMemo(
    () => (imageDataUrl === null ? encodeQr(payload) : null),
    [payload, imageDataUrl],
  );
  if (imageDataUrl !== null) {
    return (
      // A data: URL from the gateway; next/image can't optimize it.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageDataUrl}
        alt={label}
        className="mx-auto aspect-square w-full max-w-64 bg-white"
      />
    );
  }
  if (matrix === null) return null;
  const size = matrix.size + QUIET_ZONE * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      data-qr-version={matrix.version}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="mx-auto aspect-square w-full max-w-64"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={qrSvgPath(matrix, QUIET_ZONE)} fill="#000" />
    </svg>
  );
}
