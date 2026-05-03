# Data Model — EventDD
PostgreSQL 16 + pgvector extension

---

## Entity Relationship Overview

```
Photographer (1) ──── (N) Event (1) ──── (N) Photo (1) ──── (N) PhotoFace
                                │                                    │
                                └─── (N) GuestSearch ─── (N) SearchResult
                                                              (photo_id FK)

Photographer (1) ──── (N) Subscription
Photographer (1) ──── (1) WatermarkConfig
```

---

## Schema

### `photographers`
```sql
CREATE TABLE photographers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            VARCHAR(200)  NOT NULL,
  email           VARCHAR(255)  NOT NULL UNIQUE,
  password_hash   VARCHAR(255)  NOT NULL,
  plan            VARCHAR(20)   NOT NULL DEFAULT 'basic'
                  CHECK (plan IN ('basic','standard','pro')),
  status          VARCHAR(20)   NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','expired')),

  -- Quota tracking (reset monthly)
  storage_used_bytes  BIGINT  NOT NULL DEFAULT 0,
  fast_quota_used     INT     NOT NULL DEFAULT 0,   -- ภาพที่ใช้ Fast Queue เดือนนี้
  quota_reset_at      TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', NOW()) + INTERVAL '1 month',

  -- Metadata
  avatar_url      TEXT,
  timezone        VARCHAR(50)   NOT NULL DEFAULT 'Asia/Bangkok',
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

### `subscriptions`
```sql
CREATE TABLE subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photographer_id   UUID NOT NULL REFERENCES photographers(id) ON DELETE CASCADE,
  plan              VARCHAR(20)   NOT NULL CHECK (plan IN ('basic','standard','pro')),
  status            VARCHAR(20)   NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','cancelled','expired')),

  -- Billing
  stripe_subscription_id  VARCHAR(100),
  stripe_customer_id      VARCHAR(100),
  amount_thb              INT NOT NULL,             -- ราคาที่จ่ายจริง (สตางค์ x100)

  -- Period
  current_period_start    TIMESTAMPTZ NOT NULL,
  current_period_end      TIMESTAMPTZ NOT NULL,     -- วันหมดอายุ / วันต่ออายุ

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_subscriptions_photographer ON subscriptions(photographer_id);
CREATE INDEX idx_subscriptions_period_end   ON subscriptions(current_period_end);
```

### `events`
```sql
CREATE TABLE events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photographer_id UUID NOT NULL REFERENCES photographers(id) ON DELETE CASCADE,

  -- Info
  name            VARCHAR(300)  NOT NULL,
  event_date      DATE,
  venue           VARCHAR(300),
  slug            VARCHAR(100)  NOT NULL UNIQUE,    -- URL: /e/{slug}
  qr_code_url     TEXT,                             -- S3 URL ของ QR image

  -- Status
  status          VARCHAR(20)   NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','locked','deleted')),
  photo_count     INT           NOT NULL DEFAULT 0,

  -- Retention
  expires_at      TIMESTAMPTZ   NOT NULL,           -- วันหมดอายุตามแพ็กเกจ
  locked_at       TIMESTAMPTZ,                      -- วันที่ lock
  delete_at       TIMESTAMPTZ,                      -- วันที่จะลบถาวร (locked_at + 30d)

  -- Analytics cache
  total_views       INT NOT NULL DEFAULT 0,
  total_downloads   INT NOT NULL DEFAULT 0,
  total_searches    INT NOT NULL DEFAULT 0,

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_events_photographer ON events(photographer_id);
CREATE INDEX idx_events_slug         ON events(slug);
CREATE INDEX idx_events_expires_at   ON events(expires_at);
```

### `photos`
```sql
CREATE TABLE photos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- File info
  filename        VARCHAR(500)  NOT NULL,
  file_url        TEXT          NOT NULL,             -- S3 original (private)
  thumbnail_url   TEXT          NOT NULL,             -- S3 thumbnail 400px (public CDN)
  file_size_bytes BIGINT        NOT NULL DEFAULT 0,
  width           INT,
  height          INT,
  mime_type       VARCHAR(50)   NOT NULL DEFAULT 'image/jpeg',

  -- AI processing
  ai_status       VARCHAR(20)   NOT NULL DEFAULT 'pending'
                  CHECK (ai_status IN ('pending','processing','done','failed')),
  face_count      INT           NOT NULL DEFAULT 0,   -- จำนวนใบหน้าที่ detect ได้
  processed_at    TIMESTAMPTZ,
  ai_error        TEXT,

  -- Queue type used
  queue_type      VARCHAR(20)   CHECK (queue_type IN ('fast','standard')),

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_photos_event          ON photos(event_id);
CREATE INDEX idx_photos_ai_status      ON photos(ai_status);
CREATE INDEX idx_photos_event_status   ON photos(event_id, ai_status);
```

### `photo_faces`
```sql
-- ต้องติดตั้ง pgvector ก่อน
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE photo_faces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id        UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- Face data
  embedding       vector(512)   NOT NULL,             -- InsightFace buffalo_l output
  bbox_x          FLOAT,                              -- Bounding box (normalized 0-1)
  bbox_y          FLOAT,
  bbox_w          FLOAT,
  bbox_h          FLOAT,
  detection_score FLOAT,                              -- Confidence ของ detection

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_photo_faces_photo    ON photo_faces(photo_id);
CREATE INDEX idx_photo_faces_event    ON photo_faces(event_id);

-- Vector index สำหรับ cosine similarity search
-- ใช้ IVFFlat หรือ HNSW ตามขนาดข้อมูล
CREATE INDEX idx_photo_faces_embedding ON photo_faces
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

### `guest_searches`
```sql
CREATE TABLE guest_searches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- Selfie (ลบหลัง search เสร็จ หรือเก็บไว้ชั่วคราว)
  selfie_url      TEXT,                               -- S3 temporary (auto-delete 1 day)
  selfie_deleted  BOOLEAN       NOT NULL DEFAULT FALSE,

  -- Search result
  matched_count   INT           NOT NULL DEFAULT 0,
  search_latency_ms INT,

  -- Session (anonymous)
  session_id      VARCHAR(100),                       -- random UUID จาก client
  line_user_id    VARCHAR(100),                       -- ถ้า login ผ่าน LINE

  ip_address      INET,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_guest_searches_event ON guest_searches(event_id);
CREATE INDEX idx_guest_searches_created ON guest_searches(created_at);
```

### `search_results`
```sql
CREATE TABLE search_results (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  search_id       UUID NOT NULL REFERENCES guest_searches(id) ON DELETE CASCADE,
  photo_id        UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  similarity      FLOAT NOT NULL,                     -- cosine similarity score (0-1)
  rank            INT   NOT NULL                      -- อันดับผลลัพธ์
);
CREATE INDEX idx_search_results_search ON search_results(search_id);
```

### `downloads`
```sql
CREATE TABLE downloads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id        UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  event_id        UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  -- Watermark snapshot (เก็บไว้ว่าตอน download ใช้ config ไหน)
  watermark_text  TEXT,
  watermark_logo  TEXT,

  -- Session
  session_id      VARCHAR(100),
  line_user_id    VARCHAR(100),
  ip_address      INET,

  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_downloads_event   ON downloads(event_id);
CREATE INDEX idx_downloads_photo   ON downloads(photo_id);
CREATE INDEX idx_downloads_created ON downloads(created_at);
```

### `watermark_configs`
```sql
CREATE TABLE watermark_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photographer_id UUID NOT NULL UNIQUE REFERENCES photographers(id) ON DELETE CASCADE,

  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  text            VARCHAR(200)  DEFAULT '',
  logo_url        TEXT,                               -- S3 URL ของโลโก้ PNG

  position        VARCHAR(20)   NOT NULL DEFAULT 'bot-right'
                  CHECK (position IN (
                    'top-left','top-center','top-right',
                    'mid-left','center','mid-right',
                    'bot-left','bot-center','bot-right'
                  )),
  size            VARCHAR(5)    NOT NULL DEFAULT 'M'
                  CHECK (size IN ('S','M','L','XL')),
  opacity         SMALLINT      NOT NULL DEFAULT 70   -- 10-100
                  CHECK (opacity BETWEEN 10 AND 100),

  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
```

### `ai_jobs`
```sql
CREATE TABLE ai_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photo_id        UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  photographer_id UUID NOT NULL REFERENCES photographers(id),

  queue_type      VARCHAR(20)   NOT NULL CHECK (queue_type IN ('fast','standard')),
  status          VARCHAR(20)   NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','processing','done','failed','skipped')),

  -- BullMQ job reference
  bull_job_id     VARCHAR(100),
  worker_id       VARCHAR(50),                        -- Worker-01, Worker-02, etc.

  -- Timing
  queued_at       TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  processing_ms   INT,

  -- Result
  faces_detected  INT,
  error_message   TEXT,
  retry_count     INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_ai_jobs_photo    ON ai_jobs(photo_id);
CREATE INDEX idx_ai_jobs_status   ON ai_jobs(status);
CREATE INDEX idx_ai_jobs_queued   ON ai_jobs(queued_at);
```

---

## Plan Limits (Reference Table)

```sql
-- ใช้ใน Application logic (ไม่ต้อง table จริง)
CREATE OR REPLACE FUNCTION get_plan_limits(plan_name VARCHAR)
RETURNS TABLE(
  storage_bytes     BIGINT,
  fast_quota        INT,
  retention_days    INT
) AS $$
BEGIN
  RETURN QUERY
  SELECT * FROM (VALUES
    ('basic',    5368709120,  0,     7),   -- 5GB
    ('standard', 10737418240, 3000,  30),  -- 10GB
    ('pro',      21474836480, 10000, 30)   -- 20GB
  ) AS t(plan, storage_bytes, fast_quota, retention_days)
  WHERE t.plan = plan_name;
END;
$$ LANGUAGE plpgsql;
```

---

## Key Queries

### Face Search (cosine similarity)
```sql
-- input: selfie_embedding vector(512), event_id uuid, threshold float
SELECT
  pf.photo_id,
  p.thumbnail_url,
  1 - (pf.embedding <=> $1::vector) AS similarity
FROM photo_faces pf
JOIN photos p ON p.id = pf.photo_id
WHERE
  pf.event_id = $2
  AND p.ai_status = 'done'
  AND 1 - (pf.embedding <=> $1::vector) >= $3   -- threshold ~0.4
ORDER BY pf.embedding <=> $1::vector            -- cosine distance ASC
LIMIT 50;
```

### Storage Used (per photographer)
```sql
SELECT
  COALESCE(SUM(p.file_size_bytes), 0) AS total_bytes
FROM photos p
JOIN events e ON e.id = p.event_id
WHERE e.photographer_id = $1
  AND e.status != 'deleted';
```

### Fast Quota Used (current month)
```sql
SELECT COUNT(*) AS fast_used
FROM ai_jobs
WHERE
  photographer_id = $1
  AND queue_type = 'fast'
  AND status = 'done'
  AND queued_at >= date_trunc('month', NOW());
```

---

## Indexes Summary

| Table | Index | Purpose |
|---|---|---|
| `events` | `slug` | QR → event lookup (หลักมาก) |
| `events` | `expires_at` | Cron job หมดอายุ |
| `photos` | `(event_id, ai_status)` | Guest browse |
| `photo_faces` | `event_id` | Pre-filter ก่อน vector search |
| `photo_faces` | `embedding` HNSW | cosine similarity ANN search |
| `downloads` | `(event_id, created_at)` | Analytics |

---

## Migration Order

```
1. photographers
2. subscriptions
3. events
4. photos
5. photo_faces        ← ต้องมี pgvector extension ก่อน
6. watermark_configs
7. ai_jobs
8. guest_searches
9. search_results
10. downloads
```
