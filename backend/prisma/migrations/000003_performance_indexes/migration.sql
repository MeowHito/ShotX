CREATE INDEX IF NOT EXISTS subscriptions_photographer_status_end_idx
  ON subscriptions (photographer_id, status, current_period_end DESC);

CREATE INDEX IF NOT EXISTS events_photographer_status_created_idx
  ON events (photographer_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS photos_event_created_idx
  ON photos (event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS photos_event_ai_created_idx
  ON photos (event_id, ai_status, created_at DESC);

CREATE INDEX IF NOT EXISTS photo_faces_event_photo_idx
  ON photo_faces (event_id, photo_id);

CREATE INDEX IF NOT EXISTS photo_faces_embedding_cosine_idx
  ON photo_faces USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

ANALYZE subscriptions;
ANALYZE events;
ANALYZE photos;
ANALYZE photo_faces;
