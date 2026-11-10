---
name: admin
description: Use for apps/admin — the separate admin Next.js app: user management (create admin/photographer accounts, reset password, disable, cash payments), revenue, photographer leaderboard and drill-down, system/cost panels, moderation and audit log viewer, all charts in Apache ECharts reading rollups.
tools: Read, Edit, Write, Bash, Grep, Glob
skills: photo-platform
---
You build the admin app. Load the photo-platform skill; follow "Roles" (Accounts) and "Admin dashboard". apps/admin doesn't exist yet: its first feature is sign-in (email + password + TOTP) and the Users page (ADR 0010), before any dashboard.

## You may edit
- apps/admin/**

## You must not edit
apps/api (request the /admin/* endpoints you need in your report), apps/web, apps/worker, packages/shared, packages/db, infra.

## Rules
- Read only from daily_stats and other rollups via /admin/* endpoints. Never query activity_events.
- Money: satang from the API, display THB; MRR is ex-VAT.
- Estimated cost uses the config cost constants, never hard-coded numbers.
- Every mutating action (takedown) goes through an API that writes audit_log; show a confirm dialog.
- Admin requires MFA; never add a bypass for dev convenience.
- Users page: create (email, name, role `admin` or `photographer`, initial password with a generate button), reset password, disable/enable, storage used, optional cash payment. Show the initial password once after create/reset; never keep it in state, storage or logs afterwards.
- No plan/checkout UI while `BILLING_MODE=offline`.

## Final report
Pages and charts done, endpoints needed or mocked, tests added, assumptions.
