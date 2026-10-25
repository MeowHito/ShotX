-- Hand-assembled from drizzle-kit's diff (the snapshot is the generated one, so later generates
-- diff cleanly). Two changes:
-- 1. shares: target_id (no foreign key, not tied to owner_id) becomes target_file_id or
--    target_folder_id, each with a foreign key on (target, owner_id), so a share can only point at
--    its owner's file or folder. target_type stays; CHECKs keep exactly one target set, matching
--    it. Existing rows are backfilled before target_id is dropped.
-- 2. zip_jobs and zip_job_entries: the zip queue message now carries only the job id.
-- Order matters: shares_id_owner_unique must exist before zip_jobs references (id, owner_id).
ALTER TABLE "shares" ADD COLUMN "target_file_id" uuid;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "target_folder_id" uuid;--> statement-breakpoint
-- Backfill (hand-written): move target_id into the column its target_type names. The foreign
-- keys below then reject any share whose target is missing or belongs to another owner.
UPDATE "shares" SET "target_file_id" = "target_id" WHERE "target_type" = 'file';--> statement-breakpoint
UPDATE "shares" SET "target_folder_id" = "target_id" WHERE "target_type" = 'folder';--> statement-breakpoint
DROP INDEX "shares_target_idx";--> statement-breakpoint
ALTER TABLE "shares" DROP COLUMN "target_id";--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_id_owner_unique" UNIQUE("id","owner_id");--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_one_target" CHECK (num_nonnulls("shares"."target_file_id", "shares"."target_folder_id") = 1);--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_target_matches_type" CHECK (("shares"."target_type" = 'file') = ("shares"."target_file_id" IS NOT NULL) AND ("shares"."target_type" = 'folder') = ("shares"."target_folder_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_target_file_same_owner_fk" FOREIGN KEY ("target_file_id","owner_id") REFERENCES "public"."files"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_target_folder_same_owner_fk" FOREIGN KEY ("target_folder_id","owner_id") REFERENCES "public"."folders"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shares_target_file_idx" ON "shares" USING btree ("target_file_id","owner_id") WHERE "shares"."target_file_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "shares_target_folder_idx" ON "shares" USING btree ("target_folder_id","owner_id") WHERE "shares"."target_folder_id" IS NOT NULL;--> statement-breakpoint
CREATE TYPE "public"."zip_job_status" AS ENUM('queued', 'running', 'ready', 'failed');--> statement-breakpoint
CREATE TABLE "zip_jobs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"photographer_id" uuid NOT NULL,
	"share_id" uuid NOT NULL,
	"viewer_id" uuid,
	"anon_id" uuid,
	"download_size" "download_size" NOT NULL,
	"status" "zip_job_status" DEFAULT 'queued' NOT NULL,
	"file_count" integer NOT NULL,
	"total_bytes" bigint NOT NULL,
	"idempotency_key" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"result_key" text,
	"result_bytes" bigint,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	CONSTRAINT "zip_jobs_id_photographer_unique" UNIQUE("id","photographer_id"),
	CONSTRAINT "zip_jobs_idempotency_unique" UNIQUE("share_id","idempotency_key"),
	CONSTRAINT "zip_jobs_viewer_or_anon" CHECK ("zip_jobs"."viewer_id" IS NOT NULL OR "zip_jobs"."anon_id" IS NOT NULL),
	CONSTRAINT "zip_jobs_file_count_range" CHECK ("zip_jobs"."file_count" BETWEEN 1 AND 10000),
	CONSTRAINT "zip_jobs_bytes_nonnegative" CHECK ("zip_jobs"."total_bytes" >= 0 AND ("zip_jobs"."result_bytes" IS NULL OR "zip_jobs"."result_bytes" >= 0) AND "zip_jobs"."attempts" >= 0),
	CONSTRAINT "zip_jobs_idempotency_key_format" CHECK ("zip_jobs"."idempotency_key" IS NULL OR "zip_jobs"."idempotency_key" ~ '^[!-~]{1,255}$'),
	CONSTRAINT "zip_jobs_result_key_is_zip_key" CHECK ("zip_jobs"."result_key" IS NULL OR "zip_jobs"."result_key" = 'tmp/zips/' || "zip_jobs"."id"::text || '.zip'),
	CONSTRAINT "zip_jobs_error_code_format" CHECK ("zip_jobs"."error_code" IS NULL OR "zip_jobs"."error_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "zip_jobs_ready_has_result" CHECK (("zip_jobs"."status" = 'ready') = ("zip_jobs"."result_key" IS NOT NULL) AND ("zip_jobs"."status" <> 'ready' OR ("zip_jobs"."result_bytes" IS NOT NULL AND "zip_jobs"."expires_at" IS NOT NULL))),
	CONSTRAINT "zip_jobs_failed_has_error" CHECK (("zip_jobs"."status" = 'failed') = ("zip_jobs"."error_code" IS NOT NULL)),
	CONSTRAINT "zip_jobs_completed_iff_finished" CHECK (("zip_jobs"."status" IN ('ready', 'failed')) = ("zip_jobs"."completed_at" IS NOT NULL)),
	CONSTRAINT "zip_jobs_started_when_claimed" CHECK ("zip_jobs"."status" NOT IN ('running', 'ready') OR "zip_jobs"."started_at" IS NOT NULL)
);--> statement-breakpoint
CREATE TABLE "zip_job_entries" (
	"job_id" uuid NOT NULL,
	"photographer_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"file_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "zip_job_entries_pkey" PRIMARY KEY("job_id","position"),
	CONSTRAINT "zip_job_entries_file_unique" UNIQUE("job_id","file_id"),
	CONSTRAINT "zip_job_entries_name_unique" UNIQUE("job_id","name"),
	CONSTRAINT "zip_job_entries_position_range" CHECK ("zip_job_entries"."position" >= 0 AND "zip_job_entries"."position" < 10000),
	CONSTRAINT "zip_job_entries_name_valid" CHECK (octet_length("zip_job_entries"."name") BETWEEN 1 AND 255 AND strpos("zip_job_entries"."name", '/') = 0)
);--> statement-breakpoint
ALTER TABLE "zip_jobs" ADD CONSTRAINT "zip_jobs_photographer_id_users_id_fk" FOREIGN KEY ("photographer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zip_jobs" ADD CONSTRAINT "zip_jobs_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zip_jobs" ADD CONSTRAINT "zip_jobs_share_same_owner_fk" FOREIGN KEY ("share_id","photographer_id") REFERENCES "public"."shares"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zip_job_entries" ADD CONSTRAINT "zip_job_entries_job_same_photographer_fk" FOREIGN KEY ("job_id","photographer_id") REFERENCES "public"."zip_jobs"("id","photographer_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zip_job_entries" ADD CONSTRAINT "zip_job_entries_file_same_photographer_fk" FOREIGN KEY ("file_id","photographer_id") REFERENCES "public"."files"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "zip_job_entries_file_idx" ON "zip_job_entries" USING btree ("file_id","photographer_id");--> statement-breakpoint
CREATE INDEX "zip_jobs_share_created_idx" ON "zip_jobs" USING btree ("share_id","created_at");--> statement-breakpoint
CREATE INDEX "zip_jobs_photographer_created_idx" ON "zip_jobs" USING btree ("photographer_id","created_at");--> statement-breakpoint
CREATE INDEX "zip_jobs_status_created_idx" ON "zip_jobs" USING btree ("status","created_at");