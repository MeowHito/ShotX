-- ADR 0011 (event gallery redesign) and its decision 4 (admin sign-in without TOTP). Additive and
-- safe on the live database with the previous api release still running during the deploy:
-- - shares.slug: readable refs, backfilled from each share's target name; nullable so the
--   previous api can still insert (a follow-up migration sets NOT NULL once the api writes it).
-- - folders: face indexing on by default and switched on for every existing folder (ADR 0011
--   decision 1), the photographer confirmation no longer required, and the cover photo.
-- - consents.locale: the language the consent text was shown in (existing rows: th).
-- - auth_sessions.amr: the sign-in's methods, so refresh never upgrades a password-only admin
--   session after ADMIN_MFA_MODE goes back to totp (existing rows: null = derived as before).
-- Hand-edited after drizzle-kit generate: the backfills, and ON DELETE SET NULL ("cover_file_id")
-- (drizzle can't express the column list; a plain SET NULL would also null owner_id).
-- No rewrite of any table: ADD COLUMN has no or a constant default; the backfills update the rows
-- of folders and shares once (small tables), all inside the migrator's single transaction.
CREATE TYPE "public"."ui_locale" AS ENUM('th', 'en', 'zh');--> statement-breakpoint
ALTER TABLE "folders" DROP CONSTRAINT "folders_face_index_needs_confirmation";--> statement-breakpoint
ALTER TABLE "folders" ALTER COLUMN "face_index_enabled" SET DEFAULT true;--> statement-breakpoint
ALTER TABLE "folders" ALTER COLUMN "face_index_expires_at" SET DEFAULT (now() + make_interval(days => 90));--> statement-breakpoint
-- ADR 0011 decision 1: every folder is switched on, with the enable rule of
-- PATCH /drive/folders/:id/face-index (expiry = max(current active expiry, now + 90 days), 90 =
-- FACE_INDEX_EXPIRY_DAYS_DEFAULT). Live top-level folders get the index.folder outbox mark, so
-- faces.sweep fans out indexing of their whole subtree (the one-time backfill; subfolders are
-- covered by their top-level folder's fan-out). Folders whose purge was requested are left alone.
UPDATE "folders" SET
  "face_index_enabled" = true,
  "face_index_expires_at" = GREATEST(
    CASE WHEN "face_index_enabled" THEN "face_index_expires_at" END,
    now() + make_interval(days => 90)
  ),
  "face_index_queued_at" = CASE
    WHEN "parent_id" IS NULL AND "deleted_at" IS NULL THEN coalesce("face_index_queued_at", now())
    ELSE "face_index_queued_at"
  END
WHERE "purge_requested_at" IS NULL;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "amr" text[];--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "cover_file_id" uuid;--> statement-breakpoint
ALTER TABLE "consents" ADD COLUMN "locale" "ui_locale" DEFAULT 'th' NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "slug" text;--> statement-breakpoint
-- Slugs of existing shares, from the folder name or the file name without its extension
-- (shareSlugSourceName). SQL can't classify Unicode the same way on every locale, so this keeps
-- an explicit subset of slugifyEventName's characters: ASCII a-z and 0-9 (lowercased with the C
-- collation), Thai letters, vowels, tone marks and digits, and CJK unified ideographs; every other
-- run becomes one '-'. Then trimmed to 60 code points (SHARE_SLUG_BASE_MAX_LENGTH), 'event' when
-- empty (SHARE_SLUG_FALLBACK). The oldest share of each base keeps it; later ones, and token-shaped
-- bases, get '-' + 6 base36 characters from gen_random_uuid() (CSPRNG; byte % 36, a negligible
-- bias for this one-time backfill). Every result satisfies isShareSlug in @shotx/shared.
WITH "source" AS (
  SELECT "s"."id", "s"."created_at", normalize(
    CASE WHEN "s"."target_type" = 'file'
      THEN coalesce(nullif(regexp_replace("f"."name", '\.[0-9A-Za-z]{1,8}$', ''), ''), "f"."name")
      ELSE "fo"."name"
    END, NFC) AS "name"
  FROM "shares" AS "s"
  LEFT JOIN "files" AS "f" ON "f"."id" = "s"."target_file_id"
  LEFT JOIN "folders" AS "fo" ON "fo"."id" = "s"."target_folder_id"
  WHERE "s"."slug" IS NULL
), "base" AS (
  SELECT "id", "created_at", coalesce(nullif(rtrim(left(btrim(regexp_replace(
    lower("name" COLLATE "C"),
    '[^0-9a-zก-ฺเ-๎๐-๙一-鿿]+', '-', 'g'
  ), '-'), 60), '-'), ''), 'event') AS "base"
  FROM "source"
), "ranked" AS (
  SELECT "id", "base", uuid_send(gen_random_uuid()) AS "rnd",
    row_number() OVER (PARTITION BY "base" ORDER BY "created_at", "id") AS "n"
  FROM "base"
)
UPDATE "shares" AS "s" SET "slug" = CASE
  WHEN "r"."n" = 1 AND "r"."base" !~ '^[0-9a-z]{22}$' THEN "r"."base"
  ELSE "r"."base" || '-' || (
    SELECT string_agg(
      substr('0123456789abcdefghijklmnopqrstuvwxyz', get_byte("r"."rnd", "i") % 36 + 1, 1),
      '' ORDER BY "i"
    )
    FROM generate_series(0, 5) AS "i"
  )
END
FROM "ranked" AS "r"
WHERE "r"."id" = "s"."id";--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_cover_file_same_owner_fk" FOREIGN KEY ("cover_file_id","owner_id") REFERENCES "public"."files"("id","owner_id") ON DELETE SET NULL ("cover_file_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "folders_cover_file_idx" ON "folders" USING btree ("cover_file_id","owner_id") WHERE "folders"."cover_file_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_slug_unique" UNIQUE("slug");--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_amr_valid" CHECK ("auth_sessions"."amr" IS NULL OR (cardinality("auth_sessions"."amr") >= 1 AND "auth_sessions"."amr" <@ ARRAY['fed', 'dev', 'pwd', 'otp', 'mfa']::text[]));--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_face_index_has_expiry" CHECK (NOT "folders"."face_index_enabled" OR "folders"."face_index_expires_at" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_slug_valid" CHECK ("shares"."slug" IS NULL OR (char_length("shares"."slug") BETWEEN 1 AND 67 AND "shares"."slug" !~ '[\x01-\x2c\x2e\x2f\x3a-\x60\x7b-\x7f]' AND "shares"."slug" !~ '(^-|-$|--)' AND "shares"."slug" !~ '^[0-9a-z]{22}$'));
