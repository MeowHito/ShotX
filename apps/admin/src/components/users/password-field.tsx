'use client';

import { Button, Input, Label } from '@shotx/ui';
import { RefreshCwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId } from 'react';
import { generatePassword } from '@/lib/users/password';

/**
 * The initial (temporary) password input with a "generate" button (crypto.getRandomValues). The
 * value is controlled by the dialog that owns it, which drops it when it closes. Plain text so
 * the admin can read it, with autofill, spell-check and password-manager saving turned off.
 */
export function PasswordField({
  value,
  onChange,
  length,
  minLength,
  email,
  error,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Length of a generated password (ADMIN_GENERATED_PASSWORD_LENGTH). */
  length: number;
  /** The pool's minimum length, shown in the hint. */
  minLength: number;
  /** The account's email, so a generated password never contains it. */
  email?: string;
  error?: string | null;
}) {
  const t = useTranslations('passwordField');
  const id = useId();
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t('label')}</Label>
      <div className="flex gap-2">
        <Input
          id={id}
          type="text"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-1p-ignore=""
          data-lpignore="true"
          maxLength={256}
          className="font-mono"
          value={value}
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange(generatePassword(length, { email }))}
        >
          <RefreshCwIcon aria-hidden />
          {t('generate')}
        </Button>
      </div>
      <p
        id={`${id}-hint`}
        className={error ? 'text-sm text-destructive' : 'text-xs text-muted-foreground'}
      >
        {error ?? t('hint', { minLength })}
      </p>
    </div>
  );
}
