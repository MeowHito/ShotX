import { UsersPage } from '@/components/users/users-page';
import { adminViewerState } from '@/lib/server/auth';
import { adminConfig } from '@/lib/server/config';

export default async function Users() {
  const viewer = await adminViewerState();
  return (
    <UsersPage currentAdminId={viewer.user?.id ?? null} passwords={adminConfig().ui.passwords} />
  );
}
