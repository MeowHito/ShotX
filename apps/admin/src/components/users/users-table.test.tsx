import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { makeUser, SELF_ID } from '../../../test/fake-admin-api';
import { renderWithProviders } from '../../../test/render';
import { availableActions, UsersTable } from './users-table';

const GB = 1024 ** 3;

const photographer = makeUser({
  email: 'photo@example.com',
  name: 'ช่างภาพ เอ',
  role: 'photographer',
  usedBytes: 2.5 * GB,
  photoCount: 1234,
  lastSignInAt: '2026-11-09T02:30:00.000Z',
  mustChangePassword: true,
});
const disabled = makeUser({
  email: 'gone@example.com',
  name: null,
  status: 'disabled',
  lockedUntil: '2099-01-01T00:00:00.000Z',
});
const lineUser = makeUser({ email: null, name: 'LINE user', passwordAccount: false });
const self = makeUser({
  id: SELF_ID,
  email: 'me@example.com',
  role: 'admin',
  usedBytes: null,
  photoCount: null,
});
const pendingAdmin = makeUser({
  email: 'pending.admin@example.test',
  role: 'admin',
  usedBytes: null,
  mustChangePassword: true,
  totpEnrolled: false,
});

function rowOf(text: string) {
  return screen.getByText(text).closest('tr')!;
}

describe('UsersTable', () => {
  it('shows each account with role, status, storage in GB, photo count and sign-in', () => {
    renderWithProviders(
      <UsersTable
        users={[photographer, disabled, lineUser, self]}
        currentAdminId={SELF_ID}
        now={Date.parse('2026-11-10T00:00:00Z')}
        onAction={vi.fn()}
      />,
      { fetch: vi.fn() },
    );
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual([
      'อีเมล',
      'ชื่อ',
      'บทบาท',
      'สถานะ',
      'พื้นที่ที่ใช้',
      'เข้าสู่ระบบล่าสุด',
      'จำนวนรูป',
      'แพ็กเกจ',
      'ยอดชำระ',
      'จัดการ',
    ]);

    const p = within(rowOf('photo@example.com'));
    expect(p.getByText('ตากล้อง')).toBeInTheDocument();
    expect(p.getByText('ใช้งานอยู่')).toBeInTheDocument();
    expect(p.getByText('รหัสชั่วคราว')).toBeInTheDocument();
    expect(p.getByText('2.5 GB')).toBeInTheDocument();
    expect(p.getByText('1,234')).toBeInTheDocument();
    expect(p.getByText(/9 พ\.ย\. 2569/)).toBeInTheDocument();

    const d = within(rowOf('gone@example.com'));
    expect(d.getByText('ปิดใช้งาน')).toBeInTheDocument();
    expect(d.getByText('ถูกล็อกชั่วคราว')).toBeInTheDocument();
    expect(d.getByText('ยังไม่เคย')).toBeInTheDocument();
    expect(d.getByText('ไม่มีชื่อ')).toBeInTheDocument();

    expect(within(rowOf('ไม่มีอีเมล (LINE/Google)')).getByText('LINE user')).toBeInTheDocument();

    const me = within(rowOf('me@example.com'));
    expect(me.getByText('แอดมิน')).toBeInTheDocument();
    expect(me.getByText('คุณ')).toBeInTheDocument();
    // Admins have no storage, photos, package or payments.
    expect(me.getAllByText('–')).toHaveLength(4);
  });

  it('shows the package, its expiry and photos used, unlimited without one, and self sign-ups', () => {
    const running = makeUser({
      email: 'free@example.com',
      createdById: null,
      selfSignup: true,
      package: {
        code: 'free',
        name: 'Free',
        startsAt: '2026-11-09T00:00:00.000Z',
        expiresAt: '2026-11-12T00:00:00.000Z',
        photoLimit: 100,
        photosUsed: 42,
        expired: false,
      },
    });
    const expired = makeUser({
      email: 'old@example.com',
      createdById: null,
      selfSignup: true,
      package: {
        code: 'd7',
        name: '7 Days',
        startsAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-10-08T00:00:00.000Z',
        photoLimit: 3000,
        photosUsed: 3000,
        expired: true,
      },
    });
    // Expired since the answer: judged against `now` too.
    const lapsed = makeUser({
      email: 'lapsed@example.com',
      package: {
        code: 'd3',
        name: '3 Days',
        startsAt: '2026-11-06T00:00:00.000Z',
        expiresAt: '2026-11-09T00:00:00.000Z',
        photoLimit: 1000,
        photosUsed: 0,
        expired: false,
      },
    });
    renderWithProviders(
      <UsersTable
        users={[running, expired, lapsed, photographer, self]}
        currentAdminId={SELF_ID}
        now={Date.parse('2026-11-10T00:00:00Z')}
        onAction={vi.fn()}
      />,
      { fetch: vi.fn() },
    );
    const r = within(rowOf('free@example.com'));
    expect(r.getByText('Free')).toBeInTheDocument();
    expect(r.getByText('สมัครเอง')).toBeInTheDocument();
    expect(r.getByText(/^ถึง 12 พ\.ย\. 2569/)).toBeInTheDocument();
    expect(r.getByText('42/100 รูป')).toBeInTheDocument();
    expect(r.queryByText('หมดอายุ')).toBeNull();

    const e = within(rowOf('old@example.com'));
    expect(e.getByText('7 Days')).toBeInTheDocument();
    expect(e.getByText('หมดอายุ')).toBeInTheDocument();
    expect(e.getByText(/^หมดอายุเมื่อ 8 ต\.ค\. 2569/)).toBeInTheDocument();
    expect(e.getByText('3,000/3,000 รูป')).toBeInTheDocument();

    const l = within(rowOf('lapsed@example.com'));
    expect(l.getByText('หมดอายุ')).toBeInTheDocument();
    // Admin-created: no self sign-up mark.
    expect(l.queryByText('สมัครเอง')).toBeNull();

    // No package row: unlimited.
    const p = within(rowOf('photo@example.com'));
    expect(p.getByText('ไม่จำกัด')).toBeInTheDocument();
    expect(p.queryByText('สมัครเอง')).toBeNull();
    expect(within(rowOf('me@example.com')).queryByText('ไม่จำกัด')).toBeNull();
  });

  it('shows paid orders and the amount paid in THB for photographers; – for admins (ADR 0027)', () => {
    const paying = makeUser({ email: 'paying@example.com', ordersPaid: 3, paidSatang: 371_050 });
    const never = makeUser({ email: 'never@example.com', ordersPaid: 0, paidSatang: 0 });
    // An older api build sends neither field.
    const older = makeUser({ email: 'older@example.com' });
    const admin = makeUser({
      email: 'admin2@example.com',
      role: 'admin',
      usedBytes: null,
      photoCount: null,
      ordersPaid: null,
      paidSatang: null,
    });
    renderWithProviders(
      <UsersTable
        users={[paying, never, older, admin]}
        currentAdminId={SELF_ID}
        now={Date.parse('2026-11-10T00:00:00Z')}
        onAction={vi.fn()}
      />,
      { fetch: vi.fn() },
    );
    const paidColumn = screen
      .getAllByRole('columnheader')
      .findIndex((h) => h.textContent === 'ยอดชำระ');
    const cell = (email: string) => within(rowOf(email)).getAllByRole('cell')[paidColumn];
    expect(cell('paying@example.com')).toHaveTextContent('3 ครั้ง · ฿3,710.50');
    expect(cell('never@example.com')).toHaveTextContent('0 ครั้ง · ฿0');
    expect(cell('older@example.com')).toHaveTextContent('–');
    expect(cell('admin2@example.com')).toHaveTextContent(/^–$/);
  });

  it('offers rename, reset and disable, but never disable or reset of oneself', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderWithProviders(
      <UsersTable users={[photographer, self]} currentAdminId={SELF_ID} onAction={onAction} />,
      { fetch: vi.fn() },
    );
    await user.click(screen.getByRole('button', { name: 'จัดการบัญชี photo@example.com' }));
    expect(screen.getByRole('menuitem', { name: 'เปลี่ยนชื่อ' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'รีเซ็ตรหัสผ่าน' })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'ปิดใช้งาน' }));
    expect(onAction).toHaveBeenCalledWith('toggleStatus', photographer);

    await user.click(screen.getByRole('button', { name: 'จัดการบัญชี me@example.com' }));
    expect(screen.getByRole('menuitem', { name: 'เปลี่ยนชื่อ' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'รีเซ็ตรหัสผ่าน' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'ปิดใช้งาน' })).not.toBeInTheDocument();
  });

  it('flags admins whose authenticator enrolment is pending, never enrolled ones or photographers', () => {
    renderWithProviders(
      <UsersTable
        users={[pendingAdmin, self, photographer]}
        currentAdminId={SELF_ID}
        onAction={vi.fn()}
      />,
      { fetch: vi.fn(), mfaMode: 'totp' },
    );
    expect(
      within(rowOf('pending.admin@example.test')).getByText('ยังไม่ได้ตั้งแอปยืนยันตัวตน'),
    ).toBeInTheDocument();
    expect(within(rowOf('me@example.com')).queryByText('ยังไม่ได้ตั้งแอปยืนยันตัวตน')).toBeNull();
    expect(
      within(rowOf('photo@example.com')).queryByText('ยังไม่ได้ตั้งแอปยืนยันตัวตน'),
    ).toBeNull();
  });

  it('hides the authenticator flag when admins sign in without TOTP (mode off)', () => {
    renderWithProviders(
      <UsersTable users={[pendingAdmin]} currentAdminId={SELF_ID} onAction={vi.fn()} />,
      { fetch: vi.fn(), mfaMode: 'off' },
    );
    expect(screen.queryByText('ยังไม่ได้ตั้งแอปยืนยันตัวตน')).not.toBeInTheDocument();
    // The temporary-password flag still shows.
    expect(
      within(rowOf('pending.admin@example.test')).getByText('รหัสชั่วคราว'),
    ).toBeInTheDocument();
  });

  it('offers enable for a disabled account and no reset without a password', () => {
    expect(availableActions(disabled, SELF_ID)).toEqual([
      'rename',
      'resetPassword',
      'toggleStatus',
    ]);
    // ADR 0018: an active photographer's studio can be opened as them; disabled or admin: no.
    expect(availableActions(lineUser, SELF_ID)).toEqual(['rename', 'toggleStatus', 'actAs']);
    expect(availableActions(photographer, SELF_ID)).toContain('actAs');
    expect(availableActions(self, SELF_ID)).toEqual(['rename']);
    expect(availableActions(pendingAdmin, SELF_ID)).not.toContain('actAs');
  });
});
