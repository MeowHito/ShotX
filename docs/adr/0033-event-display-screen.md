# ADR 0033: Event display screen (latest photos + QR) and a full-screen button

- Status: Accepted (owner, 2026-11-27)
- Date: 2026-11-27
- Builds on: ADR 0013 (share page designer), ADR 0019 (show photos switch), ADR 0020 (live
  updates)

## Context

At Chiangmai Thailand by UTMB the photographer ran the share page on a portrait monitor at the
booth so runners could scan its QR (an image the photographer uploaded into the design). The owner
wants:

1. another kind of design for such a screen that also shows the photos just taken (the newest
   photo large), with text and the link's QR code; scanning it must open the share page with the
   link's normal design (owner's sketch: the newest photo, then "TEXT" and the QR at the bottom);
2. the page didn't fill the monitor (browser bars, a phone-sized card): a small full-screen icon
   button in a corner.

## Decision

### 1. Design kinds

A design document gets an optional `kind`: absent or `share` (every existing document) is the share
page a phone opens; `display` is an event screen. Both use the 390 x 844 artboard; a screen shows
it fit to its height with the background filling the rest (a 9:16 portrait monitor shows almost
all of it).

Element counts depend on the kind (`DESIGN_ELEMENT_CARDINALITY_BY_KIND`):

| element               | share    | display |
| --------------------- | -------- | ------- |
| text, image, shape    | any      | any     |
| faceIcon, scanButtons | one      | none    |
| helpButton            | optional | none    |
| `latestPhotos` (new)  | none     | one     |
| `qrCode` (new)        | any      | any     |

- `latestPhotos`: the share's newest photos in a box (`fit`, `radius`, `bg`). `count` 1..20: 1
  always shows the newest; more cycles through the newest `count`, `intervalSec` (2..60) each, with
  a cross-fade; a new photo shows at once. Like the face icon on a share page it can't be deleted
  or hidden, and its opacity stays at least 0.3.
- `qrCode`: a QR of the link (`fg`, `bg`, `radius`), drawn by web from the share's public URL;
  the document never holds a URL (ADR 0013's safety rule). A share page may use it too, instead
  of uploading a QR image.

A design's kind never changes (`PUT /designs/:id` with another kind is VALIDATION_FAILED), a
display design is never the default (not on create, `POST /designs/:id/default` is
VALIDATION_FAILED), and the studio creates one from the display templates (`display-spotlight`,
`display-clean`) as a document.

### 2. Which screen a link shows

`shares.display_design_id` (migration 0023, nullable, same-owner foreign key, ON DELETE SET NULL
of the column only). `POST /shares` and `PATCH /shares/:id` take `displayDesignId` (one of the
caller's display designs, else DESIGN_NOT_FOUND); `designId` must be a share page design (a display
design is DESIGN_NOT_FOUND there). Null: the built-in screen (`autoDisplayDoc`): the spotlight
layout on the share page design's background with the event's name as the title.

The studio chooses it on the live link (event dialog "จอแสดงภาพล่าสุดที่งาน", share dialog), with
"open the screen"; the event inspector links to the screen too.

### 3. The screen

`/{slug}/display` (web, client-rendered, noindex) reads the meta and the new
`GET /s/:token/display` → `{ design, photos }`: the display design with its ready images, and the
newest ready photos in scope, newest first, at most `SHARE_DISPLAY_PHOTOS_LIMIT` (20). Same gates
as items (a password share is unlocked on the screen once; login-required shares ask for login).
It writes no activity event: a screen polls it, and counting it would inflate views. It follows
the ADR 0020 polling (`changes`, whose version now also covers `display_design_id`) and refetches
before the photos' signed URLs expire, so a screen left on all day keeps working.

PDPA / privacy: photos are shown only for a `gallery` share (including a design that doesn't turn
"show photos" off). A scan-only share's photos are found by a face only, so its screen shows the
box colour alone.

### 4. Full screen

A small icon button (Fullscreen API, with the WebKit prefix) in the top bar of the share page (wide
screens only) and in a corner of the screen page; hidden where the browser can't do it (iPhone).
Full screen, the share page's designed card drops its phone-sized 480 px cap and fills the
height.

## Consequences

- One more column and migration (0023, additive; existing rows get null: the built-in screen).
- Design edits don't change the `changes` version (as before for share pages): an open screen
  shows a new design text after a reload, a new choice of design at once.
- Landscape monitors show the portrait artboard centred with the background around it; a
  landscape layout is left for later.
