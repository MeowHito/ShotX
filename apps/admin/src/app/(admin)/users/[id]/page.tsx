import { idSchema } from '@shotx/shared';
import { notFound } from 'next/navigation';
import { UserDetail } from '@/components/users/user-detail';
import { adminViewerState } from '@/lib/server/auth';
import { adminConfig } from '@/lib/server/config';

export default async function UserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) notFound();
  const viewer = await adminViewerState();
  return (
    <UserDetail
      userId={id}
      currentAdminId={viewer.user?.id ?? null}
      passwords={adminConfig().ui.passwords}
    />
  );
}
