import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { bodyOf, urlOf } from '../../../test/fetch';
import { renderWithProviders } from '../../../test/render';
import { SignInFlow } from './sign-in-flow';

const URI =
  'otpauth://totp/ShotX:new.admin%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=ShotX&digits=6&period=30';

type Answer = { status: number; body: unknown };

/** A fake of the admin app's own /auth/* route handlers: answers queued per path. */
function fakeSignIn(answers: Record<string, Answer[]>) {
  const calls: { path: string; body: unknown }[] = [];
  const fetchImpl = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const path = urlOf(input);
    calls.push({ path, body: JSON.parse(bodyOf(init)) as unknown });
    const answer = answers[path]?.shift() ?? {
      status: 500,
      body: { code: 'INTERNAL_ERROR', message: 'x' },
    };
    return Promise.resolve(
      new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const err = (status: number, code: string, details?: unknown): Answer => ({
  status,
  body: { code, message: code, ...(details !== undefined ? { details } : {}) },
});

describe('SignInFlow', () => {
  // The first tests are ADMIN_MFA_MODE=totp: the API answers with TOTP steps.
  it('walks a new admin through password change, TOTP enrolment and the code', async () => {
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    const { calls, fetchImpl } = fakeSignIn({
      '/auth/login': [{ status: 200, body: { step: 'change_password' } }],
      '/auth/password': [
        err(422, 'PASSWORD_TOO_WEAK', { reason: 'too_short', minLength: 14 }),
        { status: 200, body: { step: 'enrol_totp', otpauthUri: URI } },
      ],
      '/auth/mfa': [err(401, 'MFA_INVALID'), { status: 200, body: { step: 'signed_in' } }],
    });
    renderWithProviders(
      <SignInFlow next="/users" fetchImpl={fetchImpl} onSignedIn={onSignedIn} />,
      {
        fetch: fetchImpl,
      },
    );

    await user.type(screen.getByLabelText('อีเมล'), 'new.admin@example.com');
    await user.type(screen.getByLabelText('รหัสผ่าน'), 'temporary-password-1');
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));

    // Step 2: a weak password shows the reason and the minimum length.
    expect(await screen.findByRole('heading', { name: 'ตั้งรหัสผ่านใหม่' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('รหัสผ่านใหม่'), 'short');
    await user.type(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), 'different');
    await user.click(screen.getByRole('button', { name: 'ตั้งรหัสผ่านใหม่' }));
    expect(screen.getByText('รหัสผ่านทั้งสองช่องไม่ตรงกัน')).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    await user.clear(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'));
    await user.type(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), 'short');
    await user.click(screen.getByRole('button', { name: 'ตั้งรหัสผ่านใหม่' }));
    expect(
      await screen.findByText('รหัสผ่านสั้นเกินไป ต้องยาวอย่างน้อย 14 ตัวอักษร'),
    ).toBeInTheDocument();

    await user.clear(screen.getByLabelText('รหัสผ่านใหม่'));
    await user.clear(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'));
    await user.type(screen.getByLabelText('รหัสผ่านใหม่'), 'a-much-longer-passphrase');
    await user.type(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), 'a-much-longer-passphrase');
    await user.click(screen.getByRole('button', { name: 'ตั้งรหัสผ่านใหม่' }));

    // Step 3: the enrolment QR and the manual secret, shown once.
    expect(
      await screen.findByRole('img', { name: 'QR สำหรับเพิ่มบัญชีในแอปยืนยันตัวตน' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('totp-secret')).toHaveTextContent('JBSW Y3DP EHPK 3PXP');
    expect(screen.queryByLabelText('รหัสผ่านใหม่')).not.toBeInTheDocument();

    const code = screen.getByLabelText('รหัสยืนยันตัวตน');
    await user.type(code, '12345');
    await user.click(screen.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }));
    expect(screen.getByText('รหัสต้องเป็นตัวเลข 6 หรือ 8 หลัก')).toBeInTheDocument();
    await user.type(code, '6');
    await user.click(screen.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }));
    expect(await screen.findByText(/รหัสยืนยันตัวตนไม่ถูกต้อง/)).toBeInTheDocument();
    // A wrong code keeps the enrolment on screen so the admin can retry.
    expect(screen.getByTestId('totp-secret')).toBeInTheDocument();

    await user.type(screen.getByLabelText('รหัสยืนยันตัวตน'), '654 321');
    await user.click(screen.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith('/users'));

    expect(calls.map((c) => c.path)).toEqual([
      '/auth/login',
      '/auth/password',
      '/auth/password',
      '/auth/mfa',
      '/auth/mfa',
    ]);
    expect(calls[0]!.body).toEqual({
      email: 'new.admin@example.com',
      password: 'temporary-password-1',
    });
    expect(calls.at(-1)!.body).toEqual({ code: '654321' });
    // Nothing of the flow stays on screen: no password, no secret.
    expect(document.body.innerHTML).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('goes straight to the code for an enrolled admin', async () => {
    const user = userEvent.setup();
    const onSignedIn = vi.fn();
    const { fetchImpl } = fakeSignIn({
      '/auth/login': [{ status: 200, body: { step: 'totp' } }],
      '/auth/mfa': [{ status: 200, body: { step: 'signed_in' } }],
    });
    renderWithProviders(
      <SignInFlow next="/users/x" fetchImpl={fetchImpl} onSignedIn={onSignedIn} />,
      {
        fetch: fetchImpl,
      },
    );
    await user.type(screen.getByLabelText('อีเมล'), 'owner@example.com');
    await user.type(screen.getByLabelText('รหัสผ่าน'), 'pw');
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(await screen.findByRole('heading', { name: 'ยืนยันตัวตน' })).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText('รหัสยืนยันตัวตน'), '12345678');
    await user.click(screen.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith('/users/x'));
  });

  it('shows wrong credentials and rate limits in Thai on the first step', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = fakeSignIn({
      '/auth/login': [err(401, 'INVALID_CREDENTIALS'), err(429, 'RATE_LIMITED')],
    });
    renderWithProviders(<SignInFlow next="/users" fetchImpl={fetchImpl} />, { fetch: fetchImpl });
    await user.type(screen.getByLabelText('อีเมล'), 'a@b.co');
    await user.type(screen.getByLabelText('รหัสผ่าน'), 'x');
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(await screen.findByText('อีเมลหรือรหัสผ่านไม่ถูกต้อง')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(
      await screen.findByText('ลองหลายครั้งเกินไป กรุณารอสักครู่แล้วลองใหม่'),
    ).toBeInTheDocument();
  });

  it('starts over when the challenge expired, dropping the enrolment secret', async () => {
    const user = userEvent.setup();
    const { fetchImpl } = fakeSignIn({
      '/auth/login': [{ status: 200, body: { step: 'enrol_totp', otpauthUri: URI } }],
      '/auth/mfa': [err(400, 'LOGIN_STATE_INVALID')],
    });
    renderWithProviders(<SignInFlow next="/users" fetchImpl={fetchImpl} />, { fetch: fetchImpl });
    await user.type(screen.getByLabelText('อีเมล'), 'a@b.co');
    await user.type(screen.getByLabelText('รหัสผ่าน'), 'x');
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    await user.type(await screen.findByLabelText('รหัสยืนยันตัวตน'), '123456');
    await user.click(screen.getByRole('button', { name: 'ยืนยันและเข้าสู่ระบบ' }));
    expect(
      await screen.findByText('ขั้นตอนเข้าสู่ระบบหมดเวลาแล้ว กรุณาใส่อีเมลและรหัสผ่านอีกครั้ง'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('totp-secret')).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('JBSWY3DPEHPK3PXP');
    expect(screen.getByLabelText('อีเมล')).toHaveValue('');
  });

  describe('ADMIN_MFA_MODE=off', () => {
    it('signs in with email and password only, no TOTP screens', async () => {
      const user = userEvent.setup();
      const onSignedIn = vi.fn();
      const { calls, fetchImpl } = fakeSignIn({
        '/auth/login': [{ status: 200, body: { step: 'signed_in' } }],
      });
      renderWithProviders(
        <SignInFlow next="/users" fetchImpl={fetchImpl} onSignedIn={onSignedIn} />,
        { fetch: fetchImpl },
      );
      await user.type(screen.getByLabelText('อีเมล'), 'owner@example.test');
      await user.type(screen.getByLabelText('รหัสผ่าน'), 'pw');
      await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
      await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith('/users'));
      expect(calls.map((c) => c.path)).toEqual(['/auth/login']);
      expect(screen.queryByLabelText('รหัสยืนยันตัวตน')).not.toBeInTheDocument();
      expect(screen.queryByRole('img')).not.toBeInTheDocument();
    });

    it('signs in right after a forced password change', async () => {
      const user = userEvent.setup();
      const onSignedIn = vi.fn();
      const { calls, fetchImpl } = fakeSignIn({
        '/auth/login': [{ status: 200, body: { step: 'change_password' } }],
        '/auth/password': [{ status: 200, body: { step: 'signed_in' } }],
      });
      renderWithProviders(
        <SignInFlow next="/users" fetchImpl={fetchImpl} onSignedIn={onSignedIn} />,
        { fetch: fetchImpl },
      );
      await user.type(screen.getByLabelText('อีเมล'), 'new.admin@example.test');
      await user.type(screen.getByLabelText('รหัสผ่าน'), 'temporary-password-1');
      await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
      await user.type(await screen.findByLabelText('รหัสผ่านใหม่'), 'a-much-longer-passphrase');
      await user.type(screen.getByLabelText('ยืนยันรหัสผ่านใหม่'), 'a-much-longer-passphrase');
      await user.click(screen.getByRole('button', { name: 'ตั้งรหัสผ่านใหม่' }));
      await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith('/users'));
      expect(calls.map((c) => c.path)).toEqual(['/auth/login', '/auth/password']);
      expect(screen.queryByLabelText('รหัสยืนยันตัวตน')).not.toBeInTheDocument();
    });
  });
});
