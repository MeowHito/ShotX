-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('basic', 'standard', 'pro');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('active', 'suspended', 'expired');

-- CreateEnum
CREATE TYPE "EventStatus" AS ENUM ('active', 'locked', 'deleted');

-- CreateEnum
CREATE TYPE "AiStatus" AS ENUM ('pending', 'processing', 'done', 'failed');

-- CreateEnum
CREATE TYPE "QueueType" AS ENUM ('fast', 'standard');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('queued', 'processing', 'done', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "photographers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" VARCHAR(200) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "password_hash" VARCHAR(255),
    "google_id" VARCHAR(100),
    "auth_provider" VARCHAR(20) NOT NULL DEFAULT 'password',
    "role" VARCHAR(20) NOT NULL DEFAULT 'photographer',
    "plan" "Plan" NOT NULL DEFAULT 'basic',
    "status" "AccountStatus" NOT NULL DEFAULT 'active',
    "storage_used_bytes" BIGINT NOT NULL DEFAULT 0,
    "fast_quota_used" INTEGER NOT NULL DEFAULT 0,
    "quota_reset_at" TIMESTAMPTZ(6) NOT NULL DEFAULT date_trunc('month', NOW()) + INTERVAL '1 month',
    "avatar_url" TEXT,
    "timezone" VARCHAR(50) NOT NULL DEFAULT 'Asia/Bangkok',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "photographers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photographer_id" UUID NOT NULL,
    "plan" "Plan" NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "stripe_subscription_id" VARCHAR(100),
    "stripe_customer_id" VARCHAR(100),
    "amount_thb" INTEGER NOT NULL,
    "current_period_start" TIMESTAMPTZ(6) NOT NULL,
    "current_period_end" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photographer_id" UUID NOT NULL,
    "name" VARCHAR(300) NOT NULL,
    "event_date" DATE,
    "venue" VARCHAR(300),
    "slug" VARCHAR(100) NOT NULL,
    "qr_code_url" TEXT,
    "status" "EventStatus" NOT NULL DEFAULT 'active',
    "photo_count" INTEGER NOT NULL DEFAULT 0,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "locked_at" TIMESTAMPTZ(6),
    "delete_at" TIMESTAMPTZ(6),
    "total_views" INTEGER NOT NULL DEFAULT 0,
    "total_downloads" INTEGER NOT NULL DEFAULT 0,
    "total_searches" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photos" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "filename" VARCHAR(500) NOT NULL,
    "file_url" TEXT NOT NULL,
    "thumbnail_url" TEXT NOT NULL,
    "file_size_bytes" BIGINT NOT NULL DEFAULT 0,
    "width" INTEGER,
    "height" INTEGER,
    "mime_type" VARCHAR(50) NOT NULL DEFAULT 'image/jpeg',
    "ai_status" "AiStatus" NOT NULL DEFAULT 'pending',
    "face_count" INTEGER NOT NULL DEFAULT 0,
    "processed_at" TIMESTAMPTZ(6),
    "ai_error" TEXT,
    "queue_type" "QueueType",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "photo_faces" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photo_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "embedding" vector(512) NOT NULL,
    "bbox_x" DOUBLE PRECISION,
    "bbox_y" DOUBLE PRECISION,
    "bbox_w" DOUBLE PRECISION,
    "bbox_h" DOUBLE PRECISION,
    "detection_score" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "photo_faces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_searches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "event_id" UUID NOT NULL,
    "selfie_url" TEXT,
    "selfie_deleted" BOOLEAN NOT NULL DEFAULT false,
    "matched_count" INTEGER NOT NULL DEFAULT 0,
    "search_latency_ms" INTEGER,
    "session_id" VARCHAR(100),
    "line_user_id" VARCHAR(100),
    "ip_address" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_searches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "search_results" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "search_id" UUID NOT NULL,
    "photo_id" UUID NOT NULL,
    "similarity" DOUBLE PRECISION NOT NULL,
    "rank" INTEGER NOT NULL,

    CONSTRAINT "search_results_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "downloads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photo_id" UUID NOT NULL,
    "event_id" UUID NOT NULL,
    "watermark_text" TEXT,
    "watermark_logo" TEXT,
    "session_id" VARCHAR(100),
    "line_user_id" VARCHAR(100),
    "ip_address" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "downloads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watermark_configs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photographer_id" UUID NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "text" VARCHAR(200) NOT NULL DEFAULT '',
    "logo_url" TEXT,
    "position" VARCHAR(20) NOT NULL DEFAULT 'bot-right',
    "size" VARCHAR(5) NOT NULL DEFAULT 'M',
    "opacity" SMALLINT NOT NULL DEFAULT 70,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "watermark_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_jobs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "photo_id" UUID NOT NULL,
    "photographer_id" UUID NOT NULL,
    "queue_type" "QueueType" NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'queued',
    "bull_job_id" VARCHAR(100),
    "worker_id" VARCHAR(50),
    "queued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "processing_ms" INTEGER,
    "faces_detected" INTEGER,
    "error_message" TEXT,
    "retry_count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ai_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "photographers_email_key" ON "photographers"("email");

-- CreateIndex
CREATE UNIQUE INDEX "photographers_google_id_key" ON "photographers"("google_id");

-- CreateIndex
CREATE INDEX "subscriptions_photographer_id_idx" ON "subscriptions"("photographer_id");

-- CreateIndex
CREATE INDEX "subscriptions_photographer_status_end_idx" ON "subscriptions"("photographer_id", "status", "current_period_end");

-- CreateIndex
CREATE INDEX "subscriptions_current_period_end_idx" ON "subscriptions"("current_period_end");

-- CreateIndex
CREATE UNIQUE INDEX "events_slug_key" ON "events"("slug");

-- CreateIndex
CREATE INDEX "events_photographer_id_idx" ON "events"("photographer_id");

-- CreateIndex
CREATE INDEX "events_photographer_status_created_idx" ON "events"("photographer_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "events_slug_idx" ON "events"("slug");

-- CreateIndex
CREATE INDEX "events_expires_at_idx" ON "events"("expires_at");

-- CreateIndex
CREATE INDEX "photos_event_id_idx" ON "photos"("event_id");

-- CreateIndex
CREATE INDEX "photos_ai_status_idx" ON "photos"("ai_status");

-- CreateIndex
CREATE INDEX "photos_event_id_ai_status_idx" ON "photos"("event_id", "ai_status");

-- CreateIndex
CREATE INDEX "photos_event_created_idx" ON "photos"("event_id", "created_at");

-- CreateIndex
CREATE INDEX "photos_event_ai_created_idx" ON "photos"("event_id", "ai_status", "created_at");

-- CreateIndex
CREATE INDEX "photo_faces_photo_id_idx" ON "photo_faces"("photo_id");

-- CreateIndex
CREATE INDEX "photo_faces_event_id_idx" ON "photo_faces"("event_id");

-- CreateIndex
CREATE INDEX "photo_faces_event_photo_idx" ON "photo_faces"("event_id", "photo_id");

-- CreateIndex
CREATE INDEX "guest_searches_event_id_idx" ON "guest_searches"("event_id");

-- CreateIndex
CREATE INDEX "guest_searches_created_at_idx" ON "guest_searches"("created_at");

-- CreateIndex
CREATE INDEX "search_results_search_id_idx" ON "search_results"("search_id");

-- CreateIndex
CREATE INDEX "downloads_event_id_idx" ON "downloads"("event_id");

-- CreateIndex
CREATE INDEX "downloads_photo_id_idx" ON "downloads"("photo_id");

-- CreateIndex
CREATE INDEX "downloads_created_at_idx" ON "downloads"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "watermark_configs_photographer_id_key" ON "watermark_configs"("photographer_id");

-- CreateIndex
CREATE INDEX "ai_jobs_photo_id_idx" ON "ai_jobs"("photo_id");

-- CreateIndex
CREATE INDEX "ai_jobs_status_idx" ON "ai_jobs"("status");

-- CreateIndex
CREATE INDEX "ai_jobs_queued_at_idx" ON "ai_jobs"("queued_at");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "events" ADD CONSTRAINT "events_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photos" ADD CONSTRAINT "photos_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_faces" ADD CONSTRAINT "photo_faces_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "photo_faces" ADD CONSTRAINT "photo_faces_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_searches" ADD CONSTRAINT "guest_searches_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_results" ADD CONSTRAINT "search_results_search_id_fkey" FOREIGN KEY ("search_id") REFERENCES "guest_searches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_results" ADD CONSTRAINT "search_results_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "downloads" ADD CONSTRAINT "downloads_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watermark_configs" ADD CONSTRAINT "watermark_configs_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_photo_id_fkey" FOREIGN KEY ("photo_id") REFERENCES "photos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_jobs" ADD CONSTRAINT "ai_jobs_photographer_id_fkey" FOREIGN KEY ("photographer_id") REFERENCES "photographers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

