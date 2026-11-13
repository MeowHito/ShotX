# ADR 0018: Admins can work in a photographer's account ("เข้าจัดการบัญชีนี้")

- Status: Accepted (owner, 2026-11-13)
- Date: 2026-11-13

## Context

When a photographer is stuck, the owner wants an admin to open that photographer's studio and do
anything they could: see events and photos, edit, delete, create and copy links, design share
pages. Until now admins could only read across tenants and take things down.

## Decision

- **Start (admin app).** "เข้าจัดการบัญชีนี้" on an active photographer (row menu and detail page)
  calls `POST /admin/users/:id/act-as`. The api stores a one-time CSPRNG code in Redis (its
  SHA-256 only) for `ADMIN_ACT_AS_CODE_SECONDS` (default 120), writes `admin.user.act_as` to
  audit_log, and answers a link to web's `/auth/act-as?code=…`. The admin app opens it in a new
  tab (opened in the click, so pop-up blockers allow it; the link is shown if not).
- **Exchange (web).** `/auth/act-as` posts the code to `POST /auth/act-as` (web BFF key). The code
  is taken once; the admin and the photographer must still be active. The api starts a users-pool
  session of the photographer with `auth_sessions.acting_admin_id` (migration 0015), ending after
  `ADMIN_ACT_AS_SESSION_SECONDS` (default 3600, never extended by refresh). Web ends any session
  already in that browser, sets the cookies and opens /studio.
- **During the session.** The guard reads `acting_admin_id` from the session row it already
  checks on every request; the session ends at once if the admin is no longer an active admin.
  Every POST/PUT/PATCH/DELETE writes `admin.act_as.request` (actor = the admin, target = the
  photographer, the route pattern and session id; never ids or bodies from the request). The
  password change is refused (FORBIDDEN): the admin resets passwords in the admin app instead.
  A photographer's temporary password doesn't restrict the admin's session.
- **Studio.** `GET /me` reports `actingAdmin`; the studio shows an amber bar "โหมดแอดมิน: … กำลัง
  จัดการบัญชีของ …", that every change is recorded under the admin, and "ออกจากโหมดแอดมิน"
  (signs out of that session only).
- The photographer's own sessions are untouched and they are not notified.

## Consequences

- Admin help needs no shared passwords; every change is attributable in audit_log.
- An admin can do anything the photographer can for up to an hour per link, including deleting
  photos and shares. Admin accounts must stay few and trusted (MFA is off since ADR 0011; turning
  `ADMIN_MFA_MODE=totp` back on protects this too).
- Reads in the act-as session are not audited (only changes).
