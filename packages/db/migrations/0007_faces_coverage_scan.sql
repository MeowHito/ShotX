-- ADR 0008 section 3: the faces.sweep coverage scan (ready files never indexed, with no index.file
-- outstanding) reads its candidates per folder from this partial index. Index only; no data change.
CREATE INDEX "files_unindexed_ready_idx" ON "files" USING btree ("folder_id","id") WHERE "files"."status" = 'ready' AND "files"."face_count" IS NULL AND "files"."faces_queued_at" IS NULL AND "files"."deleted_at" IS NULL;
