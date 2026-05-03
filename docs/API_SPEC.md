# API Specification — EventDD
Base URL: `https://api.eventdd.app/api/v1`  
Auth: Bearer JWT (ยกเว้น guest endpoints)

---

## Authentication

### POST `/auth/register`
สมัครสมาชิกช่างภาพใหม่

**Request**
```json
{
  "name": "สมชาย วงศ์ใหญ่",
  "email": "somchai@gmail.com",
  "password": "securepassword123"
}
```
**Response 201**
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "photographer": {
    "id": "uuid",
    "name": "สมชาย วงศ์ใหญ่",
    "email": "somchai@gmail.com",
    "plan": "basic",
    "created_at": "2026-04-27T00:00:00Z"
  }
}
```

---

### POST `/auth/login`
**Request**
```json
{
  "email": "somchai@gmail.com",
  "password": "securepassword123"
}
```
**Response 200**
```json
{
  "token": "eyJhbGciOiJIUzI1NiJ9...",
  "photographer": { ... }
}
```

---

### GET `/auth/me`
`Authorization: Bearer {token}`

**Response 200**
```json
{
  "id": "uuid",
  "name": "สมชาย วงศ์ใหญ่",
  "email": "somchai@gmail.com",
  "plan": "standard",
  "status": "active",
  "storage_used_bytes": 5154000000,
  "fast_quota_used": 1158,
  "plan_limits": {
    "storage_bytes": 10737418240,
    "fast_quota": 3000,
    "retention_days": 30
  }
}
```

---

## Events

### GET `/events`
`Authorization: Bearer {token}`

**Query Params**
| Param | Type | Default |
|---|---|---|
| `page` | int | 1 |
| `limit` | int | 20 |
| `status` | string | all |

**Response 200**
```json
{
  "events": [
    {
      "id": "uuid",
      "name": "งานแต่งงาน คุณต้อม & คุณนุ่น",
      "event_date": "2026-01-25",
      "venue": "แกรนด์ไฮแอท เอราวัณ",
      "slug": "tom-nun-wedding-2026",
      "qr_code_url": "https://cdn.eventdd.app/qr/tom-nun-wedding-2026.png",
      "status": "active",
      "photo_count": 248,
      "expires_at": "2026-02-24T00:00:00Z",
      "days_remaining": 28,
      "total_views": 1842,
      "total_downloads": 421,
      "total_searches": 134,
      "created_at": "2026-01-25T08:00:00Z"
    }
  ],
  "total": 12,
  "page": 1,
  "limit": 20
}
```

---

### POST `/events`
สร้าง Event ใหม่  
`Authorization: Bearer {token}`

**Request**
```json
{
  "name": "งานแต่งงาน คุณA & คุณB",
  "event_date": "2026-05-10",
  "venue": "โรงแรม ABC กรุงเทพ"
}
```
**Response 201**
```json
{
  "id": "uuid",
  "slug": "a-b-wedding-2026",
  "qr_code_url": "https://cdn.eventdd.app/qr/a-b-wedding-2026.png",
  "guest_url": "https://eventdd.app/e/a-b-wedding-2026",
  "expires_at": "2026-06-09T00:00:00Z"
}
```

---

### GET `/events/:id`
**Response 200** — รายละเอียด event พร้อม analytics

---

### DELETE `/events/:id`
ลบ event และภาพทั้งหมด  
**Response 204**

---

## Photos

### POST `/events/:eventId/photos`
อัปโหลดภาพ (multipart/form-data)  
`Authorization: Bearer {token}`

**Request** `Content-Type: multipart/form-data`
```
files[]: (binary) IMG_001.jpg
files[]: (binary) IMG_002.jpg
```

**Response 202**
```json
{
  "uploaded": 2,
  "failed": 0,
  "jobs": [
    {
      "photo_id": "uuid",
      "filename": "IMG_001.jpg",
      "job_id": "bull-job-id-001",
      "queue_type": "fast"
    }
  ],
  "fast_quota_remaining": 1840
}
```

**Error 402** — Storage full
```json
{
  "error": "storage_limit_exceeded",
  "message": "Storage เต็ม กรุณาอัปเกรดหรือลบไฟล์เก่า",
  "storage_used_bytes": 10737418240,
  "storage_limit_bytes": 10737418240
}
```

---

### GET `/events/:eventId/photos`
ดูรายการภาพ  
`Authorization: Bearer {token}` (photographer)

**Query Params**
| Param | Type | Default |
|---|---|---|
| `page` | int | 1 |
| `limit` | int | 50 |
| `ai_status` | string | all |

**Response 200**
```json
{
  "photos": [
    {
      "id": "uuid",
      "thumbnail_url": "https://cdn.eventdd.app/thumb/photo-uuid.jpg",
      "face_count": 3,
      "ai_status": "done",
      "file_size_bytes": 4200000,
      "created_at": "2026-01-25T14:30:00Z"
    }
  ],
  "total": 248,
  "page": 1
}
```

---

## Guest — Face Search

### GET `/guest/events/:slug`
ดูข้อมูล Event (public, ไม่ต้อง auth)

**Response 200**
```json
{
  "id": "uuid",
  "name": "งานแต่งงาน คุณต้อม & คุณนุ่น",
  "event_date": "2026-01-25",
  "venue": "แกรนด์ไฮแอท เอราวัณ",
  "photo_count": 248,
  "photographer_name": "สมชาย วงศ์ใหญ่",
  "status": "active"
}
```
**Error 404** — Event ไม่พบ  
**Error 410** — Event หมดอายุ (locked)

---

### POST `/guest/events/:slug/search`
ค้นหาภาพด้วย Selfie (public)

**Request** `Content-Type: multipart/form-data`
```
selfie: (binary) selfie.jpg
session_id: "random-uuid-from-client"
```

**Processing Flow**
```
1. รับ selfie → ส่งไป AI Worker
2. Worker รัน InsightFace.get(selfie) → ได้ embedding vector(512)
3. pgvector cosine similarity search บน photo_faces WHERE event_id = ?
4. Filter similarity >= 0.40
5. Group by photo_id (1 ภาพ อาจ match หลาย face)
6. Return top 50 photos เรียงตาม similarity DESC
7. ลบ selfie จาก storage (PDPA)
```

**Response 200**
```json
{
  "search_id": "uuid",
  "matched_count": 23,
  "latency_ms": 342,
  "photos": [
    {
      "id": "uuid",
      "thumbnail_url": "https://cdn.eventdd.app/thumb/photo-uuid.jpg",
      "similarity": 0.923,
      "face_count": 2
    }
  ]
}
```
**Error 422** — ไม่พบใบหน้าใน selfie
```json
{ "error": "no_face_detected", "message": "ไม่พบใบหน้าในภาพ กรุณาถ่ายใหม่" }
```

---

### GET `/guest/events/:slug/photos`
ดูทุกภาพในงาน (public, no face filter)

**Query Params**
| Param | Type | Default |
|---|---|---|
| `page` | int | 1 |
| `limit` | int | 50 |

**Response 200**
```json
{
  "photos": [ { "id": "uuid", "thumbnail_url": "...", "face_count": 3 } ],
  "total": 248,
  "page": 1
}
```

---

### GET `/guest/photos/:photoId/download`
Download ภาพพร้อม Watermark (public)

**Query Params**
| Param | Type | Required |
|---|---|---|
| `session_id` | string | ✓ |
| `event_slug` | string | ✓ |

**Processing**
```
1. ดึง original photo จาก S3
2. ดึง WatermarkConfig ของ photographer
3. Composite watermark ลงภาพ (sharp.js หรือ Jimp)
4. Stream ภาพที่ใส่ watermark แล้วไปให้ client
5. บันทึก downloads table
6. อัปเดต events.total_downloads + 1
```
**Response** — Binary image stream  
`Content-Type: image/jpeg`  
`Content-Disposition: attachment; filename="eventdd-{photoId}.jpg"`

---

### POST `/guest/photos/download-zip`
Download หลายภาพพร้อมกัน (ZIP)

**Request**
```json
{
  "photo_ids": ["uuid1", "uuid2", "uuid3"],
  "event_slug": "tom-nun-wedding-2026",
  "session_id": "random-uuid"
}
```
**Response** — ZIP stream  
`Content-Type: application/zip`

---

## Watermark

### GET `/watermark`
`Authorization: Bearer {token}`

**Response 200**
```json
{
  "enabled": true,
  "text": "© @สมชาย_photo",
  "logo_url": null,
  "position": "bot-right",
  "size": "M",
  "opacity": 70
}
```

---

### PUT `/watermark`
`Authorization: Bearer {token}`

**Request**
```json
{
  "enabled": true,
  "text": "© @สมชาย_photo",
  "position": "bot-right",
  "size": "M",
  "opacity": 70
}
```
**Response 200** — Updated config

---

### POST `/watermark/logo`
Upload โลโก้ Watermark  
`Authorization: Bearer {token}`  
`Content-Type: multipart/form-data`

**Response 200**
```json
{ "logo_url": "https://cdn.eventdd.app/logos/photographer-uuid.png" }
```

---

## Analytics

### GET `/analytics/overview`
`Authorization: Bearer {token}`

**Response 200**
```json
{
  "period": "2026-04",
  "views": 8421,
  "views_change_pct": 24.0,
  "downloads": 1247,
  "downloads_change_pct": 18.0,
  "selfie_searches": 634,
  "searches_change_pct": 41.0,
  "daily_downloads": [
    { "date": "2026-04-20", "count": 156 },
    { "date": "2026-04-21", "count": 241 }
  ]
}
```

---

## Billing

### GET `/billing`
`Authorization: Bearer {token}`

**Response 200**
```json
{
  "plan": "standard",
  "status": "active",
  "amount_thb": 799,
  "current_period_end": "2026-05-24T00:00:00Z",
  "stripe_customer_portal_url": "https://billing.stripe.com/session/..."
}
```

---

### POST `/billing/upgrade`
`Authorization: Bearer {token}`

**Request**
```json
{ "plan": "pro" }
```
**Response 200**
```json
{
  "checkout_url": "https://checkout.stripe.com/..."
}
```

---

## Admin Endpoints (Role: admin)

### GET `/admin/stats`
**Response 200**
```json
{
  "mrr_thb": 124830,
  "mrr_change_pct": 12.4,
  "active_users": 248,
  "new_users_30d": 18,
  "ai_jobs_today": 14382,
  "ai_avg_speed": 9.2,
  "storage_used_bytes": 1367343677440,
  "storage_limit_bytes": 2199023255552
}
```

---

### GET `/admin/photographers`
**Query Params:** `page`, `limit`, `plan`, `status`, `q` (search)

**Response 200**
```json
{
  "photographers": [
    {
      "id": "uuid",
      "name": "สมชาย วงศ์ใหญ่",
      "email": "somchai@gmail.com",
      "plan": "pro",
      "status": "active",
      "storage_used_bytes": 19543654400,
      "storage_limit_bytes": 21474836480,
      "subscription_expires": "2026-05-10T00:00:00Z",
      "created_at": "2026-01-01T00:00:00Z"
    }
  ],
  "total": 248
}
```

---

### PATCH `/admin/photographers/:id`
แก้ไข / ระงับ / ปลดระงับ

**Request**
```json
{
  "status": "suspended",
  "note": "ละเมิด TOS"
}
```

---

### GET `/admin/queue/status`
**Response 200**
```json
{
  "fast_queue": { "waiting": 142, "avg_wait_seconds": 4 },
  "standard_queue": { "waiting": 1830, "avg_wait_seconds": 1080 },
  "workers": [
    {
      "id": "worker-01",
      "name": "Worker-01 (Vast.ai)",
      "gpu": "RTX 4090",
      "speed_img_per_min": 18.3,
      "queue_type": "fast",
      "load_pct": 78,
      "status": "online"
    }
  ],
  "failed_jobs": 7
}
```

---

### GET `/admin/revenue`
**Response 200**
```json
{
  "mrr": 124830,
  "arr_projection": 1497960,
  "arpu": 503,
  "by_plan": [
    { "plan": "basic",    "count": 98,  "revenue": 48902 },
    { "plan": "standard", "count": 112, "revenue": 89488 },
    { "plan": "pro",      "count": 38,  "revenue": 49020 }
  ],
  "recent_payments": [ ... ],
  "churn_rate_pct": 2.8,
  "ltv_avg_thb": 6240
}
```

---

### GET `/admin/health`
**Response 200**
```json
{
  "api": { "status": "ok", "uptime_pct": 99.98 },
  "database": { "status": "ok", "latency_ms": 2 },
  "redis": { "status": "ok" },
  "storage": {
    "status": "warn",
    "used_bytes": 1367343677440,
    "total_bytes": 2199023255552,
    "used_pct": 62.2
  },
  "server": {
    "cpu_pct": 34,
    "ram_pct": 58,
    "ram_used_gb": 11.6,
    "ram_total_gb": 20
  },
  "api_latency": {
    "GET /events": 42,
    "POST /guest/.../search": 380,
    "GET /guest/photos/.../download": 118
  }
}
```

---

### GET `/admin/logs`
**Query Params:** `level` (all/error/warn/info), `q`, `page`, `limit`

**Response 200**
```json
{
  "logs": [
    {
      "timestamp": "2026-04-24T14:32:18Z",
      "level": "INFO",
      "message": "Worker-01: processed job_9a2b3c in 0.23s"
    }
  ],
  "total": 1200
}
```

---

## Webhooks (Stripe → EventDD)

### POST `/webhooks/stripe`

Events ที่ต้อง handle:
| Stripe Event | Action |
|---|---|
| `checkout.session.completed` | Activate subscription |
| `invoice.payment_succeeded` | Renew subscription, reset quota |
| `invoice.payment_failed` | Send alert email |
| `customer.subscription.deleted` | Set status = expired |

---

## Error Format (Standard)

```json
{
  "error": "error_code_snake_case",
  "message": "Human-readable message (Thai or English)",
  "details": {}
}
```

| HTTP | Error Code | Meaning |
|---|---|---|
| 400 | `validation_error` | Input ไม่ถูกต้อง |
| 401 | `unauthorized` | ไม่มี / token หมดอายุ |
| 403 | `forbidden` | ไม่มีสิทธิ์ |
| 404 | `not_found` | ไม่พบ resource |
| 410 | `event_expired` | Event หมดอายุ (locked) |
| 422 | `no_face_detected` | ไม่พบใบหน้าใน selfie |
| 402 | `storage_limit_exceeded` | Storage เต็ม |
| 402 | `quota_exceeded` | Fast quota หมด (ย้ายไป Standard อัตโนมัติ) |
| 429 | `rate_limited` | Request เยอะเกินไป |
| 500 | `internal_error` | Server error |

---

## Rate Limiting

| Endpoint | Limit |
|---|---|
| `POST /guest/.../search` | 10 requests / IP / นาที |
| `GET /guest/.../download` | 50 requests / IP / ชั่วโมง |
| `POST /events/:id/photos` | 100 requests / photographer / นาที |
| Admin endpoints | 300 requests / นาที |
