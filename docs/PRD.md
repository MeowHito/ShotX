# PRD — Product Requirements Document
**EventDD** · Version 1.0 · April 2026

---

## 1. Product Summary

**EventDD** คือ SaaS platform สำหรับช่างภาพ Event  
ช่างภาพอัปโหลดภาพ → AI tag ใบหน้าอัตโนมัติ → แขกสแกน QR + ถ่าย Selfie → ได้รับภาพของตัวเองทันที

### ปัญหาที่แก้
| ปัญหา | ก่อน EventDD | หลัง EventDD |
|---|---|---|
| แขกหาภาพตัวเองในงาน | รอ Google Drive / Line album → หายาก | Selfie 1 รูป → เจอทันที |
| ช่างภาพแจกภาพ | Export → อัปโหลดทีหลัง → ส่ง link | Desktop App sync อัตโนมัติ ระหว่างงาน |
| ลายน้ำ | ทำ manual ทีละรูป | ใส่อัตโนมัติตอน download |
| ความเป็นส่วนตัว | ภาพกระจายใน Drive | แขกเห็นแค่ภาพตัวเอง |

---

## 2. Users & Roles

### 2.1 Super Admin (EventDD team)
- จัดการช่างภาพทุกคน
- ดู revenue, MRR, churn
- Monitor GPU workers + AI queue
- Suspend / unlock accounts
- ดู system health + logs
- **UI:** `admin.html`

### 2.2 Photographer (ช่างภาพ — ลูกค้า)
- สมัครสมาชิก → เลือกแพ็กเกจ
- สร้าง Event → ได้ QR Code
- อัปโหลดภาพ (Web UI หรือ Desktop App)
- ตั้งค่า Watermark
- ดู Analytics (views, downloads, searches)
- จัดการ Storage
- **UI:** `dashboard.html`

### 2.3 Guest (แขกในงาน — end user)
- สแกน QR Code จากโต๊ะ/ป้ายในงาน
- เปิดหน้า EventDD ใน Browser ทันที (ไม่ต้องดาวน์โหลด App)
- ถ่าย Selfie → AI ค้นหาภาพที่มีใบหน้าตัวเอง
- กด Like ภาพที่ชอบ
- เลือก + Download หลายภาพ
- แชร์ผ่าน LINE
- **UI:** `guest.html`

---

## 3. Packages & Pricing

| | Basic | Standard | Pro |
|---|---|---|---|
| **ราคา** | ฿499/เดือน | ฿799/เดือน | ฿1,290/เดือน |
| **Storage** | 5 GB | 10 GB | 20 GB |
| **Fast Tagging** | ไม่มี (Standard only) | 3,000 ภาพ/เดือน | 10,000 ภาพ/เดือน |
| **Fast Queue Speed** | — | 10+ ภาพ/นาที | 10+ ภาพ/นาที |
| **Standard Queue Speed** | 1–2 ภาพ/นาที | ใช้เมื่อ Fast หมด | ใช้เมื่อ Fast หมด |
| **อายุจัดเก็บ** | 7 วัน | 30 วัน | 30 วัน |
| **Watermark** | ✓ | ✓ | ✓ |
| **Guest Download** | ฟรี | ฟรี | ฟรี |
| **Events** | ไม่จำกัด | ไม่จำกัด | ไม่จำกัด |

### Queue Rules
```
ช่างภาพ Standard/Pro → ได้ Fast Queue quota รายเดือน
เมื่อ Fast quota หมด → งานในคิวย้ายไป Standard Queue อัตโนมัติ
Standard Queue = shared resource ทุกแพ็กเกจ (FIFO)
```

### Storage & Expiry Rules
```
หมดอายุ (expires_at ผ่านมาแล้ว) → สถานะเปลี่ยนเป็น "Lock"
Lock = ช่างภาพไม่สามารถแก้ไข แต่ EventDD ยังเก็บข้อมูลไว้ 30 วัน
หลัง Lock 30 วัน → ลบถาวร (hard delete)
ช่างภาพ Lock → ต้องต่ออายุก่อนถึงจะเข้าถึงได้
```

---

## 4. Features — Photographer Dashboard

### 4.1 Events Management
- สร้าง Event (ชื่อ, วันที่, สถานที่)
- แต่ละ Event มี QR Code unique สำหรับแขก
- ดูสถานะ: Live / AI Processing / Expired
- ดู views, downloads, จำนวนภาพ, วันหมดอายุ
- ลิงก์ไปยัง Guest View

### 4.2 Photo Upload
- **Web UI upload:** ลากวาง หรือ browse ไฟล์ (JPG, PNG, RAW)
- **Desktop App:** Monitor โฟลเดอร์ → sync อัตโนมัติเมื่อมีภาพใหม่
  - รองรับ Lightroom, Capture One export folder
  - รองรับ macOS และ Windows
  - แสดง sync status real-time
- หลังอัปโหลด → AI job เข้า queue อัตโนมัติ

### 4.3 AI Tagging Queue
- แสดง progress แต่ละงาน (ภาพที่ประมวลผลแล้ว / ทั้งหมด)
- Fast Queue vs Standard Queue indicator
- แสดง ETA
- แสดง Fast quota ที่เหลือ

### 4.4 Watermark
- เปิด/ปิด watermark
- ข้อความ (เช่น `© @photographer_name`)
- Upload โลโก้ (PNG)
- ตำแหน่ง: 9 positions (3x3 grid)
- ขนาด: S / M / L / XL
- ความโปร่งใส: 10–100%
- Preview real-time
- Watermark ใส่ตอน download เท่านั้น — ต้นฉบับใน Storage ไม่เปลี่ยน

### 4.5 Storage
- แสดง Storage used / total
- รายการ Events + ขนาดไฟล์ + วันหมดอายุ
- ลบ Event (ลบไฟล์ทั้งหมดใน Event)

### 4.6 Analytics
- Views, Downloads, Selfie Searches รายเดือน
- กราฟ Downloads รายวัน (7 วันล่าสุด)
- เปรียบเทียบ % เดือนก่อน

### 4.7 Billing
- แสดงแพ็กเกจปัจจุบัน + วันต่ออายุ
- ใช้งาน Storage / Fast Tagging ที่ใช้ไป
- ปุ่ม Upgrade / Downgrade
- ชำระเงิน: Stripe / Omise

---

## 5. Features — Guest UI

### 5.1 Entry Flow
```
แขก สแกน QR → เปิด eventdd.app/e/{event_slug}
→ ถ้าอยู่ใน LINE → LIFF init → ได้ profile (ชื่อ, รูป)
→ ถ้าอยู่นอก LINE → ไม่ login ก็ใช้งานได้ (anonymous)
```

### 5.2 Home Screen
- แสดงชื่องาน, วันที่, สถานที่
- ปุ่ม FAB กลาง = "สแกนใบหน้า" (เปิดกล้อง)
- SVG face detection illustration พร้อม scan beam animation

### 5.3 Face Scan Flow
```
กด FAB → เปิดกล้อง (getUserMedia)
→ ถ่าย Selfie
→ ส่ง selfie ไป POST /api/search/face
→ AI ค้นหาด้วย cosine similarity บน pgvector
→ แสดงผล: ภาพที่ match ทั้งหมด
```

### 5.4 Photo Browsing
- **My Photos** — ผลจาก face scan
- **Liked** — ภาพที่กด like ไว้ (เก็บใน localStorage)
- **All Photos** — ทุกภาพในงาน (ไม่มี face filter)
- Grid 3 คอลัมน์ (compact) / 2 คอลัมน์ (large)

### 5.5 Select & Download
- กด "เลือก" → Select mode: tap ภาพเพื่อ tick
- Topbar เปลี่ยนเป็น "เลือก X ภาพ" + ปุ่ม "โหลด"
- Download รองรับทั้ง 1 ภาพ และหลายภาพ (ZIP)
- ภาพที่ download = ใส่ Watermark แล้ว (server-side)

### 5.6 Like System
- กดหัวใจบนภาพ → Like
- ข้อมูลเก็บใน `localStorage` (ไม่ต้อง login)
- แท็บ "Liked" แสดงเฉพาะภาพที่ like

### 5.7 LINE Share
- ปุ่ม Share → `liff.shareTargetPicker()`
- ถ้าไม่มี LIFF → ใช้ `navigator.share()` (Web Share API)
- ถ้าไม่มีทั้งคู่ → copy link to clipboard

### 5.8 Bottom Navigation
```
[Home] [Liked ❤️] [📷 FAB Scan] [My Photos] [All Photos]
```
- FAB (center) = elevated camera button พร้อม glow effect
- Active tab highlight สี primary

---

## 6. Features — Admin Panel

### 6.1 Dashboard KPIs
- MRR (Monthly Recurring Revenue)
- Active Users
- AI Jobs Today + avg img/min
- Storage Used (total)
- กราฟ MRR รายเดือน (6 เดือน)
- สัดส่วนแพ็กเกจ (Basic/Standard/Pro)
- ลงทะเบียนล่าสุด

### 6.2 Revenue
- MRR, ARR (projection), ARPU
- รายได้ตามแพ็กเกจ
- ประวัติการชำระเงินล่าสุด
- Churn rate, LTV เฉลี่ย

### 6.3 Photographers (Users)
- ค้นหา + filter (แพ็กเกจ, สถานะ)
- ดูรายการ: ชื่อ, อีเมล, แพ็กเกจ, Storage used, สถานะ
- แก้ไข / ระงับ / ปลดระงับ
- เพิ่มผู้ใช้ manual

### 6.4 Subscriptions
- รายการใกล้หมดอายุ (7 วัน)
- รายการ Lock (หมดอายุแล้ว)
- ต่ออายุ / ปลดล็อก manual
- Upgrade เดือนนี้

### 6.5 AI Queue Monitor
- Fast Queue jobs count + avg wait
- Standard Queue jobs count + avg wait
- GPU Worker status (ชื่อ, spec, speed, load%)
- Failed jobs + retry
- Throughput chart (24 ชม.)

### 6.6 Storage Monitor
- Total used / limit
- Accounts >80% (alert)
- Storage ที่ลบได้ (Lock >30d)
- รายการ per account

### 6.7 System Health
- API Server, Database, Redis, Storage — status
- CPU, RAM, Disk, Network metrics
- API response time per endpoint
- Uptime chart 90 วัน

### 6.8 Logs
- Filter: All / Error / Warn / Info
- Search text
- Export logs

---

## 7. Non-Functional Requirements

| | Requirement |
|---|---|
| **AI Accuracy** | ≥ 99% face recognition |
| **Search Latency** | < 500ms สำหรับ cosine similarity search |
| **Upload Speed** | รองรับ RAW files, batch อัปโหลด |
| **Concurrent Users** | รองรับ 500 guests พร้อมกันต่อ event |
| **Uptime** | ≥ 99.9% (ดู Health page) |
| **Privacy** | Face embeddings เก็บใน private DB, ไม่แชร์ออก |
| **Mobile** | Guest UI ต้อง work บน iOS/Android ทุก browser |
| **Offline** | Desktop App queue ไว้ถ้า network ขาด → sync เมื่อกลับมา |
| **PDPA** | แจ้งให้แขกทราบก่อนถ่าย selfie, ลบ selfie หลัง search |

---

## 8. Out of Scope (v1)

- ❌ Video support
- ❌ Album / gallery sharing แบบ public
- ❌ Print ordering
- ❌ Multi-photographer per event
- ❌ Face recognition ระหว่าง event ต่าง event (cross-event search)
- ❌ Mobile App (iOS/Android native)
