'use client';

import { Button } from '@shotx/ui';
import { FolderUpIcon, UploadIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import { filesFromInput } from '@/lib/upload/dropped-files';
import { UPLOAD_ACCEPT } from '@/lib/upload/precheck';
import { useUploads } from './upload-context';

/** "Upload files" and "Upload folder" (keeps relative paths) for the current folder. */
export function UploadButtons({
  folderId,
  disabled,
}: {
  folderId: string | null;
  disabled: boolean;
}) {
  const t = useTranslations('drive');
  const { addFiles } = useUploads();
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  // `webkitdirectory` isn't in React's typings; set it on the element.
  useEffect(() => {
    folderInput.current?.setAttribute('webkitdirectory', '');
  }, []);

  function onChange(input: HTMLInputElement | null) {
    if (input?.files && input.files.length > 0) {
      addFiles(filesFromInput(input.files), folderId);
      input.value = '';
    }
  }

  return (
    <>
      <Button onClick={() => filesInput.current?.click()} disabled={disabled}>
        <UploadIcon aria-hidden />
        {t('uploadFiles')}
      </Button>
      <Button
        variant="outline"
        onClick={() => folderInput.current?.click()}
        disabled={disabled}
        className="hidden sm:inline-flex"
      >
        <FolderUpIcon aria-hidden />
        {t('uploadFolder')}
      </Button>
      <input
        ref={filesInput}
        type="file"
        multiple
        accept={UPLOAD_ACCEPT}
        className="hidden"
        data-testid="upload-files-input"
        onChange={(e) => onChange(e.currentTarget)}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        className="hidden"
        data-testid="upload-folder-input"
        onChange={(e) => onChange(e.currentTarget)}
      />
    </>
  );
}
