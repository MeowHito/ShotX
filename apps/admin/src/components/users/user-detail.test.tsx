import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeAdminApi, makeUser, SELF_ID } from '../../../test/fake-admin-api';
import { renderWithProviders, TEST_PASSWORDS } from '../../../test/render';
import { UserDetail } from './user-detail';

describe('UserDetail', () => {
  it('shows a photographer with storage and the cash payments section', async () => {
    const photographer = makeUser({ email: 'photo@example.com', usedBytes: 3 * 1024 ** 3 });
    const api = new FakeAdminApi([photographer]);
    renderWithProviders(
      <UserDetail userId={photographer.id} currentAdminId={SELF_ID} passwords={TEST_PASSWORDS} />,
      { fetch: api.fetch },
    );
    expect(await screen.findByRole('heading', { name: 'photo@example.com' })).toBeInTheDocument();
    expect(screen.getByText('3 GB')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'การรับเงินสด' })).toBeInTheDocument();
    expect(screen.getByTestId('password-state')).toHaveTextContent(
      'เจ้าของบัญชีตั้งรหัสผ่านของตัวเองแล้ว',
    );
    // Photographers have no TOTP row.
    expect(screen.queryByTestId('totp-state')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ปิดใช้งาน' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'รีเซ็ตรหัสผ่าน' })).toBeInTheDocument();
  });

  it('shows no cash section for admins and no disable or reset for oneself', async () => {
    const api = new FakeAdminApi();
    renderWithProviders(
      <UserDetail userId={SELF_ID} currentAdminId={SELF_ID} passwords={TEST_PASSWORDS} />,
      { fetch: api.fetch, mfaMode: 'totp' },
    );
    expect(await screen.findByRole('heading', { name: 'owner@example.test' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'การรับเงินสด' })).not.toBeInTheDocument();
    expect(screen.getByTestId('totp-state')).toHaveTextContent('ตั้งค่าแล้ว');
    expect(screen.getByRole('button', { name: 'เปลี่ยนชื่อ' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ปิดใช้งาน' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'รีเซ็ตรหัสผ่าน' })).not.toBeInTheDocument();
  });

  it('shows that a new admin has not replaced the temporary password yet', async () => {
    const admin = makeUser({
      email: 'new.admin@example.test',
      role: 'admin',
      usedBytes: null,
      mustChangePassword: true,
      totpEnrolled: false,
    });
    const api = new FakeAdminApi([admin]);
    renderWithProviders(
      <UserDetail userId={admin.id} currentAdminId={SELF_ID} passwords={TEST_PASSWORDS} />,
      { fetch: api.fetch, mfaMode: 'totp' },
    );
    expect(await screen.findByTestId('password-state')).toHaveTextContent(
      /ยังเป็นรหัสชั่วคราว.*ในการเข้าสู่ระบบครั้งถัดไป/,
    );
    expect(screen.getByTestId('totp-state')).toHaveTextContent(/ยังไม่ได้ตั้งค่า/);
    expect(screen.getByTestId('totp-state')).toHaveTextContent(/รีเซ็ตรหัสผ่านหรือปิดใช้งาน/);
  });

  it('shows no authenticator row when admins sign in without TOTP (mode off)', async () => {
    const admin = makeUser({
      email: 'new.admin@example.test',
      role: 'admin',
      usedBytes: null,
      mustChangePassword: true,
      totpEnrolled: false,
    });
    const api = new FakeAdminApi([admin]);
    renderWithProviders(
      <UserDetail userId={admin.id} currentAdminId={SELF_ID} passwords={TEST_PASSWORDS} />,
      { fetch: api.fetch, mfaMode: 'off' },
    );
    expect(await screen.findByTestId('password-state')).toHaveTextContent(/ยังเป็นรหัสชั่วคราว/);
    expect(screen.queryByTestId('totp-state')).not.toBeInTheDocument();
    expect(screen.queryByText('แอปยืนยันตัวตน')).not.toBeInTheDocument();
  });
});
