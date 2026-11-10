import { ADMIN_ROUTES, ErrorCode } from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeAdminApi, makeUser, SELF_ID } from '../../../test/fake-admin-api';
import { renderWithProviders, TEST_PASSWORDS } from '../../../test/render';
import { UsersPage } from './users-page';

function renderPage(api: FakeAdminApi) {
  return renderWithProviders(<UsersPage currentAdminId={SELF_ID} passwords={TEST_PASSWORDS} />, {
    fetch: api.fetch,
  });
}

async function openMenu(user: ReturnType<typeof userEvent.setup>, email: string) {
  await user.click(await screen.findByRole('button', { name: `จัดการบัญชี ${email}` }));
}

describe('UsersPage', () => {
  it('searches, filters and loads more pages with the cursor', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi(
      Array.from({ length: 4 }, (_, i) =>
        makeUser({ email: `p${i}@example.com`, name: `Photographer ${i}` }),
      ),
    );
    api.pageSize = 3;
    renderPage(api);

    expect(await screen.findByText('owner@example.test')).toBeInTheDocument();
    expect(screen.queryByText('p3@example.com')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'โหลดเพิ่ม' }));
    expect(await screen.findByText('p3@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'โหลดเพิ่ม' })).not.toBeInTheDocument();
    const [, second] = api.callsOf(ADMIN_ROUTES.listUsers);
    expect(second!.search.get('cursor')).toBeTruthy();

    await user.selectOptions(screen.getByLabelText('บทบาท'), 'admin');
    await waitFor(() => expect(screen.queryByText('p0@example.com')).not.toBeInTheDocument());
    expect(api.callsOf(ADMIN_ROUTES.listUsers).at(-1)!.search.get('role')).toBe('admin');
    expect(api.callsOf(ADMIN_ROUTES.listUsers).at(-1)!.search.get('cursor')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'ล้างตัวกรอง' }));
    await user.type(screen.getByLabelText('ค้นหาด้วยอีเมลหรือชื่อ'), '  photographer 2 {Enter}');
    expect(await screen.findByText('p2@example.com')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('p1@example.com')).not.toBeInTheDocument());
    expect(api.callsOf(ADMIN_ROUTES.listUsers).at(-1)!.search.get('q')).toBe('photographer 2');

    await user.clear(screen.getByLabelText('ค้นหาด้วยอีเมลหรือชื่อ'));
    await user.type(screen.getByLabelText('ค้นหาด้วยอีเมลหรือชื่อ'), 'nobody{Enter}');
    expect(await screen.findByText('ไม่พบผู้ใช้ที่ตรงกัน')).toBeInTheDocument();
  });

  it('disables an account only after confirmation', async () => {
    const user = userEvent.setup();
    const target = makeUser({ email: 'photo@example.com', name: 'Photo' });
    const api = new FakeAdminApi([target]);
    renderPage(api);

    await openMenu(user, 'photo@example.com');
    await user.click(screen.getByRole('menuitem', { name: 'ปิดใช้งาน' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('ปิดใช้งานบัญชี photo@example.com?')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/ลิงก์แชร์ทั้งหมดของตากล้องคนนี้จะใช้ไม่ได้/),
    ).toBeInTheDocument();
    expect(api.callsOf(ADMIN_ROUTES.updateUser)).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'ปิดใช้งานบัญชี' }));
    expect(await screen.findByText('ปิดใช้งาน photo@example.com แล้ว')).toBeInTheDocument();
    expect(api.callsOf(ADMIN_ROUTES.updateUser)[0]!.body).toEqual({ status: 'disabled' });
    await waitFor(() =>
      expect(
        within(screen.getByText('photo@example.com').closest('tr')!).getByText('ปิดใช้งาน'),
      ).toBeInTheDocument(),
    );
  });

  it('shows LAST_ADMIN and CANNOT_MODIFY_SELF refusals in the dialog', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi([
      makeUser({ email: 'other.admin@example.com', role: 'admin', usedBytes: null }),
    ]);
    renderPage(api);
    api.failNext(ADMIN_ROUTES.updateUser, ErrorCode.LAST_ADMIN);
    await openMenu(user, 'other.admin@example.com');
    await user.click(screen.getByRole('menuitem', { name: 'ปิดใช้งาน' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'ปิดใช้งานบัญชี' }));
    expect(await within(dialog).findByText(/แอดมินคนสุดท้าย/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'ยกเลิก' }));

    api.failNext(ADMIN_ROUTES.resetPassword, ErrorCode.CANNOT_MODIFY_SELF);
    await openMenu(user, 'other.admin@example.com');
    await user.click(screen.getByRole('menuitem', { name: 'รีเซ็ตรหัสผ่าน' }));
    const reset = await screen.findByRole('dialog');
    await user.click(within(reset).getByRole('button', { name: 'สุ่มรหัสผ่าน' }));
    await user.click(within(reset).getByRole('button', { name: 'รีเซ็ตรหัสผ่าน' }));
    expect(await within(reset).findByText(/บัญชีของตัวเองไม่ได้/)).toBeInTheDocument();
    expect(within(reset).queryByTestId('one-time-password')).not.toBeInTheDocument();
  });

  it('resets a password and shows it once', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi([makeUser({ email: 'photo@example.com' })]);
    renderPage(api);
    await openMenu(user, 'photo@example.com');
    await user.click(screen.getByRole('menuitem', { name: 'รีเซ็ตรหัสผ่าน' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/ผู้ใช้จะออกจากระบบทุกอุปกรณ์/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'สุ่มรหัสผ่าน' }));
    const password = within(dialog).getByLabelText<HTMLInputElement>('รหัสผ่านชั่วคราว').value;
    await user.click(within(dialog).getByRole('button', { name: 'รีเซ็ตรหัสผ่าน' }));
    expect(await within(dialog).findByTestId('one-time-password')).toHaveTextContent(password);
    expect(api.callsOf(ADMIN_ROUTES.resetPassword)[0]!.body).toEqual({ password });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(document.body.innerHTML).not.toContain(password);
    // The list shows the temporary-password badge from the refreshed data.
    expect(
      await within(screen.getByText('photo@example.com').closest('tr')!).findByText('รหัสชั่วคราว'),
    ).toBeInTheDocument();
  });

  it('renames an account', async () => {
    const user = userEvent.setup();
    const api = new FakeAdminApi([makeUser({ email: 'photo@example.com', name: 'Old' })]);
    renderPage(api);
    await openMenu(user, 'photo@example.com');
    await user.click(screen.getByRole('menuitem', { name: 'เปลี่ยนชื่อ' }));
    const dialog = await screen.findByRole('dialog');
    const input = within(dialog).getByLabelText('ชื่อที่แสดง');
    await user.clear(input);
    await user.type(input, '  New name ');
    await user.click(within(dialog).getByRole('button', { name: 'บันทึกชื่อ' }));
    expect(await screen.findByText('เปลี่ยนชื่อแล้ว')).toBeInTheDocument();
    expect(api.callsOf(ADMIN_ROUTES.updateUser)[0]!.body).toEqual({ name: 'New name' });
    expect(await screen.findByText('New name')).toBeInTheDocument();
  });

  it('sends the browser to sign in when the session has ended', async () => {
    const api = new FakeAdminApi();
    api.failNext(ADMIN_ROUTES.listUsers, ErrorCode.MFA_REQUIRED);
    const { onSessionEnded } = renderPage(api);
    await waitFor(() => expect(onSessionEnded).toHaveBeenCalled());
  });
});
