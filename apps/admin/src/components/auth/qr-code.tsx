'use client';

import { useMemo } from 'react';
import { encodeQr, qrSvgPath } from '@/lib/qr/qr';

const QUIET_ZONE = 4;

/**
 * A QR code drawn locally as inline SVG (no image request, no third-party service). Black on
 * white with the standard 4-module quiet zone so authenticator apps scan it in dark mode too.
 */
export function QrCode({ text, label }: { text: string; label: string }) {
  const matrix = useMemo(() => encodeQr(text), [text]);
  const size = matrix.size + QUIET_ZONE * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className="mx-auto aspect-square w-full max-w-56 rounded-lg"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={qrSvgPath(matrix, QUIET_ZONE)} fill="#000" />
    </svg>
  );
}
