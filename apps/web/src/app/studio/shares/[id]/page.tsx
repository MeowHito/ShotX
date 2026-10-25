import { idSchema } from '@shotx/shared';
import { notFound } from 'next/navigation';
import { ShareDetails } from '@/components/shares/share-details';

export default async function StudioSharePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) notFound();
  return <ShareDetails key={id} shareId={id} />;
}
