'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@shotx/ui';
import { FileUpIcon, FolderPlusIcon, FolderUpIcon, PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { NameDialog } from '@/components/drive/name-dialog';
import { useUploadPickers } from '@/components/upload/upload-pickers';
import { useCreateFolder, useDriveUsage } from '@/lib/drive/queries';
import { shortcutHint } from '@/lib/studio/shortcuts';
import { useStudio } from './studio-context';

/**
 * "+ New" (studio.new): new folder, upload files, upload folder, into the folder the page shows. Registers
 * the commands for the global shortcuts (⌥C / Alt+C, ⇧U / Shift+U). Uploads are disabled while
 * the API blocks them (quota or subscription).
 */
export function NewMenu() {
  const t = useTranslations();
  const studio = useStudio();
  const folderId = studio.currentFolderId;
  const usage = useDriveUsage();
  const uploadsBlocked = (usage.data?.uploadsBlockedBy ?? null) !== null;
  const pickers = useUploadPickers(folderId);
  const createFolder = useCreateFolder();
  const [creating, setCreating] = useState(false);

  // The latest pickers and state for the registered commands.
  const latest = useRef({ pickers, uploadsBlocked });
  useEffect(() => {
    latest.current = { pickers, uploadsBlocked };
  });
  const { register } = studio;
  useEffect(
    () =>
      register({
        newFolder: () => setCreating(true),
        uploadFiles: () => {
          if (!latest.current.uploadsBlocked) latest.current.pickers.pickFiles();
        },
        uploadFolder: () => {
          if (!latest.current.uploadsBlocked) latest.current.pickers.pickFolder();
        },
      }),
    [register],
  );

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            className="h-11 gap-2 rounded-full px-3.5 shadow-sm sm:px-4"
            title={t('studio.newMenu')}
          >
            <PlusIcon className="size-5" aria-hidden />
            <span className="max-sm:sr-only">{t('studio.new')}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" collisionPadding={12}>
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <FolderPlusIcon aria-hidden />
            {t('drive.newFolder')}
            <DropdownMenuShortcut>{shortcutHint('newFolder', studio.apple)}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={uploadsBlocked} onSelect={pickers.pickFiles}>
            <FileUpIcon aria-hidden />
            {t('drive.uploadFiles')}
            <DropdownMenuShortcut>{shortcutHint('upload', studio.apple)}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={uploadsBlocked} onSelect={pickers.pickFolder}>
            <FolderUpIcon aria-hidden />
            {t('drive.uploadFolder')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {pickers.inputs}
      <NameDialog
        open={creating}
        onOpenChange={setCreating}
        title={t('createFolder.title')}
        label={t('createFolder.nameLabel')}
        placeholder={t('createFolder.placeholder')}
        submitLabel={t('createFolder.submit')}
        onSubmit={(name) => createFolder.mutateAsync({ parentId: folderId, name })}
      />
    </>
  );
}
