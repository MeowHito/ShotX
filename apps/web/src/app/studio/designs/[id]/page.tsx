import { idSchema } from '@shotx/shared';
import { notFound } from 'next/navigation';
import { DesignEditorPage } from '@/components/design/editor/design-editor';

export default async function StudioDesignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!idSchema.safeParse(id).success) notFound();
  return <DesignEditorPage key={id} designId={id} />;
}
