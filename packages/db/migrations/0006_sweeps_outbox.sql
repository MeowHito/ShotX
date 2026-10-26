-- ADR 0008 section 3 "Lost jobs": bookkeeping for media.sweep and faces.sweep (when the media
-- pipeline was last started, outbox marks of index.file and index.folder, requeue counters) with
-- small partial indexes, and ON DELETE SET NULL on auth_sessions.replaced_by_id so
-- auth.sessions.purge.daily can delete expired rows in any batch order. Additive: no backfill
-- (null media_queued_at falls back to created_at in the sweep).
ALTER TABLE "auth_sessions" DROP CONSTRAINT "auth_sessions_replaced_by_id_auth_sessions_id_fk";
--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "media_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "media_requeues" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "faces_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "faces_requeues" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "folders" ADD COLUMN "face_index_queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_replaced_by_id_auth_sessions_id_fk" FOREIGN KEY ("replaced_by_id") REFERENCES "public"."auth_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_uploading_created_idx" ON "files" USING btree ("created_at") WHERE "files"."upload_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "files_processing_idx" ON "files" USING btree ("media_queued_at") WHERE "files"."status" = 'processing';--> statement-breakpoint
CREATE INDEX "files_faces_pending_idx" ON "files" USING btree ("faces_queued_at") WHERE "files"."faces_queued_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "folders_face_index_pending_idx" ON "folders" USING btree ("face_index_queued_at") WHERE "folders"."face_index_queued_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_requeues_nonnegative" CHECK ("files"."media_requeues" >= 0 AND "files"."faces_requeues" >= 0);
