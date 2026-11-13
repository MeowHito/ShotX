# ADR 0023: "อีเวนต์" naming, Recent selection and bulk rename, owner stats, no links page in the menu

- Status: Accepted (owner, 2026-11-13)
- Date: 2026-11-13

## Context

The owner asked for the photographer studio:

1. Recent ("ล่าสุด"): select, select all and delete files, and rename. Renaming opens a friendly,
   animated dialog; with several files selected, one name "A" becomes A(1), A(2), … from the
   newest photo.
2. The links page ("ลิงก์ที่แชร์") leaves the menu; links are managed from the events.
3. A chart of photos uploaded and photos downloaded, on the drive page.
4. "ไดรฟ์ของฉัน" is renamed "อีเวนต์" (Events).

## Decision

- **Naming.** `studio.drive` and `drive.root` read "อีเวนต์" / "Events" / "活动"; the search field
  says "ค้นหาในอีเวนต์". Routes don't change (`/studio`, `/studio/folders/:id`).
- **Menu.** The links item is removed from the aside. `/studio/shares` and `/studio/shares/:id`
  still exist (item menus link to them) and highlight "อีเวนต์".
- **Recent.** Files have checkboxes; a tap opens details while nothing is selected and toggles
  once something is. "เลือกทั้งหมด" selects every loaded file (the list is paged). The selection
  bar renames and deletes; delete moves to the trash in batches of DRIVE_ITEMS_BATCH_MAX with
  undo, like the drive.
- **Rename dialog** (`RenameFilesDialog`, for files in Recent and in the drive; folders keep the
  name dialog): the photographer types a name without the extension; each file keeps its own
  extension (so the type check `renameKeepsFileType` always holds). One file: `name.ext`;
  several: `name(1).ext`, `name(2).ext`, … ordered newest first by `createdAt` (ties keep the
  list order). The client sends one `PATCH /drive/files/:id` per file (no new endpoint);
  files already named right are skipped, and when the batch would collide with itself (renaming
  A(1), A(2) again in another order) the affected files first take temporary names. A name
  taken by a file outside the batch fails for that file only (NAME_TAKEN) and the dialog
  reports how many succeeded. A bobbing pencil, twinkling sparkles and a popping check animate
  it (`motion-safe` only).
- **Stats.** New `GET /drive/stats?days=7|30|90` (default 30, photographer only, own rows only):
  `totals` (all time) and `period` and every day of the range (zeros included) of
  - `photos`: live image files (`processing`/`ready`, not trashed, copies included) counted from
    `files` by the Bangkok day of `created_at`;
  - `downloads`: share-page single-photo downloads from `daily_stats.downloads` (the hourly
    rollup; never raw events).
  The top level of "อีเวนต์" shows two tiles and two small bar charts (one per measure, the same
  days, never a dual axis), a shared hover, and a screen-reader table.

## Consequences

- Photos removed to the trash leave the upload count; downloads lag by up to an hour.
- Renaming many files is N requests; fine for event-sized selections (hundreds). A batch rename
  endpoint can come later if needed.
