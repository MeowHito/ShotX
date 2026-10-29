'use client';

import { useEffect, useRef } from 'react';
import { filesFromInput } from '@/lib/upload/dropped-files';
import { UPLOAD_ACCEPT } from '@/lib/upload/precheck';
import { useUploads } from './upload-context';

/**
 * Hidden file inputs for "upload files" and "upload folder" (keeps relative paths), and
 * functions that open them. Picked files go to `folderId` (null: the drive root).
 */
export function useUploadPickers(folderId: string | null) {
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

  const inputs = (
    <>
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

  return {
    inputs,
    pickFiles: () => filesInput.current?.click(),
    pickFolder: () => folderInput.current?.click(),
  };
}
