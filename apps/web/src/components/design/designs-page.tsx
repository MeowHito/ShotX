'use client';

import { useRouter } from 'next/navigation';
import { designHref } from '@/components/drive/paths';
import { DesignsList } from './designs-list';

/** /studio/designs wired to the App Router: a new design opens in the editor. */
export function DesignsPage() {
  const router = useRouter();
  return <DesignsList onOpen={(id) => router.push(designHref(id))} />;
}
