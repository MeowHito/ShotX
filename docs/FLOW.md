# User Flows & System Architecture — EventDD

---

## 1. User Flows

### 1.1 Photographer — Onboarding Flow
```
[Landing Page]
    │
    ▼
[สมัครสมาชิก] → ใส่ชื่อ / อีเมล / รหัสผ่าน
    │
    ▼
[เลือกแพ็กเกจ] Basic / Standard / Pro
    │
    ▼
[ชำระเงิน] Stripe Checkout
    │
    ▼
[Dashboard] ← พร้อมใช้งาน
    │
    ├─→ สร้าง Event แรก
    ├─→ ดาวน์โหลด Desktop App
    └─→ ตั้งค่า Watermark
```

---

### 1.2 Photographer — Event Day Flow
```
[Dashboard → สร้าง Event]
    │   ชื่องาน, วันที่, สถานที่
    ▼
[ได้ QR Code] → พิมพ์ / วางในงาน
    │
    ▼
[ถ่ายภาพในงาน]
    │
    ├── Option A: Desktop App (แนะนำ)
    │       Monitor โฟลเดอร์
    │       → ตรวจพบไฟล์ใหม่
    │       → Auto-upload ไป API
    │
    └── Option B: Web Upload
            ลาก-วางไฟล์ใน Dashboard
            → Upload ทีเดียว หลังถ่ายเสร็จ
    │
    ▼
[API รับไฟล์]
    │
    ├── บันทึก Photo record
    ├── อัปโหลดไป S3
    └── สร้าง AI Job → Redis Queue
    │
    ▼
[AI Worker ประมวลผล]
    │
    ├── InsightFace.get(image)
    ├── Extract face embeddings (vector 512-dim)
    └── บันทึก photo_faces table
    │
    ▼
[Photographer ดู Progress]
    Dashboard → AI Queue tab
    เห็น: 154/248 ภาพ ประมวลผลแล้ว ~9 นาที
```

---

### 1.3 Guest — Find My Photos Flow
```
[แขกในงาน]
    │
    ├── สแกน QR Code บนโต๊ะ / ป้าย
    │        ↓
    │   เปิด Browser อัตโนมัติ
    │        ↓
    │   eventdd.app/e/{event-slug}
    │
    ▼
[Guest Page โหลด]
    │
    ├── ถ้าอยู่ใน LINE app → LIFF init → ได้ชื่อ + รูปโปรไฟล์
    └── ถ้าไม่ → Anonymous mode (ใช้งานได้ปกติ)
    │
    ▼
[Home Screen]
    เห็น: ชื่องาน, วันที่, จำนวนภาพ
    ปุ่มกลาง FAB = "เปิดกล้องถ่าย Selfie"
    │
    ▼ กด FAB
[เปิดกล้อง] (getUserMedia)
    │
    ▼ ถ่าย Selfie
[ส่ง Selfie ไป API]
    POST /guest/events/:slug/search
    │
    ▼
[AI Processing ~300-500ms]
    ├── InsightFace detect ใบหน้าใน Selfie
    ├── ได้ embedding vector
    └── pgvector cosine similarity search
    │
    ▼
[แสดงผล "My Photos" tab]
    เห็น: ภาพทุกรูปที่มีหน้าตัวเอง เรียงตาม match score
    │
    ├── กด ❤️ → Like (เก็บใน localStorage)
    ├── กด Select → เลือกหลายภาพ
    │       กด "โหลด" → Download ZIP
    ├── กด Share → LINE ShareTargetPicker
    └── กด ภาพ → Lightbox → ดูใหญ่ / Download / Like / Share
    │
    ▼ กด Download
[GET /guest/photos/:id/download]
    ├── Server ดึง original จาก S3
    ├── Composite Watermark (sharp.js)
    └── Stream ภาพที่ใส่ watermark กลับไป
```

---

## 2. System Architecture

### 2.1 High-Level Architecture
```
┌─────────────────────────────────────────────────────────────┐
│                        CLIENTS                              │
│                                                             │
│  [Browser/LINE]      [Dashboard Browser]  [Desktop App]    │
│   Guest Mobile UI     Photographer UI     Electron App     │
└────────┬─────────────────────┬───────────────────┬─────────┘
         │ HTTPS               │ HTTPS             │ HTTPS
         ▼                     ▼                   ▼
┌─────────────────────────────────────────────────────────────┐
│                    API SERVER (Node.js)                     │
│                  api.eventdd.app                            │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │  Guest   │  │ Photog.  │  │  Admin   │  │ Webhooks  │  │
│  │  Routes  │  │  Routes  │  │  Routes  │  │  Stripe   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬─────┘  │
│       └─────────────┴─────────────┴───────────────┘        │
│                          │                                  │
│              ┌───────────┴───────────┐                      │
│              │    Service Layer      │                      │
│              │ Auth / Event / Photo  │                      │
│              │ Search / Billing etc. │                      │
│              └───────────┬───────────┘                      │
└──────────────────────────┼──────────────────────────────────┘
                           │
         ┌─────────────────┼─────────────────┐
         │                 │                 │
         ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐
│  PostgreSQL  │  │    Redis     │  │   EC2 Local Storage  │
│  + pgvector  │  │  (Queue +    │  │                      │
│              │  │   Cache)     │  │  Original + Thumbs   │
│  Main DB     │  │              │  │  + Watermark logos   │
└──────────────┘  └──────┬───────┘  └──────────────────────┘
                         │
                         │ BullMQ Jobs
                         ▼
          ┌──────────────────────────────┐
          │      AI Workers (GPU)        │
          │                              │
          │  Worker-01  Worker-02  Worker-03  │
          │  RTX 4090   RTX 3090   RTX 3080   │
          │  Vast.ai    Vast.ai    RunPod     │
          │                              │
          │  Python + InsightFace        │
          │  buffalo_l model             │
          └──────────────────────────────┘
```

---

### 2.2 AI Pipeline (Detailed)
```
Photo Upload
    │
    ▼
API Server
  ├── Validate file (type, size)
  ├── Generate UUID + slug
  ├── Upload original → S3 /originals/{photo_id}.jpg
  ├── Generate thumbnail → Upload → S3 /thumbs/{photo_id}.jpg
  ├── INSERT photos (ai_status='pending')
  └── PUBLISH to Redis Queue
       │
       ├── Fast Queue (ถ้ายัง quota เหลือ)
       └── Standard Queue (ถ้า quota หมด หรือ Basic plan)
    │
    ▼
AI Worker (Python FastAPI service)
    │
    ├── POP job จาก BullMQ
    ├── Download photo จาก S3
    ├── img = insightface.app.FaceAnalysis(name='buffalo_l')
    ├── faces = img.get(image)
    ├── For each face:
    │     embedding = face.embedding  # numpy array 512-dim
    │     bbox = face.bbox            # [x1,y1,x2,y2]
    │     INSERT photo_faces (embedding::vector, bbox, score)
    ├── UPDATE photos (ai_status='done', face_count=N)
    └── UPDATE events (photo_count+1)
    │
    ▼
pgvector Index Update (automatic)
    HNSW index อัปเดต embedding ใหม่
    พร้อมค้นหาทันที
```

---

### 2.3 Face Search Flow (Detailed)
```
Guest uploads Selfie
    │
    ▼
API Server
  ├── รับ selfie
  ├── Forward ไป AI Worker (sync HTTP)
  │     Worker.detect_face(selfie) → embedding vector(512)
  ├── ลบ selfie จาก temporary storage (PDPA)
  └── Query pgvector:
        SELECT photo_id, 1-(embedding<=>query_vec) AS similarity
        FROM photo_faces
        WHERE event_id = ?
          AND 1-(embedding<=>query_vec) >= 0.40
        ORDER BY embedding<=>query_vec
        LIMIT 50;
    │
    ▼
Deduplicate photo_id
(หลาย faces ใน 1 ภาพ → ใช้ max similarity)
    │
    ▼
INSERT guest_searches + search_results
    │
    ▼
Return matched photos (thumbnail_url + similarity)
```

---

### 2.4 Watermark Flow
```
Guest requests download
    │
    ▼
GET /guest/photos/:id/download
    │
    ├── ดึง WatermarkConfig ของ photographer
    ├── ดึง original photo จาก S3
    └── Node.js (sharp library):
          const image = sharp(originalBuffer)
          const watermarked = await image
            .composite([{
              input: watermarkLayer,  // text หรือ logo
              gravity: position,      // ตำแหน่งที่เลือก
              blend: 'over'
            }])
            .jpeg({ quality: 90 })
            .toBuffer()
    │
    ▼
Stream watermarked image → Client
    │
    ├── INSERT downloads record
    └── UPDATE events.total_downloads + 1
```

---

## 3. Desktop App Flow

```
Photographer ติดตั้ง EventDD Desktop App (Electron)
    │
    ▼
Login → เชื่อมต่อกับ account
    │
    ▼
เลือก Event ที่ต้องการ Sync
    │
    ▼
เลือก Folder ที่ Lightroom / Capture One Export ภาพไป
    │
    ▼
App Monitor Folder (fs.watch)
    │
    ├── ตรวจพบไฟล์ใหม่ (jpg/png/raw)
    │       → Queue ภาพไว้ใน local queue
    │       → Upload ไป API (concurrent 3 files)
    │       → Show upload progress
    │
    └── ถ้า Network ขาด
            → Queue ไว้ใน local (SQLite)
            → Retry เมื่อ Network กลับมา
    │
    ▼
แสดง Status บน Tray Icon:
    ✓ 154/248 synced · AI Processing...
```

---

## 4. Subscription Lifecycle

```
สมัครใหม่
    │
    ▼
Stripe Checkout complete
    │
    └── Webhook: checkout.session.completed
          → INSERT subscriptions (status='active')
          → UPDATE photographers (plan='standard')
          → ตั้ง expires_at = now + 30 days
    │
    ▼
ใช้งานรายเดือน
    │
    ▼
Stripe auto-renew (ทุกเดือน)
    │
    └── Webhook: invoice.payment_succeeded
          → UPDATE subscriptions (current_period_end = +30d)
          → RESET fast_quota_used = 0
    │
    ▼
ถ้า payment ล้มเหลว
    │
    └── Webhook: invoice.payment_failed
          → ส่ง email แจ้งเตือน
          → ถ้าไม่จ่าย 3 วัน → status = 'expired'
    │
    ▼
Status = Expired → Lock Events
    │
    └── Cron Job ทุกชั่วโมง:
          SELECT events WHERE expires_at < NOW() AND status = 'active'
          → UPDATE status = 'locked', locked_at = NOW()
          → delete_at = locked_at + 30 days
    │
    ▼
30 วันหลัง Lock → ลบถาวร
    │
    └── Cron Job ทุกวัน:
          SELECT events WHERE delete_at < NOW() AND status = 'locked'
          → ลบไฟล์จาก S3
          → DELETE photos, photo_faces, events
```

---

## 5. Cron Jobs

| Job | Schedule | Action |
|---|---|---|
| Lock expired events | ทุกชั่วโมง | `expires_at < NOW()` → status = locked |
| Hard delete | ทุกวัน 02:00 | `delete_at < NOW()` → ลบ S3 + DB |
| Reset fast quota | วันที่ 1 ของเดือน 00:00 | `fast_quota_used = 0` ทุก account |
| Storage report | ทุกวัน 08:00 | Email alert ถ้า account >80% |
| Health check | ทุก 5 นาที | Ping workers, alert ถ้า offline |
| Uptime log | ทุก 1 นาที | บันทึก uptime % |

---

## 6. Security Checklist

| | Item | Implementation |
|---|---|---|
| ✓ | JWT expiry | 24h access token, 30d refresh token |
| ✓ | Rate limiting | nginx + express-rate-limit |
| ✓ | S3 original ไม่ public | Signed URLs สำหรับ AI worker เท่านั้น |
| ✓ | Selfie ลบหลัง search | DELETE S3 object ทันทีหลัง embed |
| ✓ | Guest ไม่ต้อง login | anonymous session_id |
| ✓ | Admin route protect | middleware role check |
| ✓ | SQL injection | Parameterized queries (Prisma / Drizzle) |
| ✓ | File type check | MIME type + magic bytes validation |
| ✓ | Max file size | 50MB per file, 500MB per batch |
| ✓ | CORS | Whitelist eventdd.app domains |
| ✓ | PDPA | แจ้งเตือนก่อน scan, ลบ selfie ทันที |

---

## 7. Environment Setup (Dev)

```bash
# ติดตั้ง dependencies
brew install postgresql@16 redis
psql -c "CREATE EXTENSION vector;"

# Clone + setup
git clone https://github.com/your-org/eventdd
cd eventdd
cp .env.example .env
# แก้ไข .env ตามที่ต้องการ

npm install
npm run db:migrate
npm run db:seed        # ใส่ข้อมูลตัวอย่าง

# Start services
npm run dev            # API server :3000
npm run worker:dev     # AI worker mock (Python)

# เปิดดู prototype
open prototype/index.html
```
