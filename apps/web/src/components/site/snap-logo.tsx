import { cn } from '@shotx/ui';

/**
 * The public pages' mark (ADR 0026, the owner's mockup): a camera whose lens is a face, with the
 * face-scan corners in blue. Decorative; the link around it carries the name.
 */
export function SnapLogo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden className={cn('w-[38px]', className)}>
      <path
        d="M7 14h7l3-5h14l3 5h7a4 4 0 0 1 4 4v20a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V18a4 4 0 0 1 4-4Z"
        stroke="#092e50"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <circle cx="24" cy="25" r="4" fill="#092e50" />
      <path d="M17 36c0-5 3-8 7-8s7 3 7 8" fill="#092e50" />
      <path
        d="M15 23v-4h4m10 0h4v4m-18 7v4h3m15-4v4h-3"
        stroke="#0875e9"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
