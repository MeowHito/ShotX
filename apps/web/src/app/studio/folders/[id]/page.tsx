import { idSchema } from '@shotx/shared';
import { notFound } from 'next/navigation';
import { DriveBrowser } from '@/components/drive/drive-browser';

export default async function StudioFolderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) notFound();
  return <DriveBrowser key={id} folderRef={id} />;
}
