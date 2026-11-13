import { cn } from '@shotx/ui';

/**
 * The Snap mark: the same artwork as the browser-tab icon (src/app/icon.svg), a camera with a
 * face-scan frame, on a white tile so it reads on the light and the dark studio (ADR 0024).
 */
export function SnapMark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-xl bg-white shadow-sm ring-1 ring-black/5',
        className,
      )}
      aria-hidden
    >
      <svg viewBox="0 0 512 512" className="size-[78%]">
        <path
          d="M86 132h68l25-42c7-12 18-18 31-18h92c13 0 24 6 31 18l25 42h68c34 0 62 28 62 62v202c0 34-28 62-62 62H86c-34 0-62-28-62-62V194c0-34 28-62 62-62Z"
          fill="none"
          stroke="#05264d"
          strokeWidth="32"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="414" cy="195" r="16" fill="#05264d" />
        <path
          d="M154 235v-19c0-11 9-20 20-20h19m126 0h19c11 0 20 9 20 20v19M154 310v19c0 11 9 20 20 20h19m126 0h19c11 0 20-9 20-20v-19"
          fill="none"
          stroke="#0877f9"
          strokeWidth="23"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="256" cy="272" r="43" fill="#05264d" />
        <path
          d="M176 411c4-49 37-82 80-82s76 33 80 82c1 8-5 13-13 13H189c-8 0-14-5-13-13Z"
          fill="#05264d"
        />
      </svg>
    </span>
  );
}
