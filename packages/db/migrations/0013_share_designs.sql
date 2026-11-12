-- ADR 0013 (share page designer). Additive and safe on the live database with the previous api
-- release still running during the deploy:
-- - share_designs: a photographer's designs (jsonb document validated by the api, revision for
--   optimistic concurrency, at most one default per owner by a partial unique index).
-- - design_assets: design images (JPEG, PNG, WebP) with the upload, processing, quota and purge
--   fields of the design.asset job, the media.sweep re-send and the nightly purges.
-- - shares.design_id: nullable (the previous api never writes it), with a foreign key on
--   (design_id, owner_id) so a share can only use its owner's design.
-- Hand-edited after drizzle-kit generate: ON DELETE SET NULL ("design_id") (drizzle can't express
-- the column list; a plain SET NULL would also null owner_id, which is NOT NULL), as for
-- folders_cover_file_same_owner_fk in 0012.
-- No rewrite of any table: two new tables, one nullable ADD COLUMN without a default, and
-- indexes (shares_design_idx is partial and empty at first).
CREATE TABLE "design_assets" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" uuid NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"status" "file_status" DEFAULT 'uploading' NOT NULL,
	"upload_expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"queued_at" timestamp with time zone,
	"requeues" integer DEFAULT 0 NOT NULL,
	"orphaned_at" timestamp with time zone,
	"purge_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "design_assets_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "design_assets_mime_allowed" CHECK ("design_assets"."mime" IN ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "design_assets_size_positive" CHECK ("design_assets"."size_bytes" > 0),
	CONSTRAINT "design_assets_dimensions_positive" CHECK (("design_assets"."width" IS NULL OR "design_assets"."width" > 0) AND ("design_assets"."height" IS NULL OR "design_assets"."height" > 0)),
	CONSTRAINT "design_assets_ready_complete" CHECK ("design_assets"."status" <> 'ready' OR ("design_assets"."width" IS NOT NULL AND "design_assets"."height" IS NOT NULL AND "design_assets"."verified_at" IS NOT NULL)),
	CONSTRAINT "design_assets_uploading_has_expiry" CHECK ("design_assets"."status" <> 'uploading' OR "design_assets"."upload_expires_at" IS NOT NULL),
	CONSTRAINT "design_assets_requeues_nonnegative" CHECK ("design_assets"."requeues" >= 0)
);
--> statement-breakpoint
CREATE TABLE "share_designs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"doc" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_designs_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "share_designs_name_valid" CHECK (char_length("share_designs"."name") BETWEEN 1 AND 80 AND "share_designs"."name" = btrim("share_designs"."name")),
	CONSTRAINT "share_designs_revision_positive" CHECK ("share_designs"."revision" >= 1),
	CONSTRAINT "share_designs_doc_valid" CHECK (jsonb_typeof("share_designs"."doc") = 'object' AND octet_length("share_designs"."doc"::text) <= 262144)
);
--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "design_id" uuid;--> statement-breakpoint
ALTER TABLE "design_assets" ADD CONSTRAINT "design_assets_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_designs" ADD CONSTRAINT "share_designs_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "design_assets_owner_list_idx" ON "design_assets" USING btree ("owner_id","id" DESC NULLS LAST) WHERE "design_assets"."purge_requested_at" IS NULL;--> statement-breakpoint
CREATE INDEX "design_assets_processing_idx" ON "design_assets" USING btree ("queued_at") WHERE "design_assets"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "design_assets_upload_expiry_idx" ON "design_assets" USING btree ("upload_expires_at") WHERE "design_assets"."status" = 'uploading';--> statement-breakpoint
CREATE INDEX "design_assets_orphaned_idx" ON "design_assets" USING btree ("orphaned_at") WHERE "design_assets"."orphaned_at" IS NOT NULL AND "design_assets"."purge_requested_at" IS NULL;--> statement-breakpoint
CREATE INDEX "design_assets_purge_requested_idx" ON "design_assets" USING btree ("purge_requested_at") WHERE "design_assets"."purge_requested_at" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "share_designs_one_default_per_owner" ON "share_designs" USING btree ("owner_id") WHERE "share_designs"."is_default";--> statement-breakpoint
CREATE INDEX "share_designs_owner_updated_idx" ON "share_designs" USING btree ("owner_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_design_same_owner_fk" FOREIGN KEY ("design_id","owner_id") REFERENCES "public"."share_designs"("id","owner_id") ON DELETE SET NULL ("design_id") ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shares_design_idx" ON "shares" USING btree ("design_id","owner_id") WHERE "shares"."design_id" IS NOT NULL;