'use client';

import { ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { folderHref } from './paths';

export interface BreadcrumbsProps {
  /** From the top-level folder down to the current folder's parent (listChildren `ancestors`). */
  ancestors: readonly { id: string; name: string }[];
  /** The current folder; null at the drive root. */
  current: { id: string; name: string } | null;
}

export function Breadcrumbs({ ancestors, current }: BreadcrumbsProps) {
  const t = useTranslations('drive');
  const crumbs = [{ id: null as string | null, name: t('root') }, ...ancestors];
  return (
    <nav aria-label={t('breadcrumbLabel')} className="min-w-0">
      <ol className="flex flex-wrap items-center gap-1 text-sm">
        {crumbs.map((crumb) => (
          <li key={crumb.id ?? 'root'} className="flex min-w-0 items-center gap-1">
            <Link
              href={folderHref(crumb.id)}
              className="max-w-40 truncate text-muted-foreground hover:text-foreground hover:underline"
            >
              {crumb.name}
            </Link>
            <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </li>
        ))}
        <li className="min-w-0">
          <span aria-current="page" className="block max-w-56 truncate font-semibold">
            {current?.name ?? t('root')}
          </span>
        </li>
      </ol>
    </nav>
  );
}
