-- ADR 0009: face embeddings of the self-hosted FaceProvider in pgvector (0.8 or newer, for
-- iterative index scans). One table for every model (no fixed dimension); each model gets a
-- partial HNSW index on its dimension's cast. Biometric data: backups exclude this table's data.
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "face_vectors" (
	"face_id" uuid PRIMARY KEY NOT NULL,
	"collection_id" text NOT NULL,
	"external_image_id" text NOT NULL,
	"model" text NOT NULL,
	"embedding" vector NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "face_vectors_collection_idx" ON "face_vectors" USING btree ("collection_id","face_id");--> statement-breakpoint
CREATE INDEX "face_vectors_sface_2021dec_hnsw" ON "face_vectors" USING hnsw (("embedding"::vector(128)) vector_cosine_ops) WHERE "model" = 'sface-2021dec';