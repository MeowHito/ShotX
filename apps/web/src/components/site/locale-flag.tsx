import type { SupportedLocale } from '@shotx/shared';
import { cn } from '@shotx/ui';

/** Points of a five-pointed star centred on (cx, cy), first point towards `angle` (degrees). */
function star(cx: number, cy: number, r: number, angle = -90): string {
  const points: string[] = [];
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 === 0 ? r : r * 0.382;
    const a = ((angle + i * 36) * Math.PI) / 180;
    points.push(
      `${(cx + radius * Math.cos(a)).toFixed(2)},${(cy + radius * Math.sin(a)).toFixed(2)}`,
    );
  }
  return points.join(' ');
}

/** Thailand: red, white, double-height blue, white, red. */
function Thailand() {
  return (
    <>
      <rect width="30" height="20" fill="#A51931" />
      <rect y="3.33" width="30" height="13.34" fill="#F4F5F8" />
      <rect y="6.67" width="30" height="6.66" fill="#2D2A4A" />
    </>
  );
}

/** United States, simplified for icon size: 13 stripes, the canton with a grid of stars. */
function UnitedStates() {
  const stripe = 20 / 13;
  return (
    <>
      <rect width="30" height="20" fill="#FFFFFF" />
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={i} y={i * 2 * stripe} width="30" height={stripe} fill="#B22234" />
      ))}
      <rect width="12" height={stripe * 7} fill="#3C3B6E" />
      {Array.from({ length: 4 }, (_, row) =>
        Array.from({ length: 5 }, (_, col) => (
          <circle
            key={`${row}-${col}`}
            cx={1.4 + col * 2.3}
            cy={1.4 + row * 2.3}
            r="0.5"
            fill="#FFFFFF"
          />
        )),
      )}
    </>
  );
}

/** China: red, one large and four small yellow stars (each small one pointing at the large). */
function China() {
  const small: [number, number][] = [
    [10, 2],
    [12, 4],
    [12, 7],
    [10, 9],
  ];
  return (
    <>
      <rect width="30" height="20" fill="#EE1C25" />
      <polygon points={star(5, 5, 3)} fill="#FFFF00" />
      {small.map(([x, y]) => (
        <polygon
          key={`${x}-${y}`}
          points={star(x, y, 1, (Math.atan2(5 - y, 5 - x) * 180) / Math.PI)}
          fill="#FFFF00"
        />
      ))}
    </>
  );
}

const FLAGS: Record<SupportedLocale, () => React.JSX.Element> = {
  th: Thailand,
  en: UnitedStates,
  zh: China,
};

/** The flag shown for a UI language (3:2, rounded, decorative: the label names the language). */
export function LocaleFlag({ locale, className }: { locale: SupportedLocale; className?: string }) {
  const Flag = FLAGS[locale];
  return (
    <svg
      viewBox="0 0 30 20"
      className={cn('shrink-0 overflow-hidden rounded-[3px] ring-1 ring-black/10', className)}
      aria-hidden
      data-testid={`flag-${locale}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <Flag />
    </svg>
  );
}
