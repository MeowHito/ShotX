import { ADMIN_ROUTES, ErrorCode } from '@shotx/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { FakeAdminApi, makeUser } from '../../../test/fake-admin-api';
import { renderWithProviders, TEST_PASSWORDS } from '../../../test/render';
import { CreateUserDialog } from './create-user-dialog';

function Harness({ onCreated = vi.fn() }: { onCreated?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        open
      </button>
      <CreateUserDialog
        open={open}
        onOpenChange={setOpen}
        passwords={TEST_PASSWORDS}
        onCreated={onCreated}
      />
    </>
  );
}

async function fill(user: ReturnType<typeof userEvent.setup>, email: string, name: string) {
  await user.type(screen.getByLabelText('อีเมล'), email);
  await user.type(screen.getByLabelText('ชื่อที่แสดง'), name);
}

describe('CreateUserDialog', () => {
  it('creates the account and shows the password once, then forgets it', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi();
    const onCreated = vi.fn();
    const { queryClient } = renderWithProviders(<Harness onCreated={onCreated} />, {
      fetch: api.fetch,
    });
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    await user.click(screen.getByRole('button', { name: 'open' }));
    await fill(user, ' new@example.com ', 'ช่างภาพใหม่');
    await user.selectOptions(screen.getByLabelText('บทบาท'), 'photographer');
    await user.click(screen.getByRole('button', { name: 'สุ่มรหัสผ่าน' }));
    const generated = screen.getByLabelText<HTMLInputElement>('รหัสผ่านชั่วคราว').value;
    expect(generated).toHaveLength(20);
    await user.click(screen.getByRole('button', { name: 'สร้างผู้ใช้' }));

    // Shown once, with a copy button and the hand-over note.
    expect(await screen.findByTestId('one-time-password')).toHaveTextContent(generated);
    expect(screen.getByText('สร้างบัญชี new@example.com แล้ว')).toBeInTheDocument();
    expect(screen.getByText(/รหัสจะแสดงครั้งเดียว/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'คัดลอกรหัสผ่าน' }));
    expect(writeText).toHaveBeenCalledWith(generated);
    expect(screen.getByRole('button', { name: 'คัดลอกแล้ว' })).toBeInTheDocument();

    // Sent once, trimmed email, exactly what was shown.
    const [call] = api.callsOf(ADMIN_ROUTES.createUser);
    expect(call!.body).toEqual({
      email: 'new@example.com',
      name: 'ช่างภาพใหม่',
      role: 'photographer',
      password: generated,
    });
    expect(call!.path).not.toContain(generated);
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ email: 'new@example.com' }));
    expect(JSON.stringify(onCreated.mock.calls)).not.toContain(generated);

    await user.click(
      screen.getByRole('button', { name: 'ส่งรหัสให้เจ้าของบัญชีแล้ว ปิดหน้าต่าง' }),
    );
    await waitFor(() => expect(screen.queryByTestId('one-time-password')).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain(generated);
    // Not in the query cache (no useMutation variables) or the URL either.
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state),
      ),
    ).not.toContain(generated);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(generated);
    expect(window.location.href).not.toContain(generated);

    // Reopening starts from an empty form.
    await user.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.getByLabelText('รหัสผ่านชั่วคราว')).toHaveValue('');
    expect(screen.getByLabelText('อีเมล')).toHaveValue('');
    expect(document.body.innerHTML).not.toContain(generated);
  });

  it('drops a typed password when the dialog is cancelled', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi();
    renderWithProviders(<Harness />, { fetch: api.fetch });
    await user.click(screen.getByRole('button', { name: 'open' }));
    await user.type(screen.getByLabelText('รหัสผ่านชั่วคราว'), 'typed-secret-value-123');
    await user.click(screen.getByRole('button', { name: 'ยกเลิก' }));
    await user.click(screen.getByRole('button', { name: 'open' }));
    expect(screen.getByLabelText('รหัสผ่านชั่วคราว')).toHaveValue('');
    expect(api.calls).toHaveLength(0);
  });

  it('maps EMAIL_TAKEN and PASSWORD_TOO_WEAK to Thai and keeps the form', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi([makeUser({ email: 'Taken@Example.com' })]);
    renderWithProviders(<Harness />, { fetch: api.fetch });
    await user.click(screen.getByRole('button', { name: 'open' }));
    await fill(user, 'taken@example.com', 'Dup');
    await user.type(screen.getByLabelText('รหัสผ่านชั่วคราว'), 'a-long-enough-password');
    await user.click(screen.getByRole('button', { name: 'สร้างผู้ใช้' }));
    expect(await screen.findByText(/อีเมลนี้มีบัญชีอยู่แล้ว/)).toBeInTheDocument();
    expect(screen.queryByTestId('one-time-password')).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText('อีเมล'));
    await user.type(screen.getByLabelText('อีเมล'), 'fresh@example.com');
    api.failNext(ADMIN_ROUTES.createUser, ErrorCode.PASSWORD_TOO_WEAK, {
      reason: 'common',
      minLength: 10,
    });
    await user.click(screen.getByRole('button', { name: 'สร้างผู้ใช้' }));
    expect(await screen.findByText(/มีคนใช้กันมากและเดาง่าย/)).toBeInTheDocument();
    expect(
      screen.getByText(/อย่างน้อย 10 ตัวอักษร/, { selector: '[role=alert]' }),
    ).toBeInTheDocument();
  });

  it('takes any temporary password of at least 4 characters (ADR 0015)', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi();
    renderWithProviders(<Harness />, { fetch: api.fetch });
    await user.click(screen.getByRole('button', { name: 'open' }));
    await fill(user, 'someone.new@example.com', 'New');
    expect(screen.getByText(/อย่างน้อย 4 ตัวอักษร/)).toBeInTheDocument();
    await user.type(screen.getByLabelText('รหัสผ่านชั่วคราว'), '123');
    await user.click(screen.getByRole('button', { name: 'สร้างผู้ใช้' }));
    expect(screen.getByText('รหัสผ่านสั้นเกินไป ต้องยาวอย่างน้อย 4 ตัวอักษร')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);

    // Simple is fine, for admins too: the first sign-in replaces it.
    await user.type(screen.getByLabelText('รหัสผ่านชั่วคราว'), '4');
    await user.selectOptions(screen.getByLabelText('บทบาท'), 'admin');
    await user.click(screen.getByRole('button', { name: 'สร้างผู้ใช้' }));
    expect(await screen.findByTestId('one-time-password')).toHaveTextContent('1234');
    expect(api.callsOf(ADMIN_ROUTES.createUser)[0]!.body).toMatchObject({
      role: 'admin',
      password: '1234',
    });
  });

  it('checks the email, name and password before calling the API', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi();
    renderWithProviders(<Harness />, { fetch: api.fetch });
    await user.click(screen.getByRole('button', { name: 'open' }));
    await user.type(screen.getByLabelText('อีเมล'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'สร้างผู้ใช้' }));
    expect(screen.getByText('กรุณาใส่อีเมลให้ถูกต้อง')).toBeInTheDocument();
    expect(screen.getByText('กรุณาใส่ชื่อ (ไม่เกิน 200 ตัวอักษร)')).toBeInTheDocument();
    expect(screen.getByText('กรุณาใส่หรือสุ่มรหัสผ่าน')).toBeInTheDocument();
    expect(api.calls).toHaveLength(0);
  });

  it('can create an admin', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi();
    renderWithProviders(<Harness />, { fetch: api.fetch });
    await user.click(screen.getByRole('button', { name: 'open' }));
    await fill(user, 'second.admin@example.com', 'Second');
    await user.selectOptions(screen.getByLabelText('บทบาท'), 'admin');
    // ADMIN_MFA_MODE=off (the default): no authenticator wording.
    expect(screen.getByText(/^จัดการผู้ใช้และดูข้อมูลทั้งระบบ เปลี่ยนบทบาท/)).toBeInTheDocument();
    expect(screen.queryByText(/แอปยืนยันตัวตน/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'สุ่มรหัสผ่าน' }));
    await user.click(screen.getByRole('button', { name: 'สร้างผู้ใช้' }));
    await screen.findByTestId('one-time-password');
    expect(api.callsOf(ADMIN_ROUTES.createUser)[0]!.body).toMatchObject({ role: 'admin' });
    expect(api.users[0]).toMatchObject({ role: 'admin', totpEnrolled: false });
  });

  it('tells that a new admin enrols TOTP at first sign-in when mode is totp', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi();
    renderWithProviders(<Harness />, { fetch: api.fetch, mfaMode: 'totp' });
    await user.click(screen.getByRole('button', { name: 'open' }));
    await user.selectOptions(screen.getByLabelText('บทบาท'), 'admin');
    expect(screen.getByText(/ต้องตั้งแอปยืนยันตัวตนเมื่อเข้าสู่ระบบครั้งแรก/)).toBeInTheDocument();
  });
});
