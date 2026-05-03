-- Add Google auth + role fields to photographers
ALTER TABLE "photographers"
  ALTER COLUMN "password_hash" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "google_id" VARCHAR(100),
  ADD COLUMN IF NOT EXISTS "auth_provider" VARCHAR(20) NOT NULL DEFAULT 'password',
  ADD COLUMN IF NOT EXISTS "role" VARCHAR(20) NOT NULL DEFAULT 'photographer';

CREATE UNIQUE INDEX IF NOT EXISTS "photographers_google_id_key" ON "photographers" ("google_id");
