'use client';

import {
  type DriveFile,
  type DriveFolder,
  type DriveItem,
  folderIdFromRef,
  type FolderRef,
  type OwnerShare,
} from '@shotx/shared';
import { Alert, Button, cn, Input, Skeleton } from '@shotx/ui';
import {
  CloudUploadIcon,
  CopyIcon,
  DownloadIcon,
  EyeIcon,
  EyeOffIcon,
  FolderInputIcon,
  FolderKanbanIcon,
  ImageIcon,
  ImageOffIcon,
  InfoIcon,
  LayoutGridIcon,
  LinkIcon,
  ListIcon,
  PencilIcon,
  PlusIcon,
  QrCodeIcon,
  SearchIcon,
  Share2Icon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
  UserPlusIcon,
  XIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useApiClient } from '@/components/providers';
import { useMediaQuery, useStudio } from '@/components/studio/studio-context';
import { useUploads } from '@/components/upload/upload-context';
import { ShareDialog, type ShareTargetRef } from '@/components/shares/share-dialog';
import {
  type CopyResult,
  itemRef,
  useCopyFiles,
  useDownloadFolder,
  useDriveUsage,
  useFolderChildren,
  useMoveItems,
  useRenameItem,
  useSetFolderCover,
  useRestoreItems,
  useTrashItems,
} from '@/lib/drive/queries';
import { pollOwnerZipJob, startBrowserDownload } from '@/lib/downloads/downloads';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { copyToClipboard } from '@/lib/studio/clipboard';
import { useOwnerDownload, useUpdateShare } from '@/lib/studio/queries';
import {
  arrowStep,
  clickModifier,
  matches,
  shortcutHint,
  shouldIgnoreKey,
} from '@/lib/studio/shortcuts';
import { useLayoutPreference } from '@/lib/studio/view-preference';
import { filesFromDataTransfer } from '@/lib/upload/dropped-files';
import { Breadcrumbs } from './breadcrumbs';
import { DetailsPanel } from './details-panel';
import { DriveGrid } from './drive-grid';
import { EventDialog } from './event-dialog';
import { type EventActions, ItemCard } from './item-card';
import { type BuildItemMenu, ItemMenuProvider, ItemMenus, type MenuEntry } from './item-menu';
import { MoveDialog } from './move-dialog';
import { NameDialog } from './name-dialog';
import { QrDialog, type QrTarget } from './qr-dialog';
import { RenameFilesDialog } from './rename-files-dialog';
import { EventInspector } from './event-inspector';
import { type EventCounts, EventsOverview } from './events-overview';
import { eventStatusOf } from './item-card';
import { folderHref, SHARES_HREF, shareHref } from './paths';

type Notice = {
  kind: 'info' | 'error';
  text: string;
  /** A follow-up, e.g. Undo (drive.undo) after moving items to the trash. */
  action?: { label: string; run: () => void };
} | null;

const isReadyFile = (item: DriveItem): item is DriveFile =>
  item.kind === 'file' && item.status === 'ready';

/** Event cards (ADR 0016): a 4:3 cover over the name, created date, status and buttons. */
const EVENT_CELL = { minCellPx: 220, cellAspect: 0.75, captionPx: 112, listRowPx: 96 } as const;

/** ADR 0024: the event filter tabs (by link status). */
const EVENT_TABS = ['all', 'active', 'paused', 'none'] as const;
type EventTab = (typeof EVENT_TABS)[number];

/** Screens where the event inspector sits beside the list (Tailwind `xl`). */
const INSPECTOR_MEDIA = '(min-width: 1280px)';

/** The QR target of an event, or null while it has no link. */
function qrTargetOf(folder: DriveFolder): QrTarget | null {
  const link = folder.event?.link;
  if (link == null || link.status === 'revoked') return null;
  return { name: folder.name, url: link.url, paused: link.status === 'paused' };
}

/**
 * The studio drive: one folder's contents with rename, move, trash, share, details and download,
 * from the item menus (kebab, right-click, long-press), the selection bar and the keyboard
 * (src/lib/studio/shortcuts). New folders and uploads come from the shell's "+ New" (studio.new) menu, which
 * targets the folder this page registers as current.
 */
export function DriveBrowser({
  folderRef,
  startDownload = startBrowserDownload,
}: {
  folderRef: FolderRef;
  /** Tests observe downloads instead of navigating. */
  startDownload?: (url: string, fileName?: string) => void;
}) {
  const t = useTranslations();
  const describe = useErrorMessage();
  const studio = useStudio();
  const apple = studio.apple;
  const folderId = folderIdFromRef(folderRef);
  const api = useApiClient();
  const listing = useFolderChildren(folderRef, {
    processingPollMs: studio.config.processingPollMs,
  });
  const copyFiles = useCopyFiles();
  const downloadFolder = useDownloadFolder();
  const usage = useDriveUsage();
  const uploads = useUploads();
  const renameItem = useRenameItem();
  const setCover = useSetFolderCover();
  const moveItems = useMoveItems();
  const trashItems = useTrashItems();
  const restoreItems = useRestoreItems();
  const ownerDownload = useOwnerDownload();
  const updateShare = useUpdateShare();
  const [layout, setLayout] = useLayoutPreference();
  const [editingEvent, setEditingEvent] = useState<DriveFolder | null>(null);
  const [qr, setQr] = useState<QrTarget | null>(null);

  const [sharing, setSharing] = useState<ShareTargetRef | null>(null);
  const [selected, setSelected] = useState<ReadonlyMap<string, DriveItem>>(new Map());
  const [anchorId, setAnchorId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<DriveFolder | null>(null);
  const [renamingFiles, setRenamingFiles] = useState<DriveFile[] | null>(null);
  const [moving, setMoving] = useState<DriveItem[] | null>(null);
  const [details, setDetails] = useState<DriveItem | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [dragging, setDragging] = useState(false);
  const [eventColumns, setEventColumns] = useState(1);
  const [fileColumns, setFileColumns] = useState(1);
  const [focusTarget, setFocusTarget] = useState<{ id: string; token: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [eventTab, setEventTab] = useState<EventTab>('all');
  const [eventQuery, setEventQuery] = useState('');
  const [inspectedId, setInspectedId] = useState<string | null>(null);
  // ADR 0024: the inspector mounts only where it shows (no QR or stats requests on phones).
  const wide = useMediaQuery(INSPECTOR_MEDIA);

  const items = listing.items;
  // Folders come first in every listing (drive cursor), so the two sections keep that order.
  const allEvents = items.filter((i): i is DriveFolder => i.kind === 'folder');
  // ADR 0024: the tabs and the name filter narrow the events shown (the loaded ones).
  const eventCounts: EventCounts & { none: number } = {
    total: allEvents.length,
    published: allEvents.filter((e) => eventStatusOf(e) === 'active').length,
    paused: allEvents.filter((e) => eventStatusOf(e) === 'paused').length,
    none: allEvents.filter((e) => eventStatusOf(e) === 'none').length,
  };
  const needle = eventQuery.normalize('NFC').trim().toLowerCase();
  const events = allEvents.filter(
    (e) =>
      (eventTab === 'all' || eventStatusOf(e) === eventTab) &&
      (needle === '' || e.name.toLowerCase().includes(needle)),
  );
  const inspected =
    allEvents.find((e) => e.id === inspectedId) ??
    allEvents.find((e) => eventStatusOf(e) === 'active') ??
    allEvents[0] ??
    null;
  const fileItems = items.filter((i) => i.kind === 'file');
  const uploadsBlocked = usage.data?.uploadsBlockedBy ?? null;
  const selection = [...selected.values()];
  const location = listing.folder?.name ?? t('drive.root');

  // The "+ New" (studio.new) menu and search scope follow this folder.
  const { setCurrentFolder } = studio;
  useEffect(() => {
    setCurrentFolder(folderId);
    return () => setCurrentFolder(null);
  }, [folderId, setCurrentFolder]);

  function toggle(item: DriveItem) {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.set(item.id, item);
      return next;
    });
    setAnchorId(item.id);
  }

  function selectRange(fromId: string | null, toId: string) {
    const to = items.findIndex((i) => i.id === toId);
    const from = fromId === null ? to : items.findIndex((i) => i.id === fromId);
    if (to < 0) return;
    const [lo, hi] = from < 0 ? [to, to] : [Math.min(from, to), Math.max(from, to)];
    setSelected(new Map(items.slice(lo, hi + 1).map((i) => [i.id, i])));
    if (fromId === null || from < 0) setAnchorId(toId);
  }

  const clearSelection = useCallback(() => {
    setSelected(new Map());
    setAnchorId(null);
  }, []);

  /** ADR 0023: files get the rename dialog with numbering; folders keep the name dialog. */
  function startRename(targets: readonly DriveItem[]) {
    const single = targets.length === 1 ? targets[0] : undefined;
    if (single?.kind === 'folder') setRenaming(single);
    else if (targets.every((i) => i.kind === 'file')) setRenamingFiles(targets as DriveFile[]);
  }

  /** Every trash path (menu, shortcut, selection bar) comes here, so each one can be undone. */
  async function trash(targets: DriveItem[]) {
    const refs = targets.map(itemRef);
    try {
      await trashItems.mutateAsync(refs);
      clearSelection();
      setNotice({
        kind: 'info',
        text: t('drive.trashed', { count: targets.length }),
        action: { label: t('drive.undo'), run: () => void undoTrash(refs) },
      });
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    }
  }

  async function undoTrash(refs: ReturnType<typeof itemRef>[]) {
    try {
      await restoreItems.mutateAsync(refs);
      setNotice({ kind: 'info', text: t('trash.restored', { count: refs.length }) });
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    }
  }

  async function move(targetId: string | null) {
    const targets = moving ?? [];
    const result = await moveItems.mutateAsync({ items: targets.map(itemRef), targetId });
    clearSelection();
    if (result.failures.length === 0) {
      setNotice({ kind: 'info', text: t('drive.moved', { count: result.moved }) });
    } else {
      setNotice({
        kind: 'error',
        text: t('move.partialFailure', {
          count: result.failures.length,
          reason: describe(result.failures[0]?.error),
        }),
      });
    }
  }

  async function download(fileId: string) {
    try {
      const signed = await ownerDownload.mutateAsync(fileId);
      startDownload(signed.url, signed.fileName);
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    }
  }

  /** Copies files into `targetFolderId` and says how it went. */
  async function copyInto(files: readonly DriveFile[], targetFolderId: string | null) {
    let result: CopyResult;
    try {
      result = await copyFiles.mutateAsync({ files, targetFolderId });
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
      return;
    }
    if (result.failures.length === 0) {
      setNotice({ kind: 'info', text: t('itemMenu.copied', { count: result.copies.length }) });
    } else {
      setNotice({
        kind: 'error',
        text: t('itemMenu.copyPartial', {
          count: result.failures.length,
          reason: describe(result.failures[0]?.error),
        }),
      });
    }
  }

  /** The owner ZIP of a folder: start the job, poll it, then download the archive. */
  async function downloadZip(folder: DriveFolder) {
    try {
      setNotice({ kind: 'info', text: t('downloads.zipStatus.queued') });
      const job = await downloadFolder.mutateAsync({
        folderId: folder.id,
        idempotencyKey: crypto.randomUUID(),
      });
      const ready = await pollOwnerZipJob(api, job, {
        intervalMs: studio.config.zipPollIntervalMs,
        timeoutMs: studio.config.zipPollTimeoutMs,
        onUpdate: (current) =>
          setNotice({ kind: 'info', text: t(`downloads.zipStatus.${current.status}`) }),
      });
      startDownload(ready.download.url, ready.download.fileName);
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    }
  }

  /** Unpublish or publish an event's link again (the same URL, ADR 0016). */
  async function setPublished(folder: DriveFolder, published: boolean) {
    const link = folder.event?.link;
    if (link == null) return;
    try {
      await updateShare.mutateAsync({ id: link.shareId, body: { paused: !published } });
      setNotice({
        kind: 'info',
        text: t(published ? 'event.published' : 'event.unpublished', { name: folder.name }),
      });
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    }
  }

  function eventActionsFor(folder: DriveFolder): EventActions {
    const target = qrTargetOf(folder);
    const link = folder.event?.link ?? null;
    return {
      onEdit: () => setEditingEvent(folder),
      onQr: target === null ? null : () => setQr(target),
      // ADR 0024: wide screens show the numbers beside the list; others open the link's page
      // (an event without a link opens its edit dialog, where the link is made).
      stats: {
        href: link === null ? null : shareHref(link.shareId),
        media: INSPECTOR_MEDIA,
        onInspect: () => {
          setInspectedId(folder.id);
          if (!window.matchMedia(INSPECTOR_MEDIA).matches) setEditingEvent(folder);
        },
      },
      onCopyLink: link === null || link.status === 'revoked' ? null : () => void copyLink(link),
      inspected: folderId === null && wide && inspected?.id === folder.id,
    };
  }

  async function copyLink(share: Pick<OwnerShare, 'url'>) {
    try {
      await copyToClipboard(share.url);
      setNotice({ kind: 'info', text: t('itemMenu.linkCopied') });
    } catch (error) {
      setNotice({ kind: 'error', text: describe(error) });
    }
  }

  function onDragOver(event: DragEvent) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = uploadsBlocked === null ? 'copy' : 'none';
    setDragging(true);
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    setDragging(false);
    if (uploadsBlocked !== null) {
      setNotice({ kind: 'error', text: t(`usage.blocked.${uploadsBlocked}`) });
      return;
    }
    void filesFromDataTransfer(event.dataTransfer).then((files) =>
      uploads.addFiles(files, folderId),
    );
  }

  async function changeCover(coverFolderId: string, fileId: string | null) {
    try {
      await setCover.mutateAsync({ folderId: coverFolderId, fileId });
      setNotice({
        kind: 'info',
        text: fileId === null ? t('itemMenu.coverResetDone') : t('itemMenu.coverSetDone'),
      });
    } catch (err) {
      setNotice({ kind: 'error', text: describe(err) });
    }
  }

  /** The menu of `targets` (one item, or the selection the item belongs to). */
  const buildMenu: BuildItemMenu = (targets, shares) => {
    const single = targets.length === 1 ? targets[0] : undefined;
    const soon = t('itemMenu.soon');
    const entries: MenuEntry[] = [];
    if (single?.kind === 'folder') {
      // ADR 0016: the event's own actions first.
      const link = single.event?.link ?? null;
      const target = qrTargetOf(single);
      entries.push({
        type: 'item',
        id: 'edit-event',
        label: t('event.editEvent'),
        icon: PencilIcon,
        onSelect: () => setEditingEvent(single),
      });
      entries.push({
        type: 'item',
        id: 'event-qr',
        label: t('event.qr'),
        icon: QrCodeIcon,
        disabled: target === null,
        onSelect: () => {
          if (target !== null) setQr(target);
        },
      });
      if (link !== null && link.status !== 'revoked') {
        const paused = link.status === 'paused';
        entries.push({
          type: 'item',
          id: 'event-publish',
          label: paused ? t('event.publish') : t('event.unpublish'),
          icon: paused ? EyeIcon : EyeOffIcon,
          onSelect: () => void setPublished(single, paused),
        });
      }
      entries.push({ type: 'separator', id: 'sep-event' });
    }
    if (single?.kind === 'file' && single.status === 'ready') {
      entries.push({
        type: 'item',
        id: 'download',
        label: t('itemMenu.download'),
        icon: DownloadIcon,
        hint: shortcutHint('download', apple),
        onSelect: () => void download(single.id),
      });
    } else if (single?.kind === 'file') {
      // Still uploading or processing: there is nothing to download yet.
      entries.push({
        type: 'item',
        id: 'download',
        label: t('itemMenu.download'),
        icon: DownloadIcon,
        disabled: true,
        onSelect: () => undefined,
      });
    } else if (single?.kind === 'folder') {
      entries.push({
        type: 'item',
        id: 'download',
        label: t('itemMenu.downloadZip'),
        icon: DownloadIcon,
        hint: shortcutHint('download', apple),
        onSelect: () => void downloadZip(single),
      });
    } else {
      // Several items: needs a selection ZIP endpoint (only folders and single files have one).
      entries.push({
        type: 'item',
        id: 'download',
        label: t('itemMenu.downloadZip'),
        icon: DownloadIcon,
        hint: soon,
        disabled: true,
        onSelect: () => undefined,
      });
    }
    if (single !== undefined || targets.every((i) => i.kind === 'file')) {
      entries.push({
        type: 'item',
        id: 'rename',
        label: t('itemMenu.rename'),
        icon: PencilIcon,
        hint: shortcutHint('rename', apple),
        onSelect: () => startRename(targets),
      });
    }
    if (targets.every((i) => i.kind === 'file')) {
      // A copy in the same folder ("name (2).jpg"); ⌘C then ⌘V copies into another folder.
      const files = targets.filter(isReadyFile);
      entries.push({
        type: 'item',
        id: 'copy',
        label: t('itemMenu.copy'),
        icon: CopyIcon,
        hint: `${shortcutHint('copy', apple)} ${shortcutHint('paste', apple)}`,
        disabled: files.length !== targets.length,
        onSelect: () => void copyInto(files, folderId),
      });
    }
    entries.push({ type: 'separator', id: 'sep-1' });
    if (single !== undefined) {
      const shareable = single.kind === 'folder' || single.status === 'ready';
      const active = shares?.filter((s) => s.status === 'active') ?? [];
      const shareEntries: MenuEntry[] = [];
      if (shareable) {
        shareEntries.push({
          type: 'item',
          id: 'create-share',
          label: t('itemMenu.createShare'),
          icon: UserPlusIcon,
          onSelect: () => setSharing({ type: single.kind, id: single.id, name: single.name }),
        });
      }
      const newest = shares?.[0];
      shareEntries.push({
        type: 'link',
        id: 'manage-shares',
        label: t('itemMenu.manageShares'),
        icon: SquareArrowOutUpRightIcon,
        href: newest !== undefined && shares?.length === 1 ? shareHref(newest.id) : SHARES_HREF,
      });
      const link = active[0];
      if (link !== undefined) {
        shareEntries.push({
          type: 'item',
          id: 'copy-link',
          label: t('itemMenu.copyLink'),
          icon: LinkIcon,
          onSelect: () => void copyLink(link),
        });
      }
      entries.push({
        type: 'sub',
        id: 'share',
        label: t('itemMenu.share'),
        icon: Share2Icon,
        entries: shareEntries,
      });
    }
    const organize: MenuEntry[] = [
      {
        type: 'item',
        id: 'move',
        label: t('itemMenu.moveTo'),
        icon: FolderInputIcon,
        onSelect: () => setMoving(targets),
      },
    ];
    // The share page's cover (ADR 0011): a photo of this folder, or back to the first photo.
    // Face indexing is always on (ADR 0011 decision 1), so there is no face setting here.
    const currentFolder = listing.folder;
    if (single?.kind === 'file' && currentFolder !== null && single.folderId === currentFolder.id) {
      if (currentFolder.coverFileId === single.id) {
        organize.push({
          type: 'item',
          id: 'cover-reset',
          label: t('itemMenu.coverReset'),
          icon: ImageOffIcon,
          onSelect: () => void changeCover(currentFolder.id, null),
        });
      } else if (single.mediaKind === 'image') {
        organize.push({
          type: 'item',
          id: 'cover-set',
          label: t('itemMenu.coverSet'),
          icon: ImageIcon,
          disabled: single.status !== 'ready',
          onSelect: () => void changeCover(currentFolder.id, single.id),
        });
      }
    }
    if (single?.kind === 'folder' && single.coverFileId !== null) {
      organize.push({
        type: 'item',
        id: 'cover-reset',
        label: t('itemMenu.coverReset'),
        icon: ImageOffIcon,
        onSelect: () => void changeCover(single.id, null),
      });
    }
    entries.push({
      type: 'sub',
      id: 'organize',
      label: t('itemMenu.organize'),
      icon: FolderKanbanIcon,
      entries: organize,
    });
    if (single !== undefined) {
      entries.push({
        type: 'item',
        id: 'info',
        label: single.kind === 'folder' ? t('itemMenu.folderInfo') : t('itemMenu.fileInfo'),
        icon: InfoIcon,
        onSelect: () => setDetails(single),
      });
    }
    entries.push({ type: 'separator', id: 'sep-2' });
    entries.push({
      type: 'item',
      id: 'trash',
      label: t('itemMenu.trash'),
      icon: Trash2Icon,
      hint: shortcutHint('trash', apple),
      destructive: true,
      onSelect: () => void trash(targets),
    });
    return entries;
  };

  /** The item that has keyboard focus inside the grid, if any. */
  function focusedItem(): DriveItem | undefined {
    const active = document.activeElement;
    const grid = gridRef.current;
    if (!(active instanceof Element) || grid === null || !grid.contains(active)) return undefined;
    const holder =
      active.closest('[data-item-id]') ??
      active.closest('[role="listitem"]')?.querySelector('[data-item-id]');
    const id = holder?.getAttribute('data-item-id');
    return items.find((i) => i.id === id);
  }

  // Page shortcuts (the shell handles new folder, upload, search and help).
  const onShortcut = useRef<(event: globalThis.KeyboardEvent) => void>(() => undefined);
  const handleShortcut = (event: globalThis.KeyboardEvent) => {
    if (event.defaultPrevented || shouldIgnoreKey(event)) return;
    const focused = focusedItem();
    const targets = selection.length > 0 ? selection : focused !== undefined ? [focused] : [];
    const single = targets.length === 1 ? targets[0] : undefined;
    if (matches('selectAll', event, apple) && items.length > 0) {
      event.preventDefault();
      setSelected(new Map(items.map((i) => [i.id, i])));
    } else if (matches('clearSelection', event, apple) && selection.length > 0) {
      event.preventDefault();
      clearSelection();
    } else if (
      matches('rename', event, apple) &&
      (single !== undefined || (targets.length > 1 && targets.every((i) => i.kind === 'file')))
    ) {
      event.preventDefault();
      startRename(targets);
    } else if (matches('trash', event, apple) && targets.length > 0) {
      event.preventDefault();
      void trash(targets);
    } else if (matches('download', event, apple) && single !== undefined) {
      if (isReadyFile(single)) {
        event.preventDefault();
        void download(single.id);
      } else if (single.kind === 'folder') {
        event.preventDefault();
        void downloadZip(single);
      }
    } else if (matches('copy', event, apple) && targets.length > 0) {
      // Only when items are the target: otherwise ⌘C / Ctrl+C keeps copying selected text.
      event.preventDefault();
      const files = targets.filter(isReadyFile);
      if (files.length !== targets.length) {
        setNotice({ kind: 'error', text: t('itemMenu.copyFilesOnly') });
        return;
      }
      studio.setClipboard(files);
      setNotice({
        kind: 'info',
        text: t('itemMenu.clipboard', {
          count: files.length,
          paste: shortcutHint('paste', apple),
        }),
      });
    } else if (matches('paste', event, apple) && studio.clipboard.length > 0) {
      event.preventDefault();
      void copyInto(studio.clipboard, folderId);
    }
  };
  useEffect(() => {
    onShortcut.current = handleShortcut;
  });
  useEffect(() => {
    const listener = (event: globalThis.KeyboardEvent) => onShortcut.current(event);
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);

  // Arrow keys move focus between items; with Shift they extend the selection.
  function onGridKeyDown(event: KeyboardEvent) {
    if (shouldIgnoreKey(event.nativeEvent)) return;
    const current = focusedItem();
    const step = arrowStep(event, current?.kind === 'folder' ? eventColumns : fileColumns);
    if (step === null || current === undefined) return;
    const index = items.findIndex((i) => i.id === current.id);
    const nextIndex = Math.min(items.length - 1, Math.max(0, index + step));
    const next = items[nextIndex];
    if (next === undefined) return;
    event.preventDefault();
    if (event.shiftKey) selectRange(anchorId ?? current.id, next.id);
    if (event.shiftKey && anchorId === null) setAnchorId(current.id);
    setFocusTarget((prev) => ({ id: next.id, token: (prev?.token ?? 0) + 1 }));
  }

  function onItemClick(item: DriveItem, event: MouseEvent) {
    const modifier = clickModifier(event, apple);
    if (modifier === 'range') {
      event.preventDefault();
      selectRange(anchorId, item.id);
      return;
    }
    // ⌘/Ctrl+click, or any tap while something is selected (selection mode on phones).
    if (modifier === 'toggle' || selected.size > 0 || item.kind === 'file') {
      event.preventDefault();
      toggle(item);
    }
  }

  const targetsFor = (item: DriveItem) =>
    selected.has(item.id) && selected.size > 1 ? selection : [item];
  const focusIndexIn = (section: readonly DriveItem[]) =>
    focusTarget === null ? null : section.findIndex((i) => i.id === focusTarget.id);

  const renderItem = (item: DriveItem) => {
    const targets = targetsFor(item);
    return (
      <ItemMenus
        targets={targets}
        label={t('drive.itemActions', { name: item.name })}
        title={targets.length > 1 ? t('itemMenu.selection', { count: targets.length }) : item.name}
      >
        {(kebab) => (
          <ItemCard
            item={item}
            layout={layout}
            selected={selected.has(item.id)}
            selectionMode={selected.size > 0}
            onToggleSelect={() => toggle(item)}
            onPrimaryClick={(event) => onItemClick(item, event)}
            onPreview={() => setDetails(item)}
            focusRequest={focusTarget?.id === item.id ? focusTarget.token : undefined}
            href={item.kind === 'folder' ? folderHref(item.id) : null}
            subtitle={
              item.kind === 'file' && listing.folder?.coverFileId === item.id
                ? t('itemMenu.coverBadge')
                : undefined
            }
            eventActions={item.kind === 'folder' ? eventActionsFor(item) : undefined}
            actions={kebab}
          />
        )}
      </ItemMenus>
    );
  };

  const viewToggle = (
    <div
      role="radiogroup"
      aria-label={t('view.label')}
      className="flex rounded-lg border bg-sidebar p-0.5"
    >
      {(
        [
          ['grid', LayoutGridIcon, t('view.grid')],
          ['list', ListIcon, t('view.list')],
        ] as const
      ).map(([value, Icon, label]) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={layout === value}
          aria-label={label}
          title={label}
          onClick={() => setLayout(value)}
          className={cn(
            'flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-9',
            layout === value && 'bg-background text-primary shadow-card ring-1 ring-border',
          )}
        >
          <Icon className="size-4" aria-hidden />
        </button>
      ))}
    </div>
  );

  return (
    <ItemMenuProvider value={buildMenu}>
      <div
        className={cn(
          'relative min-h-[60dvh] space-y-4',
          dragging && 'rounded-xl ring-2 ring-primary',
        )}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setDragging(false);
        }}
        onDrop={onDrop}
      >
        {folderId === null ? (
          // ADR 0024: the Events page header: title, what it is, and the two main actions.
          <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div className="space-y-1">
              <h1 className="font-display text-3xl font-bold tracking-[-0.025em]">
                {t('drive.root')}
              </h1>
              <p className="text-sm text-muted-foreground">{t('events.pageHint')}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                className="h-11 sm:h-10"
                disabled={uploadsBlocked !== null}
                onClick={() => studio.run('uploadFiles')}
              >
                <CloudUploadIcon className="text-primary dark:text-cyan-300" aria-hidden />
                {t('drive.uploadFiles')}
              </Button>
              <Button
                type="button"
                className="h-11 shadow-featured sm:h-10"
                onClick={() => studio.run('newFolder')}
              >
                <PlusIcon aria-hidden />
                {t('drive.newFolder')}
              </Button>
            </div>
          </header>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Breadcrumbs ancestors={listing.ancestors} current={listing.folder} />
            {viewToggle}
          </div>
        )}

        {folderId === null ? (
          <EventsOverview
            events={{
              total: eventCounts.total,
              published: eventCounts.published,
              paused: eventCounts.paused,
            }}
          />
        ) : null}

        {uploadsBlocked !== null ? (
          <Alert variant="warning">{t(`usage.blocked.${uploadsBlocked}`)}</Alert>
        ) : null}

        {notice !== null ? (
          <Alert
            variant={notice.kind === 'error' ? 'destructive' : 'default'}
            className="flex items-start justify-between gap-2"
          >
            <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span>{notice.text}</span>
              {notice.action !== undefined ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9"
                  disabled={restoreItems.isPending}
                  onClick={notice.action.run}
                >
                  {notice.action.label}
                </Button>
              ) : null}
            </span>
            <button
              type="button"
              onClick={() => setNotice(null)}
              aria-label={t('common.close')}
              className="rounded p-0.5 hover:bg-muted"
            >
              <XIcon className="size-4" aria-hidden />
            </button>
          </Alert>
        ) : null}

        {selection.length > 0 ? (
          <div
            className={cn(
              'z-30 flex items-center gap-2 border bg-background/95 p-2 shadow-lg backdrop-blur',
              // Phones: a bottom action bar over the content; larger: a bar above the grid.
              'fixed inset-x-0 bottom-0 rounded-t-2xl pb-[max(0.5rem,env(safe-area-inset-bottom))]',
              'sm:sticky sm:top-[4.75rem] sm:bottom-auto sm:rounded-xl sm:pb-2',
            )}
          >
            <Button
              size="icon"
              variant="ghost"
              onClick={clearSelection}
              aria-label={t('drive.clearSelection')}
              className="size-11 sm:size-9"
            >
              <XIcon aria-hidden />
            </Button>
            <span className="px-1 text-sm font-medium" role="status">
              {t('drive.selectedCount', { count: selection.length })}
            </span>
            <div className="ml-auto flex gap-1 sm:gap-2">
              {selection.length === 1 || selection.every((i) => i.kind === 'file') ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 sm:h-9"
                  onClick={() => startRename(selection)}
                >
                  <PencilIcon className="sm:hidden" aria-hidden />
                  <span className="max-sm:sr-only">{t('drive.rename')}</span>
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                className="h-11 sm:h-9"
                onClick={() => setMoving(selection)}
              >
                <FolderInputIcon className="sm:hidden" aria-hidden />
                <span className="max-sm:sr-only">{t('drive.move')}</span>
              </Button>
              <Button
                size="sm"
                variant="destructive"
                className="h-11 sm:h-9"
                onClick={() => void trash(selection)}
              >
                <Trash2Icon className="sm:hidden" aria-hidden />
                <span className="max-sm:sr-only">{t('drive.moveToTrash')}</span>
              </Button>
            </div>
          </div>
        ) : null}

        {listing.isError ? (
          <Alert variant="destructive" className="flex items-center justify-between gap-2">
            <span>
              {t('drive.loadError')}: {describe(listing.error)}
            </span>
            <Button size="sm" variant="outline" onClick={() => void listing.refetch()}>
              {t('common.retry')}
            </Button>
          </Alert>
        ) : listing.isPending ? (
          <div role="status" aria-label={t('common.loading')}>
            <span className="sr-only">{t('common.loading')}</span>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {Array.from({ length: 10 }, (_, i) => (
                <div key={i} className="space-y-2 rounded-xl p-1.5">
                  <Skeleton className="aspect-square w-full rounded-lg" />
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
              ))}
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-sidebar px-6 py-16 text-center">
            <p className="text-base font-medium">{t('drive.empty')}</p>
            <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
              {t('drive.emptyHint')}
            </p>
          </div>
        ) : (
          <div
            ref={gridRef}
            onKeyDown={onGridKeyDown}
            className={cn(selection.length > 0 && 'pb-24 sm:pb-0')}
          >
            {allEvents.length > 0 ? (
              <section aria-label={t('event.events')} className="space-y-3">
                {folderId === null ? (
                  // ADR 0024: filter tabs by link status, a name filter and the view toggle.
                  <div className="studio-card flex flex-col gap-2 p-2 lg:flex-row lg:items-center lg:justify-between">
                    <div
                      role="radiogroup"
                      aria-label={t('events.filterLabel')}
                      className="flex gap-1 overflow-x-auto"
                    >
                      {EVENT_TABS.map((tab) => {
                        const count =
                          tab === 'all'
                            ? eventCounts.total
                            : tab === 'active'
                              ? eventCounts.published
                              : tab === 'paused'
                                ? eventCounts.paused
                                : eventCounts.none;
                        return (
                          <button
                            key={tab}
                            type="button"
                            role="radio"
                            aria-checked={eventTab === tab}
                            onClick={() => setEventTab(tab)}
                            className={cn(
                              'h-10 shrink-0 rounded-lg px-3.5 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring',
                              eventTab === tab
                                ? 'bg-accent font-semibold text-primary dark:text-cyan-300'
                                : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                            )}
                          >
                            {t(`events.tabs.${tab}`, { count })}
                          </button>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="relative min-w-0 flex-1 lg:w-64">
                        <SearchIcon
                          className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                          aria-hidden
                        />
                        <Input
                          value={eventQuery}
                          onChange={(e) => setEventQuery(e.target.value)}
                          placeholder={t('events.filterPlaceholder')}
                          aria-label={t('events.filterPlaceholder')}
                          className="h-10 rounded-lg bg-background pl-9 dark:border-white/5 dark:bg-background/70"
                        />
                      </div>
                      {viewToggle}
                    </div>
                  </div>
                ) : fileItems.length > 0 ? (
                  <h2 className="text-sm font-semibold text-muted-foreground">
                    {t('event.events')}
                  </h2>
                ) : null}
                <div
                  className={cn(
                    folderId === null &&
                      wide &&
                      inspected !== null &&
                      'grid grid-cols-[minmax(0,1fr)_21rem] items-start gap-5',
                  )}
                >
                  <div className="min-w-0">
                    {events.length > 0 ? (
                      <DriveGrid
                        items={events}
                        layout={layout}
                        label={t('event.events')}
                        loadingMoreLabel={t('drive.loadingMore')}
                        hasNextPage={fileItems.length === 0 && listing.hasNextPage}
                        isFetchingNextPage={fileItems.length === 0 && listing.isFetchingNextPage}
                        fetchNextPage={listing.fetchNextPage}
                        scrollToIndex={focusIndexIn(events)}
                        onColumnsChange={setEventColumns}
                        {...EVENT_CELL}
                        renderItem={renderItem}
                      />
                    ) : (
                      <p className="studio-card px-4 py-10 text-center text-sm text-muted-foreground">
                        {t('events.noMatch')}
                      </p>
                    )}
                  </div>
                  {folderId === null && wide && inspected !== null ? (
                    <div className="sticky top-[5.5rem]">
                      <EventInspector
                        folder={inspected}
                        onEdit={() => setEditingEvent(inspected)}
                        onQr={() => {
                          const target = qrTargetOf(inspected);
                          if (target !== null) setQr(target);
                        }}
                      />
                    </div>
                  ) : null}
                </div>
              </section>
            ) : null}
            {fileItems.length > 0 ? (
              <section
                aria-label={t('event.files')}
                className={cn('space-y-2', allEvents.length > 0 && 'mt-6')}
              >
                {allEvents.length > 0 ? (
                  <h2 className="text-sm font-semibold text-muted-foreground">
                    {t('event.files')}
                  </h2>
                ) : null}
                <DriveGrid
                  items={fileItems}
                  layout={layout}
                  label={listing.folder?.name ?? t('drive.root')}
                  loadingMoreLabel={t('drive.loadingMore')}
                  hasNextPage={listing.hasNextPage}
                  isFetchingNextPage={listing.isFetchingNextPage}
                  fetchNextPage={listing.fetchNextPage}
                  scrollToIndex={focusIndexIn(fileItems)}
                  onColumnsChange={setFileColumns}
                  renderItem={renderItem}
                />
              </section>
            ) : null}
          </div>
        )}

        {dragging ? (
          <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-primary/10">
            <p className="rounded-xl bg-background px-6 py-4 font-medium shadow-lg">
              {t('drive.dropHere')}
            </p>
          </div>
        ) : null}

        <NameDialog
          key={renaming?.id ?? 'none'}
          open={renaming !== null}
          onOpenChange={(open) => !open && setRenaming(null)}
          title={t('rename.title')}
          label={t('rename.nameLabel')}
          submitLabel={t('rename.submit')}
          initialName={renaming?.name}
          onSubmit={async (name) => {
            if (renaming === null) return;
            await renameItem.mutateAsync({ item: itemRef(renaming), name });
            clearSelection();
          }}
        />
        <RenameFilesDialog
          files={renamingFiles}
          onOpenChange={(open) => !open && setRenamingFiles(null)}
          onDone={(result) => {
            if (result.failures.length === 0) clearSelection();
          }}
        />
        <ShareDialog
          target={sharing}
          onOpenChange={(open) => !open && setSharing(null)}
          onCreatedAndCopied={() => {
            setSharing(null);
            setNotice({ kind: 'info', text: t('shareDialog.createdCopied') });
          }}
        />
        <MoveDialog
          open={moving !== null}
          onOpenChange={(open) => !open && setMoving(null)}
          items={(moving ?? []).map(itemRef)}
          sourceFolderId={folderId}
          onMove={move}
        />
        <EventDialog
          // The listing's current row (a cover change refetches it), else the one clicked.
          folder={
            editingEvent === null
              ? null
              : (items.find(
                  (i): i is DriveFolder => i.kind === 'folder' && i.id === editingEvent.id,
                ) ?? editingEvent)
          }
          onOpenChange={(open) => !open && setEditingEvent(null)}
          onPublishedChange={(published, name) =>
            setNotice({
              kind: 'info',
              text: t(published ? 'event.published' : 'event.unpublished', { name }),
            })
          }
        />
        <QrDialog target={qr} onOpenChange={(open) => !open && setQr(null)} />
        <DetailsPanel
          item={details}
          location={location}
          onOpenChange={(open) => !open && setDetails(null)}
        />
      </div>
    </ItemMenuProvider>
  );
}
