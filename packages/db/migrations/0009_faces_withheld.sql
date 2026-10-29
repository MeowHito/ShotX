-- PDPA (Wave 7 CCR): files.faces_withheld_at, set by delete.faces on every file a
-- "ขอลบใบหน้าของฉัน" deletion removed faces from; such a file is never indexed again. The
-- faces.sweep coverage index now excludes withheld files. No backfill: there is no production
-- data, and none would be possible (completed deletions keep counts only, not the files).
DROP INDEX "files_unindexed_ready_idx";--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "faces_withheld_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "files_unindexed_ready_idx" ON "files" USING btree ("folder_id","id") WHERE "files"."status" = 'ready' AND "files"."face_count" IS NULL AND "files"."faces_queued_at" IS NULL AND "files"."deleted_at" IS NULL AND "files"."faces_withheld_at" IS NULL;
