# ADR 0011: Event gallery redesign after the first field test

- Status: Accepted (the owner's decisions of 2026-11-12, from the test summary "สรุปผลทดสอบระบบแจกภาพ")
- Date: 2026-11-12
- Amends: the photo-platform skill sections "Sharing and downloads" (128-bit random token URLs),
  "PDPA and security checklist" (photographer confirmation before face indexing; a public
  "ขอลบใบหน้าของฉัน" flow), ADR 0010 (share page details)

## Context

The owner and a test photographer ran the first real test on production
(snap.action.in.th, 2026-11-11). Their slide deck asks for a cleaner, mobile-first event page,
a faster face search, multilingual UI, and three changes that trade against settled rules. The
owner was told the risks of each before deciding.

## Decision

### Owner decisions that override settled rules (risks accepted by the owner)

1. **Face indexing is always on.** Every folder is indexed on upload; the photographer no longer
   enables it or confirms that attendees were informed. Existing folders are switched on.
   - Risk: PDPA section 26 (biometric data). The company can no longer show that attendees were
     told before their faces were indexed. Mitigation left to the business: event organisers'
     notices and the photographer terms.
2. **No visible "delete my face" link.** All links to the deletion flow are removed from the
   share page, the consent text and the footer. The deletion page and API stay working at their
   URL (`/s/{slug}/delete-my-face`), unlinked, so the company can answer a data-subject request by
   sending that link.
   - Risk: PDPA data-subject rights (erasure, withdrawal) must be easy to exercise; an unlinked
     page may not satisfy a regulator.
3. **Readable event URLs.** A share's public URL is the event name as a slug
   (`/s/{slug}`); a short random suffix is added only when the slug is already taken. Old token
   URLs keep working.
   - Risk: share URLs are no longer secrets. Anyone who guesses an event name sees every photo
     of that event. Mitigations: per-IP rate limits on share resolution and 404s, the existing
     share password option, `noindex` on share pages.

4. **No two-factor sign-in for admins** (owner, 2026-11-12). Admins sign in with email and
   password only; the TOTP step and enrolment are switched off by configuration
   (`ADMIN_MFA_MODE=off`, default off; `totp` restores the ADR 0008 flow without code changes).
   Password policy (14+ characters), lockout, rate limits, session revocation, the separate admin
   BFF key and the main-domain block of `/api/admin*` stay.
   - Risk: one leaked admin password (phishing, reuse) gives full admin access: create and disable
     accounts, read every photographer's data. The bootstrap admin's email is in the repository.
     The owner was offered "remember this device for 30 days" and an office-IP allowlist and
     declined both.

### Product changes (no rule conflict)

- Share page: top navigation (home link, language switcher), centered event title, a 16:3 cover
  image under it (the folder cover, chosen by the photographer, default the first photo), no
  "ถ่ายโดย" or photo count, thumbnails in their original aspect ratio (masonry).
- A sticky bottom "ค้นหาด้วยใบหน้า" button.
- Face search: no selfie tips, a circular camera frame with a face guide, search starts as soon
  as the photo is taken (no extra angles, no second button), a progress bar while searching.
  The consent screen still comes first (unchanged rule).
- Results: the number found, an empty state that invites a retry, round selection dots, "select
  all" (only the found photos), download of the selected or all found photos, a lightbox with a
  bottom download button, previous/next controls and swipe.
- Languages: Thai, English and Chinese (simplified), switchable from the top bar, for the public
  pages (share page, face search, results, downloads, consent). The Thai consent text stays the
  legal reference; English and Chinese are translations for the DPO to approve.

## Consequences

- New contracts: share slug (unique, generated from the event name, random suffix on collision),
  folder cover file, face index default on (migration switches existing folders on), locale
  list, a download endpoint for a selection of found files.
- The privacy notice and organiser notice must now carry the face-indexing information that the
  photographer confirmation used to provide. DPO review covers the three decisions above.
