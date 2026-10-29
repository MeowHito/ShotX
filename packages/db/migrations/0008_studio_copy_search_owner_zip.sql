-- Wave 7 (Drive-style studio). Hand-edited after drizzle-kit generate (the snapshot is unaffected):
-- pg_trgm comes first. It is a trusted extension (PostgreSQL 13+), so the database owner can
-- create it on RDS and the VPS; PGlite test databases must load it (contrib/pg_trgm).
-- - copied_from_file_id: copies made by POST /drive/files/:id/copy (the worker's file.copy);
-- - trigram GIN indexes for GET /drive/search, and files_recent_idx for GET /drive/recent;
-- - owner zip jobs (POST /drive/folders/:id/download): zip_jobs.share_id becomes nullable, with
--   archive_name, source_folder_id, their shape checks, a per-photographer idempotency index,
--   and zip entry names that may be relative paths.
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
ALTER TABLE "zip_job_entries" DROP CONSTRAINT "zip_job_entries_name_valid";--> statement-breakpoint
ALTER TABLE "zip_jobs" ALTER COLUMN "share_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "copied_from_file_id" uuid;--> statement-breakpoint
ALTER TABLE "zip_jobs" ADD COLUMN "archive_name" text;--> statement-breakpoint
ALTER TABLE "zip_jobs" ADD COLUMN "source_folder_id" uuid;--> statement-breakpoint
CREATE INDEX "files_recent_idx" ON "files" USING btree ("owner_id","id" DESC NULLS LAST) WHERE "files"."deleted_at" IS NULL AND "files"."status" IN ('processing', 'ready');--> statement-breakpoint
CREATE INDEX "files_name_trgm_idx" ON "files" USING gin (lower("name" COLLATE "C") gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "folders_name_trgm_idx" ON "folders" USING gin (lower("name" COLLATE "C") gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "zip_jobs_owner_idempotency_unique" ON "zip_jobs" USING btree ("photographer_id","idempotency_key") WHERE "zip_jobs"."share_id" IS NULL AND "zip_jobs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "zip_jobs_owner_active_idx" ON "zip_jobs" USING btree ("photographer_id") WHERE "zip_jobs"."share_id" IS NULL AND "zip_jobs"."status" IN ('queued', 'running');--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_copied_from_not_self" CHECK ("files"."copied_from_file_id" IS NULL OR "files"."copied_from_file_id" <> "files"."id");--> statement-breakpoint
ALTER TABLE "zip_job_entries" ADD CONSTRAINT "zip_job_entries_name_valid" CHECK (octet_length("zip_job_entries"."name") BETWEEN 1 AND 1024 AND "zip_job_entries"."name" !~ '(^/|/$|//|(^|/)\.\.?(/|$))');--> statement-breakpoint
ALTER TABLE "zip_jobs" ADD CONSTRAINT "zip_jobs_owner_job_shape" CHECK (("zip_jobs"."share_id" IS NOT NULL AND "zip_jobs"."archive_name" IS NULL AND "zip_jobs"."source_folder_id" IS NULL) OR ("zip_jobs"."share_id" IS NULL AND "zip_jobs"."viewer_id" = "zip_jobs"."photographer_id" AND "zip_jobs"."anon_id" IS NULL AND "zip_jobs"."archive_name" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "zip_jobs" ADD CONSTRAINT "zip_jobs_archive_name_valid" CHECK ("zip_jobs"."archive_name" IS NULL OR (octet_length("zip_jobs"."archive_name") BETWEEN 5 AND 255 AND strpos("zip_jobs"."archive_name", '/') = 0 AND "zip_jobs"."archive_name" LIKE '%.zip'));
