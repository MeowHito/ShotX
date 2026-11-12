# ADR 0014: Folder sync from the photographer's computer ("ซิงก์โฟลเดอร์")

- Status: Accepted (owner, 2026-11-13)
- Date: 2026-11-13

## Context

At events photographers edit in Lightroom and export to a folder on their laptop. The owner wants
those exports to reach Snap automatically, without a manual upload after every batch, and asked
whether the browser alone can do it, with nothing to install.

It can, in Chromium browsers on computers: the File System Access API
(`showDirectoryPicker`) gives the page a read handle on a folder the person picks, the handle
can be stored in IndexedDB, and the page can list the folder and read its files again later.
Safari and Firefox don't offer the picker, and phones have no export folder. A desktop agent or
a Lightroom Classic publish plugin would work without an open tab, but needs installing; they
stay options for later.

## Decision

A studio tab "ซิงก์โฟลเดอร์" (`/studio/sync`) in apps/web. No API, contract or database change.

- **Set-up:** the photographer picks the computer folder (read-only), the Snap destination folder
  (the move dialog's folder picker; the drive root by default), whether subfolders are included
  (they become the same subfolders in Snap, as `relativePath`), and whether the files already in
  the folder are uploaded or only new exports.
- **Watching:** every `WEB_FOLDER_SYNC_INTERVAL_MS` (default 5 s) the page lists the folder (down
  to `WEB_FOLDER_SYNC_MAX_DEPTH` levels, default 3). Hidden files and types outside the upload
  allowlist (XMP sidecars, TIFF, RAW) are left out and counted. A file is uploaded once two scans
  in a row saw the same size and modification time, so a file Lightroom is still writing is never
  sent half-written. Oldest first, at most `WEB_FOLDER_SYNC_MAX_QUEUED` (default 20) in the queue.
- **Uploading:** through the studio's existing upload queue (Uppy multipart, presigned PUTs straight
  to storage; file bytes never pass through the API) with `onNameConflict: 'fail'`. NAME_TAKEN
  means the file is already in the destination: it is recorded as such and never uploaded twice,
  from this browser or any other. A re-export under the same name is therefore not uploaded again.
- **Ledger:** IndexedDB (`snap-folder-sync`) keeps the set-up (folder handle, destination, owner's
  user id) and, per file path, the version handled and how (`uploaded`, `exists`, `skipped`,
  `baseline`, `pending`). Before a file is queued its upload key (`clientUploadId`) is saved as
  `pending`; after a reload the same key is sent, so the API resumes that upload rather than
  answering NAME_TAKEN for its own half-done file. A used-up key (CONFLICT) is replaced.
- **Failures:** retried after `WEB_FOLDER_SYNC_RETRY_DELAYS_MS` (default 30 s, 2 min, 10 min), then
  counted as failed until the next reload. A missing destination folder (NOT_FOUND) or a missing
  computer folder stops the sync with a message.
- **One tab:** a Web Lock (`snap-folder-sync`) lets one tab sync; another tab says so. Holding the
  lock also keeps Chrome from freezing or discarding the tab in the background.
- **Session:** the provider sits in the studio layout, so syncing goes on while the photographer
  uses other studio pages; leaving the site asks first. After a reload Chrome may ask for read
  permission again (one click), unless the person chose "allow on every visit". A set-up made by
  another account in the same browser is discarded, never resumed.
- **Unsupported browsers** (Safari, Firefox, phones) see a message to use Chrome or Edge on a
  computer.

## Consequences

- Works only while a Chrome or Edge tab is open and the computer is awake; the page says so.
  Background tabs may be scanned less often (Chrome throttles timers), uploads continue.
- The ledger lives in one browser; NAME_TAKEN makes a second browser or a lost ledger safe.
- PDPA unchanged: event photos only, uploaded by their photographer as before; the folder handle
  and file names stay in the photographer's browser.
- Later options, if photographers need syncing with the browser closed: a small desktop agent or
  a Lightroom Classic publish service, both using the same upload routes.
