# ADR 0015: Simpler share page, root share URLs, temporary passwords

- Status: Accepted (owner, 2026-11-13)
- Date: 2026-11-13

## Context

Owner feedback after the first live events (2026-11-13):

1. On desktops the sticky "ค้นหาด้วยใบหน้า" button sits at the bottom edge, where a macOS Dock
   that never hides covers it.
2. The 16:3 cover under the event title isn't wanted.
3. The "ถอนความยินยอมใช้ข้อมูลใบหน้า" link isn't wanted on the share page.
4. Tapping the scan button opens a consent screen (text, details, a checkbox) before the camera.
   The organiser tells attendees about face search before the event, so the owner wants the
   camera to come up straight away.
5. Share links should read `snap.action.in.th/{slug}`, without `/s/`.
6. "Create link" in the studio should copy the link and close the dialog.
7. The temporary password an admin sets when creating an account (or resetting a password) may
   be anything with at least 4 characters: the owner must change it at first sign-in anyway.

## Decision

- **Scan button:** on screens `sm` and wider the floating scan button and the selection bar sit
  6rem above the bottom edge; phones are unchanged.
- **No cover** on the share page. The cover still serves as the link's OG image.
- **No withdraw link** on the share page. `DELETE /s/:token/consent` stays in the API (unused by
  the page), and the "delete my face" page (`/{ref}/delete-my-face`) is unchanged.
- **Face-search consent without a screen:** opening the scan sheet posts the face_search consent
  of the current policy version (`POST /s/:token/consent`, the same row as before) and then opens
  the camera. The invariant "a consent row for the current policy version exists before any call
  to the face provider" is unchanged: the API still refuses a search without it. The text is no
  longer shown; tapping "ค้นหาด้วยใบหน้า" is the act of consent, and the organiser's notice before
  the event is the information. The consent screen remains for "delete my face".
- **Root share URLs:** the share page moves from `app/s/[ref]` to `app/[ref]`. `shareRefPath`
  returns `/{ref}`; the API's share `url` and `path` follow. `src/proxy.ts` redirects old
  `/s/{ref}[/…]` links (308) to `/{ref}[/…]`. Slugs the web app's own first path segments use
  (`SHARE_SLUG_RESERVED`: studio, login, auth, …) are never generated (the API adds the random
  suffix); a share that already holds one keeps its `/s/{slug}` URL, which `app/s/[ref]` still
  serves.
- **Create link:** the dialog copies the new link and closes, and the drive shows "สร้างลิงก์และ
  คัดลอกแล้ว". The copy starts in the submit handler (a `ClipboardItem` from a promise) so Safari
  allows it; if the browser still refuses, the dialog stays open with the link and its copy button.
- **Admin users page:** the "สร้างเมื่อ" column becomes "จำนวนรูป", the photographer's uploaded
  photos (`adminUserSchema.photoCount`: image files that finished uploading and are not in the
  trash; videos not counted; null for admins). The creation date stays on the user's detail page.
- **Temporary passwords:** `TEMPORARY_PASSWORD_MIN_LENGTH` (4–128, default 4) is the only rule
  for passwords an admin sets (create, reset; `temporaryPasswordViolation`). The first sign-in
  still requires a new password under the pool's full policy (`ADMIN_PASSWORD_MIN_LENGTH`,
  `PHOTOGRAPHER_PASSWORD_MIN_LENGTH`, distinct characters, not the email, not common). The
  operator CLI's bootstrap admin keeps the full admin policy.

## Consequences and risks

- **PDPA (needs the DPO's review before relying on it):** biometric data needs explicit consent
  (section 26), and withdrawing must be as easy as giving it (section 19). Consent by tapping the
  scan button rests on the organiser informing attendees beforehand; the operator should keep
  that notice (registration terms or on-site signage) on file per event. With the withdraw link
  gone, withdrawal and deletion go through the photographer or the company, who send the
  "delete my face" link. On the owner's decision (2026-11-13) the 2026-11-12 texts were edited in
  place: the face-search text no longer says consent can be withdrawn "from this link's page", and
  the deletion text drops its withdraw point (the face-search text is no longer shown anyway).
- A 4-character temporary password is weak until its first use. Sign-in lockout
  (`*_LOGIN_LOCKOUT_*`) and rate limits apply; admins should hand it over in person and the owner
  should sign in soon after.
- Old `/s/…` links keep working through the redirect.
