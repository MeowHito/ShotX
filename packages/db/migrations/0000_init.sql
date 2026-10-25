-- Hand-edited after drizzle-kit generate (the snapshot is unaffected, so later generates diff
-- cleanly): ltree comes first, and activity_events is range-partitioned by month, which drizzle
-- can't express. See the end of this file. ltree is a trusted extension (PostgreSQL 13+), so on
-- RDS the database owner can create it without rds_superuser.
CREATE EXTENSION IF NOT EXISTS ltree;--> statement-breakpoint
CREATE TYPE "public"."activity_type" AS ENUM('view', 'scan', 'download', 'zip');--> statement-breakpoint
CREATE TYPE "public"."auth_pool" AS ENUM('users', 'admins');--> statement-breakpoint
CREATE TYPE "public"."billing_mode" AS ENUM('prepaid', 'auto_renew');--> statement-breakpoint
CREATE TYPE "public"."download_size" AS ENUM('web', 'original');--> statement-breakpoint
CREATE TYPE "public"."face_feedback_verdict" AS ENUM('not_me');--> statement-breakpoint
CREATE TYPE "public"."file_status" AS ENUM('uploading', 'processing', 'ready', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('promptpay', 'card');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'paid', 'failed', 'expired', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."share_mode" AS ENUM('gallery', 'face_only');--> statement-breakpoint
CREATE TYPE "public"."share_target_type" AS ENUM('file', 'folder');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trial', 'active', 'grace', 'expired', 'purged');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('photographer', 'admin', 'user');--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subscription_id" uuid NOT NULL,
	"amount_satang" integer NOT NULL,
	"vat_satang" integer NOT NULL,
	"method" "payment_method" NOT NULL,
	"gateway" text NOT NULL,
	"gateway_ref" text NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_gateway_ref_unique" UNIQUE("gateway","gateway_ref"),
	CONSTRAINT "payments_amount_nonnegative" CHECK ("payments"."amount_satang" >= 0),
	CONSTRAINT "payments_vat_within_amount" CHECK ("payments"."vat_satang" >= 0 AND "payments"."vat_satang" <= "payments"."amount_satang"),
	CONSTRAINT "payments_paid_has_paid_at" CHECK ("payments"."status" <> 'paid' OR "payments"."paid_at" IS NOT NULL),
	CONSTRAINT "payments_gateway_format" CHECK ("payments"."gateway" ~ '^[a-z0-9_]{1,32}$'),
	CONSTRAINT "payments_gateway_ref_not_empty" CHECK (length("payments"."gateway_ref") > 0)
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"quota_bytes" bigint NOT NULL,
	"price_month_satang" integer NOT NULL,
	"price_year_satang" integer NOT NULL,
	"trial_days" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "plans_code_unique" UNIQUE("code"),
	CONSTRAINT "plans_code_format" CHECK ("plans"."code" ~ '^[a-z][a-z0-9_]{0,31}$'),
	CONSTRAINT "plans_quota_positive" CHECK ("plans"."quota_bytes" > 0),
	CONSTRAINT "plans_prices_nonnegative" CHECK ("plans"."price_month_satang" >= 0 AND "plans"."price_year_satang" >= 0),
	CONSTRAINT "plans_trial_days_positive" CHECK ("plans"."trial_days" IS NULL OR "plans"."trial_days" > 0)
);
--> statement-breakpoint
CREATE TABLE "storage_usage" (
	"photographer_id" uuid PRIMARY KEY NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "storage_usage_nonnegative" CHECK ("storage_usage"."used_bytes" >= 0 AND "storage_usage"."reserved_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"photographer_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "subscription_status" NOT NULL,
	"billing" "billing_mode" DEFAULT 'prepaid' NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text,
	"name" text,
	"role" "user_role" DEFAULT 'user' NOT NULL,
	"cognito_pool" "auth_pool" NOT NULL,
	"cognito_sub" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_cognito_identity_unique" UNIQUE("cognito_pool","cognito_sub"),
	CONSTRAINT "users_admin_iff_admins_pool" CHECK (("users"."role" = 'admin') = ("users"."cognito_pool" = 'admins')),
	CONSTRAINT "users_cognito_sub_not_empty" CHECK (length("users"."cognito_sub") > 0)
);
--> statement-breakpoint
CREATE TABLE "faces" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"file_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"rekognition_face_id" text NOT NULL,
	"bbox" jsonb NOT NULL,
	"confidence" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "faces_rekognition_face_id_unique" UNIQUE("rekognition_face_id"),
	CONSTRAINT "faces_confidence_range" CHECK ("faces"."confidence" BETWEEN 0 AND 100),
	CONSTRAINT "faces_bbox_object" CHECK (jsonb_typeof("faces"."bbox") = 'object')
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" uuid NOT NULL,
	"folder_id" uuid,
	"name" text NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text,
	"s3_key" text NOT NULL,
	"thumb_key" text,
	"preview_key" text,
	"web_key" text,
	"poster_key" text,
	"width" integer,
	"height" integer,
	"taken_at" timestamp with time zone,
	"status" "file_status" DEFAULT 'uploading' NOT NULL,
	"face_count" integer,
	"upload_id" text,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_s3_key_unique" UNIQUE("s3_key"),
	CONSTRAINT "files_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "files_name_valid" CHECK (length("files"."name") BETWEEN 1 AND 1024),
	CONSTRAINT "files_size_nonnegative" CHECK ("files"."size_bytes" >= 0),
	CONSTRAINT "files_sha256_hex" CHECK ("files"."sha256" IS NULL OR "files"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "files_dimensions_positive" CHECK (("files"."width" IS NULL OR "files"."width" > 0) AND ("files"."height" IS NULL OR "files"."height" > 0)),
	CONSTRAINT "files_face_count_nonnegative" CHECK ("files"."face_count" IS NULL OR "files"."face_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"path" "ltree" NOT NULL,
	"face_index_enabled" boolean DEFAULT false NOT NULL,
	"face_index_expires_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "folders_name_valid" CHECK (length("folders"."name") BETWEEN 1 AND 255 AND strpos("folders"."name", '/') = 0),
	CONSTRAINT "folders_path_ends_with_own_label" CHECK (subpath("folders"."path", -1) = text2ltree(replace("folders"."id"::text, '-', '_'))),
	CONSTRAINT "folders_root_iff_no_parent" CHECK (("folders"."parent_id" IS NULL) = (nlevel("folders"."path") = 1))
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"share_id" uuid NOT NULL,
	"viewer_id" uuid,
	"anon_id" uuid,
	"policy_version" text NOT NULL,
	"ip_hash" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "consents_viewer_or_anon" CHECK ("consents"."viewer_id" IS NOT NULL OR "consents"."anon_id" IS NOT NULL),
	CONSTRAINT "consents_policy_version_not_empty" CHECK (length("consents"."policy_version") > 0)
);
--> statement-breakpoint
CREATE TABLE "face_feedback" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"share_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"similarity" real NOT NULL,
	"verdict" "face_feedback_verdict" DEFAULT 'not_me' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "face_feedback_similarity_range" CHECK ("face_feedback"."similarity" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" uuid NOT NULL,
	"target_type" "share_target_type" NOT NULL,
	"target_id" uuid NOT NULL,
	"token" text NOT NULL,
	"mode" "share_mode" DEFAULT 'gallery' NOT NULL,
	"allow_download" boolean DEFAULT true NOT NULL,
	"download_size" "download_size" DEFAULT 'web' NOT NULL,
	"require_login" boolean DEFAULT false NOT NULL,
	"password_hash" text,
	"expires_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shares_token_unique" UNIQUE("token"),
	CONSTRAINT "shares_token_base62" CHECK ("shares"."token" ~ '^[0-9A-Za-z]{16,64}$')
);
--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" bigint GENERATED BY DEFAULT AS IDENTITY (sequence name "activity_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"type" "activity_type" NOT NULL,
	"share_id" uuid NOT NULL,
	"file_id" uuid,
	"photographer_id" uuid NOT NULL,
	"viewer_id" uuid,
	"anon_id" uuid,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_events_pkey" PRIMARY KEY("id","created_at"),
	CONSTRAINT "activity_events_bytes_nonnegative" CHECK ("activity_events"."bytes" >= 0)
) PARTITION BY RANGE ("created_at");
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"actor_id" uuid NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_stats" (
	"date" date NOT NULL,
	"photographer_id" uuid NOT NULL,
	"visitors" integer DEFAULT 0 NOT NULL,
	"scanners" integer DEFAULT 0 NOT NULL,
	"scans" integer DEFAULT 0 NOT NULL,
	"downloads" integer DEFAULT 0 NOT NULL,
	"unique_downloaders" integer DEFAULT 0 NOT NULL,
	"bytes_out" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_stats_pkey" PRIMARY KEY("date","photographer_id"),
	CONSTRAINT "daily_stats_nonnegative" CHECK ("daily_stats"."visitors" >= 0 AND "daily_stats"."scanners" >= 0 AND "daily_stats"."scans" >= 0 AND "daily_stats"."downloads" >= 0 AND "daily_stats"."unique_downloaders" >= 0 AND "daily_stats"."bytes_out" >= 0)
);
--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_usage" ADD CONSTRAINT "storage_usage_photographer_id_users_id_fk" FOREIGN KEY ("photographer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_photographer_id_users_id_fk" FOREIGN KEY ("photographer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faces" ADD CONSTRAINT "faces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "faces" ADD CONSTRAINT "faces_file_same_owner_fk" FOREIGN KEY ("file_id","owner_id") REFERENCES "public"."files"("id","owner_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_folder_same_owner_fk" FOREIGN KEY ("folder_id","owner_id") REFERENCES "public"."folders"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_same_owner_fk" FOREIGN KEY ("parent_id","owner_id") REFERENCES "public"."folders"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_viewer_id_users_id_fk" FOREIGN KEY ("viewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_feedback" ADD CONSTRAINT "face_feedback_share_id_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "face_feedback" ADD CONSTRAINT "face_feedback_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_stats" ADD CONSTRAINT "daily_stats_photographer_id_users_id_fk" FOREIGN KEY ("photographer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_subscription_idx" ON "payments" USING btree ("subscription_id");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_one_live_per_photographer" ON "subscriptions" USING btree ("photographer_id") WHERE "subscriptions"."status" IN ('trial', 'active', 'grace');--> statement-breakpoint
CREATE INDEX "subscriptions_photographer_idx" ON "subscriptions" USING btree ("photographer_id");--> statement-breakpoint
CREATE INDEX "subscriptions_status_period_end_idx" ON "subscriptions" USING btree ("status","period_end");--> statement-breakpoint
CREATE INDEX "faces_file_owner_idx" ON "faces" USING btree ("file_id","owner_id");--> statement-breakpoint
CREATE INDEX "faces_owner_idx" ON "faces" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "files_folder_owner_idx" ON "files" USING btree ("folder_id","owner_id");--> statement-breakpoint
CREATE INDEX "files_owner_idx" ON "files" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "files_trashed_idx" ON "files" USING btree ("deleted_at") WHERE "files"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "folders_path_gist" ON "folders" USING gist ("path");--> statement-breakpoint
CREATE INDEX "folders_parent_owner_idx" ON "folders" USING btree ("parent_id","owner_id");--> statement-breakpoint
CREATE INDEX "folders_owner_idx" ON "folders" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "folders_face_index_expiry_idx" ON "folders" USING btree ("face_index_expires_at") WHERE "folders"."face_index_enabled";--> statement-breakpoint
CREATE INDEX "consents_share_viewer_idx" ON "consents" USING btree ("share_id","viewer_id");--> statement-breakpoint
CREATE INDEX "consents_share_anon_idx" ON "consents" USING btree ("share_id","anon_id");--> statement-breakpoint
CREATE INDEX "face_feedback_share_idx" ON "face_feedback" USING btree ("share_id");--> statement-breakpoint
CREATE INDEX "face_feedback_file_idx" ON "face_feedback" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "shares_owner_idx" ON "shares" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "shares_target_idx" ON "shares" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "activity_events_photographer_created_idx" ON "activity_events" USING btree ("photographer_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_events_share_created_idx" ON "activity_events" USING btree ("share_id","created_at");--> statement-breakpoint
CREATE INDEX "activity_events_created_brin" ON "activity_events" USING brin ("created_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_created_idx" ON "audit_log" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_target_idx" ON "audit_log" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "daily_stats_photographer_date_idx" ON "daily_stats" USING btree ("photographer_id","date");--> statement-breakpoint
-- activity_events partitions (hand-written). One partition per UTC calendar month, named
-- activity_events_YYYY_MM, plus a default partition so an insert never fails for lack of one.
-- Indexes and the primary key on the parent apply to every partition automatically.
CREATE TABLE "public"."activity_events_default" PARTITION OF "public"."activity_events" DEFAULT;--> statement-breakpoint
-- Creates the monthly partitions from from_time's month through months_ahead months later, and
-- returns how many it created. Idempotent and safe to run concurrently (advisory lock). Rows the
-- default partition caught for a month are moved into that month's new partition. Called by the
-- hourly stats.rollup.hourly job: SELECT activity_events_ensure_partitions();
CREATE FUNCTION "public"."activity_events_ensure_partitions"(
	from_time timestamp with time zone DEFAULT now(),
	months_ahead integer DEFAULT 3
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
	first_month date := date_trunc('month', from_time AT TIME ZONE 'UTC')::date;
	month_start date;
	partition_name text;
	range_start timestamp with time zone;
	range_end timestamp with time zone;
	created integer := 0;
BEGIN
	IF months_ahead IS NULL OR months_ahead < 0 OR months_ahead > 120 THEN
		RAISE EXCEPTION 'months_ahead must be between 0 and 120, got %', months_ahead;
	END IF;
	PERFORM pg_advisory_xact_lock(hashtext('public.activity_events_ensure_partitions'));
	FOR i IN 0..months_ahead LOOP
		month_start := (first_month + make_interval(months => i))::date;
		partition_name := 'activity_events_' || to_char(month_start, 'YYYY_MM');
		CONTINUE WHEN to_regclass(format('public.%I', partition_name)) IS NOT NULL;
		range_start := month_start::timestamp AT TIME ZONE 'UTC';
		range_end := (month_start + interval '1 month')::timestamp AT TIME ZONE 'UTC';
		-- A new partition can't be created while the default partition holds rows in its range.
		CREATE TEMP TABLE activity_events_moving ON COMMIT DROP AS
			SELECT * FROM public.activity_events_default
			WHERE created_at >= range_start AND created_at < range_end;
		DELETE FROM public.activity_events_default
			WHERE created_at >= range_start AND created_at < range_end;
		EXECUTE format(
			'CREATE TABLE public.%I PARTITION OF public.activity_events FOR VALUES FROM (%L) TO (%L)',
			partition_name, range_start, range_end
		);
		INSERT INTO public.activity_events SELECT * FROM pg_temp.activity_events_moving;
		DROP TABLE pg_temp.activity_events_moving;
		created := created + 1;
	END LOOP;
	RETURN created;
END;
$$;--> statement-breakpoint
SELECT "public"."activity_events_ensure_partitions"(now(), 3);