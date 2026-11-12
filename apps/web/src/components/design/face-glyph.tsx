/**
 * Our own face-scan glyph (ADR 0013), in the rounded-corner style: four rounded corner brackets
 * around a simple face (two short eye lines, an L-shaped nose, a smile). Drawn here on a 100 x
 * 100 grid with round caps and joins; not a copy of any platform's asset. `strokeWidth` is in the
 * same units as the box the glyph is fitted to.
 */
export const FACE_GLYPH_PATHS = [
  // Corner brackets: arm, rounded corner, arm.
  'M6 30V20A14 14 0 0 1 20 6H30',
  'M70 6H80A14 14 0 0 1 94 20V30',
  'M94 70V80A14 14 0 0 1 80 94H70',
  'M30 94H20A14 14 0 0 1 6 80V70',
  // Eyes.
  'M35 37V45',
  'M65 37V45',
  // Nose: down, then a short step back to the left.
  'M51 38V56H46',
  // Smile.
  'M36 67Q50 78 64 67',
] as const;

export function FaceGlyph({
  color,
  strokeWidth,
  boxSize,
}: {
  color: string;
  /** Design units. */
  strokeWidth: number;
  /** The smaller side of the element's box, design units (the glyph is fitted into it). */
  boxSize: number;
}) {
  // The glyph is drawn on a 100-unit grid scaled to `boxSize`: convert the stroke width.
  const stroke = (strokeWidth * 100) / Math.max(1, boxSize);
  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid meet"
      width="100%"
      height="100%"
      fill="none"
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable="false"
      data-testid="face-glyph"
      style={{ overflow: 'visible', display: 'block' }}
    >
      {FACE_GLYPH_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
