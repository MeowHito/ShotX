# รายงานการทำงานข้ามคืน (25–26 ต.ค. 2026)

## สรุปสั้น

- **ทำเสร็จและ commit แล้ว:** Phase 1 (foundations), Phase 2 (Drive), Phase 3 (แชร์ + สแกนหน้า + ดาวน์โหลด) และ Phase 4 (Billing) พร้อมแก้ข้อ major ของ Phase 3 ทุกรอบผ่าน reviewer แบบ GO
- **หยุดที่ Phase 4 ตามที่สั่ง** ไม่ทำ Phase 5, 6 และ E2E
- **Phase 4 ยังมี major 2 ข้อที่ต้องแก้ก่อนถือว่าเสร็จและก่อนใช้ gateway จริง** (ดูหัวข้อผล reviewer)
- wave 5 เคยหยุดเพราะชนเพดานการใช้งาน แล้วทำต่อจนจบหลังเปลี่ยนบัญชี
- **Phase 0 ยังไม่ผ่าน:** ผลความแม่นมาจากข้อมูลจำลองเท่านั้น face search จึงปิดอยู่ด้วย `FACE_SEARCH_ENABLED=false`
- **ไม่ได้ทำตามที่สั่ง:** ไม่ push, ไม่ deploy, ไม่เรียก AWS / Rekognition / payment gateway จริง

## สถานะแต่ละ Phase

| Phase                               | สถานะ                                                                              | commit                          |
| ----------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------- |
| 0 Face PoC                          | harness + รายงานจำลองเสร็จ ยังไม่ได้รันกับรูปงานจริง (ต้องใช้อาสาสมัครและ consent) | `22bd815`, `a438af6`            |
| 1 Foundations                       | monorepo, CDK 7 stacks, CI, shared + db                                            | `22bd815`, `22cd327`, `1c12eb2` |
| 2 Drive                             | api drive/upload, worker media/purge/quota, web /studio + Uppy                     | `d0ed8cc`                       |
| 3 Sharing + face search + downloads | ครบทุกฟีเจอร์ ปิด face search ด้วย flag                                            | `73171d0`                       |
| 3 (review fixes) + 4 Billing        | ครบ ใช้ fake gateway / fake email; มี major 2 ข้อที่ต้องแก้ก่อน sign-off           | `c5f95ee`                       |
| 5, 6, E2E                           | ไม่ทำตามที่สั่งเปลี่ยนแผน                                                          | –                               |

## Commit ที่ทำ (ทั้งหมดอยู่ในเครื่อง ยังไม่ push ยกเว้น 3 ตัวแรกที่ push ก่อนเริ่มทำข้ามคืน)

- `03edef7` chore: remove legacy prototype, add shared + face packages (pushed)
- `460a0df` docs: ADR 0001 (pushed)
- `22bd815` wave 1: infra + face-poc (pushed)
- `a438af6` face-eval: regenerate synthetic sample report (pushed)
- `22cd327` wave 2: shared contracts + packages/db, Wave 1 review fixes (pushed)
- `1c12eb2` wave 2: fix majors + contracts — **ไม่ได้ push**
- `d0ed8cc` wave 3: phase 2 drive — **ไม่ได้ push**
- `73171d0` wave 4: phase 3 sharing + face search + downloads — **ไม่ได้ push**
- `48ae915` docs: overnight report and wave 5 contract notes — **ไม่ได้ push**
- `c5f95ee` wave 5: phase 3 fixes + phase 4 billing — **ไม่ได้ push**

ทุก commit ผ่านการสแกนว่าไม่มี `.env`, key จริง, รูปภาพ หรือไฟล์ binary ข้อความ "PRIVATE KEY" ที่เจอใน `1c12eb2` เป็น fixture ปลอมใน test (ตัดสั้น ใช้ไม่ได้จริง)

## ผล reviewer ล่าสุด (wave 5, `c5f95ee`)

**GO** ทั้ง repo ผ่าน 30/30 สองรอบ (test ที่ใช้ Postgres/Redis/LocalStack จริงถูกข้ามเพราะ Docker ปิด ส่วนชุด PGlite รันครบ) ข้อ major 2 ข้อของ Phase 3 แก้แล้ว แต่ Phase 4 มี major ใหม่ 2 ข้อ ต้องแก้ก่อนถือว่า Phase 4 เสร็จและก่อนใช้ gateway จริง:

1. **ต่ออายุระหว่าง purge:** purge บัญชีที่ใหญ่ทำหลายวัน ถ้าช่างภาพจ่ายต่ออายุกลางทาง purge จะหยุด แต่ไฟล์ที่ลบไปแล้วไม่กลับมา บัญชี active จะมีไฟล์เสีย → ต้องมี `purge_started_at` (หรือสถานะ `purging`) และถือว่าบัญชีถูก purge แล้วตั้งแต่เริ่มลบ
2. **webhook มาก่อนแถว payment ของการต่ออายุอัตโนมัติ:** ถ้าการตัดบัตรเป็น pending แล้ว webhook "paid" มาถึงก่อน worker บันทึก payment ระบบจะเก็บ event ไว้แต่ไม่ apply และ gateway จะไม่ส่งซ้ำ → ตัดเงินแล้วแต่ subscription หมดอายุ ต้องให้การบันทึก payment ไปหยิบ event ที่ค้างมา apply และมี sweep ตรวจ payment ที่ pending นาน

minor: ระบบรู้ว่าเป็น production จากชื่อ stage `prod` เท่านั้น (ถ้าตั้งชื่ออื่นจะใช้ fake ได้), บัตรถูกปฏิเสธแสดงเป็น "gateway error" (ควรมี `PAYMENT_FAILED`), api ยังไม่มี `@aws-sdk/client-sesv2` (ใบเสร็จจะไปกับรอบ worker รายวันแทน)

CCR ที่ reviewer รับ: เพิ่มราคา/สถานะแพ็กเกจใน `GET /billing/subscription` (หรือให้ API บอกประเภทการเปลี่ยนแพ็กเกจเอง), เพิ่มโหมดแชร์ในข้อมูลหน้าขอลบใบหน้า, เพิ่ม `PAYMENT_FAILED`, เพิ่ม SESv2 ใน api

## งานที่ค้างใน working tree

- ไม่มีงานโค้ดค้าง (ทุกอย่าง commit แล้ว)
- `docs/reports/wave5-contracts.patch` เป็นไฟล์ช่วยตอนทำ wave 5 ลบทิ้งได้
- `.claude/skills/photo-platform/SKILL.md` มีแค่ช่องว่างท้ายบรรทัดที่ IDE ลบ

## ขั้นถัดไป (ถ้าจะทำต่อ)

1. รอบแก้ Phase 4: major 2 ข้อ + CCR 4 ข้อ + การตรวจ production ที่รัดกุมขึ้น (contracts → api/worker/web/infra → reviewer → commit)
2. ทำ adapter ของ payment gateway จริง (Omise หรือ 2C2P) และทดสอบกับ sandbox ของ gateway — ตอนนี้ production ใช้ billing ไม่ได้เพราะมีแต่ fake
3. Phase 5, 6 และ E2E (ยังไม่ทำตามที่สั่ง)

## สมมติฐานที่ตัดสินใจเอง

- **Face search ปิดด้วย flag:** สร้าง UI และ endpoint ครบตามที่สั่ง แต่ `FACE_SEARCH_ENABLED=false` เป็นค่าเริ่มต้น จนกว่า Phase 0 จะผ่านกับรูปงานจริง
- **`FACE_ORPHAN_GRACE_MS` = 3 ชม.:** ต้องอย่างน้อย 2 เท่าของเวลาแย่สุดของงาน index (3960 วินาที)
- **visibility timeout:** ใช้ heartbeat แทนการตั้งเวลายาว (faces/jobs 900 วินาที, media/zip 300 วินาที)
- **Redis:** `noeviction` + alarm 75% (ตามที่คุณตัดสิน) และตัดคำสั่งอันตราย `-@dangerous`
- **CSP ของ `/media/*`:** ปรับให้เปิด MP4 ในแท็บใหม่ได้ (ทดสอบ Chrome แล้ว Safari/Firefox ยังไม่ได้ทดสอบ)
- **ADR 0006:** ให้ทุก prefix ใน `tmp/` ไม่เกิน 3 วันตาม spec (กำหนดไว้ใน wave 5 ที่ค้าง)
- **ADR 0007:** การลบใบหน้าไม่มี liveness ใน MVP — ยอมรับความเสี่ยง ต้องให้ DPO ตรวจ วาง Face Liveness ไว้ Phase 6
- **การลบใบหน้าและถอน consent ต้องทำได้เสมอ** แม้ปิด flag หรือแชร์หมดอายุ (PDPA)
- **Uppy v5** แทน v6 เพราะ v6 เซ็น S3 เองและข้ามการจอง quota
- **web ใช้ `/bff`** เป็น proxy ใส่ token เพราะ `/api/*` ไปตรงที่ API
- **upload ซ้ำ:** ใช้ `clientUploadId` จาก client แทน header Idempotency-Key
- **webhook กันซ้ำด้วย (gateway, event_ref)** แทน (gateway, gateway_ref) เพราะการจ่ายหนึ่งครั้งมีหลาย event
- **ผมแก้ไฟล์เองบางจุด:** `pnpm-workspace.yaml` (`allowBuilds`), `apps/worker/vitest.config.ts` (timeout), `infra/cdk.json` (prettier), `docs/TODO-api.md`, `.claude/settings.json`

## ผลข้างเคียงบนเครื่องของคุณ

- infra agent เปิด Docker Desktop เพื่อรัน test กับ Redis ทำให้ container อื่นของคุณ (Postgres 2 ตัว, MinIO 1 ตัว) เปิดตามไปด้วย ภายหลัง Docker ถูกปิดไป (ไม่ใช่ผมปิด)
- contracts รัน test ของ DB บน `shotx-dev-postgres` (พอร์ต 5434) ใน DB ใหม่ที่สร้างแล้วลบเอง ไม่แตะข้อมูลเดิม
- agent ใช้ container ชั่วคราวของตัวเองแล้วลบทิ้ง ไม่แตะ container ของคุณ
- `.claude/skills/photo-platform/SKILL.md` มีแค่ช่องว่างท้ายบรรทัดที่ IDE ลบ ไม่ได้ commit

## เรื่องที่รอคุณตัดสินใจ

- ADR 0006 (หลัง wave 5) และ ADR 0007 — ให้ DPO ตรวจ
- ค่า WAF ที่เดาไว้ (ปลดล็อก 100, ดาวน์โหลด 1000 ต่อ IP ต่อ 5 นาที) ต้อง load test เพราะมือถือไทยใช้ IP ร่วมกัน (CGNAT)
- ข้อความ consent และระยะเวลาเก็บข้อมูลทั้งหมด — DPO/ฝ่ายกฎหมายต้องตรวจก่อนใช้จริง

## Checklist "ก่อนขายจริง"

### งานที่คุณต้องทำเอง

- [ ] รัน Phase 0 กับรูปงานจริง 1 งาน + อาสาสมัคร 20–30 คน (พร้อม consent ตาม PDPA, DPO ตรวจการส่งข้อมูลไป AWS สิงคโปร์) ถ้า GO ค่อยเปิด `FACE_SEARCH_ENABLED`
- [ ] ให้ DPO/ฝ่ายกฎหมายตรวจ consent text, ระยะเวลาเก็บข้อมูล, ADR 0006/0007, log ของ WAF/CloudFront ที่มี IP และ token (เก็บ 400 วัน)
- [ ] สร้างบัญชี AWS, ใส่ค่าจริงใน `infra/cdk.json` (account, โดเมน, hosted zone, public key สำหรับเซ็น URL, Google/LINE client ID, prefix ของ Cognito, อีเมล alarm, ตรวจ prefix list `pl-31a34658`)
- [ ] สร้าง secret: Google client secret, LINE channel secret, CloudFront private key
- [ ] `cdk bootstrap` ทั้ง ap-southeast-1 และ us-east-1 แล้ว deploy เอง
- [ ] ขอเพิ่ม Rekognition TPS quota ทุก operation แล้วตั้ง `FACE_REKOGNITION_TPS_*` ~80% ของ quota
- [ ] อนุมัติ CloudFront flat-rate Business plan (เริ่มเป็น PENDING_APPROVAL) และตรวจว่าแผนรองรับจำนวนกฎ WAF/WCU
- [ ] ขอ SES production access และยืนยันโดเมนผู้ส่ง
- [ ] สมัคร payment gateway จริง (Omise/2C2P) และใส่ key — ตอนนี้มีแต่ fake
- [ ] ทดสอบว่า Cognito รับ LINE ID token ได้ (ยังไม่เคยทดสอบจริง) และขอสิทธิ์อีเมลจาก LINE
- [ ] ซื้อ LocalStack แบบเสียเงิน (แผนฟรีใช้เชิงพาณิชย์ไม่ได้) หรือเลิกใช้
- [ ] โฮสต์ไฟล์โมเดล MediaPipe `blaze_face_short_range.tflite` (Apache-2.0) ที่ `FACE_DETECTOR_MODEL_PATH`
- [ ] ทดสอบเปิด MP4 ในแท็บใหม่บน Safari/iOS และ Firefox
- [ ] load test หน้าสแกนหน้าช่วงคนสแกนพร้อมกันหลังจบงาน และกฎ WAF กับ CGNAT
- [ ] ตรวจสอบเซิร์ฟเวอร์ prototype เก่า (`157.245.145.47`, ใช้ InsightFace และเก็บ selfie) ว่าปิดแล้ว และลบ selfie/embedding ที่เหลือ
- [ ] ตัดสินใจ push commit ที่ค้าง (`1c12eb2` ถึง `c5f95ee`)

### งานโค้ดที่ยังเหลือ

- [ ] รอบแก้ Phase 4: purge กับการต่ออายุชนกัน, webhook มาก่อนแถว payment, การตรวจ production จากชื่อ stage, `PAYMENT_FAILED`, SESv2 ใน api, ราคาแพ็กเกจใน subscription view, โหมดแชร์ในหน้าขอลบใบหน้า
- [ ] adapter ของ payment gateway จริง (Omise/2C2P) + ทดสอบกับ sandbox
- [ ] Phase 5 Admin: rollup dashboard, ECharts, moderation, audit log (ไม่ได้ทำตามที่สั่ง)
- [ ] Phase 6: watermark, `face_only` + Face Liveness, ขายรูปรายใบ, ใบกำกับภาษีเต็มรูป
- [ ] E2E Playwright แบบ mobile: อัปโหลด → แชร์ → consent → สแกน → ดาวน์โหลด และซื้อแพ็กเกจ
- [ ] test กับ Postgres/Redis/LocalStack จริง: หลายชุดถูกข้ามในเครื่อง (CI รัน Postgres + Redis แต่ LocalStack ยังต้องใช้ token)
- [ ] ระบบนำเข้า YuNet สำหรับหน้าเล็ก (ตอนนี้มีแค่ interface)
- [ ] CHECK ของ `files.s3_key` ให้ตรงกับ `originals/{owner_id}/{id}/`
- [ ] ปรับ `ubuntu-latest` ใน CI ให้ระบุเวอร์ชัน (กำลังย้ายเป็น Ubuntu 26)
