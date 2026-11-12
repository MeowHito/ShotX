# ADR 0012: Share page after the second field review: one save button, no "not me"

- Status: Accepted (the owner's annotated screenshots of 2026-11-12)
- Date: 2026-11-12
- Amends: the photo-platform skill sections "Face search (share page)" (the "ไม่ใช่ฉัน" button)
  and "Sharing and downloads" (zips for several files), ADR 0011 (results: "download all found")

## Decision

### Owner decisions that override settled rules

1. **No "ไม่ใช่ฉัน" button.** Face-search results show only the photos. The feedback API
   (`POST /s/:token/feedback`, `face_feedback`) stays but nothing on the share page calls it.
   - Cost: the "not me" rate the accuracy program tracks in production is gone. Threshold tuning
     relies on the evaluation harness and the zero-result rate only.
2. **No zip on share pages.** No "download all found" and no "download N photos" zip.
   - iOS (Web Share API with files): one large "บันทึกลงแอปรูปภาพ" button.
   - Other browsers: the same single button downloads each selected photo as its own file, one
     after another (`WEB_DOWNLOAD_GAP_MS` apart). The browser may ask once to allow several
     downloads. The zip API and worker stay (studio downloads still use them).
3. **Selected photos are fetched ahead on iOS** so "save to Photos" is one tap (Safari needs a
   fresh tap for `navigator.share`, and fetching after the tap used to cost a second tap). Each
   selected photo is fetched as soon as it is selected (at most `WEB_PHOTO_PREFETCH_CONCURRENCY`
   at once, up to `WEB_IOS_SHARE_MAX_FILES`); deselecting aborts and drops it.
   - Cost: bandwidth and `download` activity events for photos that were selected but never
     saved. Stats count a download when its URL is issued, so they now include these.

### Product changes (no rule conflict)

- After a face search the event title and cover are hidden; the found photos come first.
- "เลือกทั้งหมด" is the only button above the results.
- The language switcher shows flags (Thailand, United States, China) instead of TH/EN/中文.
- The live selfie camera is zoomed (`WEB_FACE_CAMERA_ZOOM`, default 1.4): phones give
  getUserMedia the front camera's full wide-angle view, while their camera app crops it. The
  page always does the zoom (preview scaled, photo cropped to the same centre): the camera's own
  `zoom` constraint was tried first and still looked wide on the owner's phone. The face outline
  is smaller (about 38% of the frame's width) so the phone is held at arm's length; up close a
  front camera distorts the face, which reads as wide angle. The face-search sheet is centred
  vertically on phones.
