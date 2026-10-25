import { DRIVE_ROOT } from '@shotx/shared';
import { DriveBrowser } from '@/components/drive/drive-browser';

export default function StudioRootPage() {
  return <DriveBrowser folderRef={DRIVE_ROOT} />;
}
