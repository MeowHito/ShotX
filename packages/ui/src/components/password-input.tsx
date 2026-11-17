'use client';

import { Eye, EyeOff } from 'lucide-react';
import { type ComponentProps, useState } from 'react';
import { cn } from '../lib/cn';
import { Input } from './input';

/**
 * A password field with an eye button that shows or hides what was typed. The labels come from the
 * app (this package has no translations). The button is type="button", so it never submits the
 * form, and it is skipped by Tab so Tab still goes from the password to the submit button.
 */
export function PasswordInput({
  className,
  showLabel,
  hideLabel,
  ...props
}: Omit<ComponentProps<'input'>, 'type'> & { showLabel: string; hideLabel: string }) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return (
    <div className="relative">
      <Input
        {...props}
        type={visible ? 'text' : 'password'}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={cn('pr-11', className)}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={visible ? hideLabel : showLabel}
        aria-pressed={visible}
        title={visible ? hideLabel : showLabel}
        disabled={props.disabled}
        onClick={() => setVisible((v) => !v)}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none disabled:opacity-50"
      >
        <Icon aria-hidden className="size-4" />
      </button>
    </div>
  );
}
