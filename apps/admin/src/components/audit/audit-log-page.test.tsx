import { ADMIN_ROUTES, type AuditLogEntry } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeAdminApi, SELF_ID } from '../../../test/fake-admin-api';
import { renderWithProviders } from '../../../test/render';
import { AuditLogPage } from './audit-log-page';

const TARGET = '00000000-0000-4000-8000-0000000000d1';

function entry(overrides: Partial<AuditLogEntry>): AuditLogEntry {
  return {
    id: '00000000-0000-4000-8000-0000000000f1',
    createdAt: '2026-11-16T03:04:00.000Z',
    action: 'admin.user.created',
    actorId: SELF_ID,
    actorEmail: 'owner@example.test',
    targetType: 'user',
    targetId: TARGET,
    targetEmail: 'new@example.com',
    meta: { role: 'photographer', email: 'new@example.com' },
    ...overrides,
  };
}

function setup(entries: AuditLogEntry[]) {
  const api = new FakeAdminApi();
  api.auditLog = entries;
  const user = userEvent.setup();
  renderWithProviders(<AuditLogPage />, { fetch: api.fetch });
  return { api, user };
}

describe('AuditLogPage (ADR 0027 §1)', () => {
  it('lists time in Bangkok, the Thai label, actor and target, raw meta on expand', async () => {
    const { user } = setup([
      entry({}),
      entry({
        id: '00000000-0000-4000-8000-0000000000f2',
        action: 'package.order_paid',
        actorId: null,
        actorEmail: null,
        targetType: 'package_order',
        targetId: '00000000-0000-4000-8000-0000000000a1',
        targetEmail: null,
        meta: {},
      }),
      entry({ id: '00000000-0000-4000-8000-0000000000f3', action: 'takedown.share', meta: {} }),
    ]);
    const rows = await screen.findAllByTestId('audit-row');
    expect(rows).toHaveLength(3);
    const first = within(rows[0]!);
    // 03:04 UTC is 10:04 in Bangkok.
    expect(first.getByText('16 พ.ย. 2569 10:04')).toBeInTheDocument();
    expect(first.getByText('สร้างผู้ใช้')).toBeInTheDocument();
    expect(first.getByText('admin.user.created')).toBeInTheDocument();
    expect(first.getByRole('link', { name: 'owner@example.test' })).toHaveAttribute(
      'href',
      `/users/${SELF_ID}`,
    );
    expect(first.getByRole('link', { name: 'new@example.com' })).toHaveAttribute(
      'href',
      `/users/${TARGET}`,
    );

    const second = within(rows[1]!);
    expect(second.getByText('ชำระค่าแพ็กเกจแล้ว')).toBeInTheDocument();
    expect(second.getByText('ระบบ')).toBeInTheDocument();
    expect(second.getByText('คำสั่งซื้อแพ็กเกจ')).toBeInTheDocument();
    expect(second.queryByRole('link')).toBeNull();
    expect(second.getByText('ไม่มีรายละเอียด')).toBeInTheDocument();

    // Unknown actions show the raw string.
    expect(within(rows[2]!).getByText('takedown.share')).toBeInTheDocument();

    await user.click(first.getByRole('button', { name: 'ดูรายละเอียด' }));
    expect(screen.getByText(/"role": "photographer"/)).toBeInTheDocument();
    await user.click(first.getByRole('button', { name: 'ซ่อนรายละเอียด' }));
    expect(screen.queryByText(/"role": "photographer"/)).toBeNull();
  });

  it('filters by group, exact action, actor, target and dates; refuses a bad actor id', async () => {
    const { api, user } = setup([entry({})]);
    await screen.findAllByTestId('audit-row');
    const form = screen.getByRole('search', { name: 'ตัวกรองบันทึกกิจกรรม' });

    await user.selectOptions(within(form).getByLabelText('กลุ่ม'), 'การเงิน');
    await user.click(within(form).getByRole('button', { name: 'กรอง' }));
    await waitFor(() =>
      expect(api.callsOf(ADMIN_ROUTES.auditLog).at(-1)!.search.get('action')).toBe('finance.'),
    );
    expect(await screen.findByText('ไม่พบกิจกรรมที่ตรงกัน')).toBeInTheDocument();

    // The package group also covers Free sign-ups (OR-ed filter values).
    await user.selectOptions(within(form).getByLabelText('กลุ่ม'), 'แพ็กเกจและการสมัคร');
    await user.click(within(form).getByRole('button', { name: 'กรอง' }));
    await waitFor(() =>
      expect(api.callsOf(ADMIN_ROUTES.auditLog).at(-1)!.search.get('action')).toBe(
        'package.,account.self_signup',
      ),
    );
    await user.selectOptions(within(form).getByLabelText('กลุ่ม'), 'การเงิน');

    // The exact list follows the group.
    const actions = within(within(form).getByLabelText('การกระทำ'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(actions).toEqual([
      'ทุกการกระทำ',
      'บันทึกรายจ่าย',
      'ลบรายจ่าย',
      'สร้างคูปองส่วนลด',
      'แก้ไขคูปองส่วนลด',
    ]);
    await user.selectOptions(within(form).getByLabelText('การกระทำ'), 'ลบรายจ่าย');

    await user.type(within(form).getByLabelText('รหัสผู้ทำ'), 'not-a-uuid');
    await user.click(within(form).getByRole('button', { name: 'กรอง' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('รหัสผู้ทำต้องเป็น UUID');

    await user.clear(within(form).getByLabelText('รหัสผู้ทำ'));
    await user.type(within(form).getByLabelText('รหัสผู้ทำ'), SELF_ID);
    await user.type(within(form).getByLabelText('รหัสเป้าหมาย'), TARGET);
    await user.type(within(form).getByLabelText('ตั้งแต่'), '2026-11-01');
    await user.type(within(form).getByLabelText('ถึง'), '2026-11-16');
    await user.click(within(form).getByRole('button', { name: 'กรอง' }));
    await waitFor(() =>
      expect(Object.fromEntries(api.callsOf(ADMIN_ROUTES.auditLog).at(-1)!.search)).toEqual({
        action: 'finance.expense_deleted',
        actorId: SELF_ID,
        targetId: TARGET,
        from: '2026-11-01',
        to: '2026-11-16',
      }),
    );

    await user.click(within(form).getByRole('button', { name: 'ล้างตัวกรอง' }));
    await waitFor(() =>
      expect([...api.callsOf(ADMIN_ROUTES.auditLog).at(-1)!.search.keys()]).toEqual([]),
    );
  });

  it('loads more with the cursor', async () => {
    const entries = Array.from({ length: 3 }, (_, i) =>
      entry({ id: `00000000-0000-4000-8000-00000000010${i}` }),
    );
    const api = new FakeAdminApi();
    api.auditLog = entries;
    api.pageSize = 2;
    const user = userEvent.setup();
    renderWithProviders(<AuditLogPage />, { fetch: api.fetch });
    expect(await screen.findAllByTestId('audit-row')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'โหลดเพิ่ม' }));
    await waitFor(() => expect(screen.getAllByTestId('audit-row')).toHaveLength(3));
    expect(api.callsOf(ADMIN_ROUTES.auditLog).at(-1)!.search.get('cursor')).toBe(
      `c-${entries[1]!.id}`,
    );
    expect(screen.queryByRole('button', { name: 'โหลดเพิ่ม' })).toBeNull();
  });
});
