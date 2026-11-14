# ADR 0025: Photographers reset a forgotten password by email, and sign-in never says "wait"

- Status: Accepted (owner, 2026-11-14)
- Date: 2026-11-14

## Context

A photographer who mistyped their password a few times saw "ส่งคำขอบ่อยเกินไป
กรุณารอสักครู่แล้วลองใหม่" (RATE_LIMITED from PHOTOGRAPHER_LOGIN_RATE_PER_ACCOUNT, 5 failures per
15 minutes, ADR 0010) and had no way out except asking an admin. The owner asked for two things:

1. "ลืมรหัสผ่าน" for photographers, with an email to confirm the change.
2. Remove the wait entirely: photographers may keep trying.

Email had no working sender: EMAIL_PROVIDER (billing receipts and notices) is `off` on the VPS and
its `ses` adapter was never wired after leaving AWS (ADR 0008).

## Decision

- **No wait on photographer sign-in.** `PHOTOGRAPHER_LOGIN_LIMITS_ENABLED` (default `false`)
  switches off the per-account and per-IP windows and the lockout of photographer sign-in and of
  the current-password check. Failures are still audited. A `locked_until` left over from before is
  ignored while the switch is off. Admin sign-in keeps its limits and lockout (MFA-protected,
  separate pool). The trade-off: password guessing against a photographer account is limited only
  by argon2id's cost and the password policy (PHOTOGRAPHER_PASSWORD_MIN_LENGTH, common-password
  check). Setting the switch to `true` restores ADR 0010's limits without a deploy.
- **Account email, separate from billing email.** `ACCOUNT_EMAIL_PROVIDER` = `smtp | fake | off`
  (default `off`), api only, via nodemailer over any SMTP server (`SMTP_HOST`, `SMTP_PORT` 465 =
  TLS, otherwise STARTTLS required, `SMTP_USER`, `SMTP_PASSWORD`, `ACCOUNT_EMAIL_FROM_ADDRESS`,
  `ACCOUNT_EMAIL_FROM_NAME`). `fake` is refused on prod. Billing email (EMAIL_PROVIDER) is
  unchanged.
- **Reset flow.**
  1. The sign-in page shows "ลืมรหัสผ่าน?" when `GET /auth/providers` says `passwordReset: true`
     (an account email provider is set); otherwise "ลืมรหัสผ่าน? ติดต่อผู้ดูแลระบบ".
  2. `/forgot-password` → web's `POST /auth/password-reset/request` → API
     `POST /auth/photographer/password-reset/request` (`bff`). Always 204, for every email: only an
     active photographer password account gets an email, at most
     `PHOTOGRAPHER_PASSWORD_RESET_EMAILS_PER_HOUR` (default 5) per account per hour, extra requests
     dropped silently. The email is sent after the answer, so timing doesn't reveal accounts.
  3. The email (Thai, text + HTML) links to `/reset-password#token=<43-char token>`. The token is in
     the fragment, so it never reaches a server or proxy log; the page removes it from the address
     bar once read. Redis keeps only SHA-256(token) → account id + a fingerprint of the current
     password hash, for `PHOTOGRAPHER_PASSWORD_RESET_TTL_SECONDS` (default 1 hour).
  4. The page sends the token and the new password to web's `POST /auth/password-reset/confirm` →
     API `POST /auth/photographer/password-reset/confirm`. The token must be live, the account
     active and its password unchanged since the email (else PASSWORD_RESET_INVALID: any password
     change or admin reset voids older links). The policy applies (PASSWORD_TOO_WEAK keeps the link
     usable). Then, single use, in one transaction: new hash, `must_change_password = false`,
     lockout cleared, every session revoked, audit row, and a new session that web stores in the
     cookies; the browser goes to `/studio`.
- **Audit.** `auth.photographer.password_reset_requested` (`meta.outcome`: `sent`, `throttled`,
  `no_account`, `disabled`, `send_failed`) and `auth.photographer.password_reset`. Never the email
  address (unknown emails use the HMAC target, as for sign-in), the token or the link.
- **Admins** are out of scope: they keep the operator CLI and other admins' reset.

## What the owner sets up

Pick an SMTP sender and put its settings in the VPS `env/api.env`, then restart the api:

```
ACCOUNT_EMAIL_PROVIDER=smtp
SMTP_HOST=smtp.gmail.com        # or smtp.hostinger.com, smtp.resend.com, ...
SMTP_PORT=465
SMTP_USER=<the mailbox or "resend">
SMTP_PASSWORD=<app password or API key>
ACCOUNT_EMAIL_FROM_ADDRESS=<sender, if not SMTP_USER>
```

For a sender on the company domain (better delivery than a Gmail address), the domain needs the
provider's SPF and DKIM DNS records.

## Consequences

- Photographers recover their own accounts; admins no longer have to reset forgotten passwords.
- The email address of a photographer account must be a real inbox they can read.
- Without SMTP settings nothing changes except the sign-in page's "ask the admin" hint.
