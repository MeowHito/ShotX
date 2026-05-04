# ShotX — คู่มือ Deploy บน DigitalOcean (ฉบับละเอียด)

> **โครงสร้างโปรเจค:** monorepo เดียว มี `frontend/`, `backend/`, `worker/` รวมกัน  
> **Stack:** Next.js 15 · NestJS · Python FastAPI · PostgreSQL+pgvector · Redis · EC2 local storage · Caddy (auto HTTPS)

---

## ภาพรวมขั้นตอน

```
[PC ของคุณ]          [GitHub]           [DigitalOcean Droplet]
   โค้ด  ──git push──▶  repo  ──git clone──▶  /opt/shotx
                                               docker compose up
                                               Caddy (HTTPS)
                                                  ↓
                                           shotx.yourdomain.com
```

---

## ขั้นที่ 1 — เตรียม GitHub Repository

### 1.1 สร้าง repo ใหม่บน GitHub

1. เปิด https://github.com/new
2. ตั้งชื่อ: `shotx`
3. เลือก **Private** (แนะนำ)
4. **อย่า** tick "Add README" หรือ `.gitignore` (เรามีอยู่แล้ว)
5. คลิก **Create repository**

### 1.2 Push โค้ดขึ้น GitHub (รันบน Windows)

เปิด **PowerShell** หรือ **Git Bash** ใน folder โปรเจค:

```powershell
cd D:\Work\Website\ShotX

# ครั้งแรก — init git (ถ้ายังไม่เคย)
git init
git add .
git commit -m "chore: initial production setup"

# เชื่อมกับ GitHub
git remote add origin https://github.com/MeowHito/ShotX.git
git branch -M master
git push -u origin master
```

> ⚠️ **ตรวจก่อน push:** ไฟล์ `.env.production` ต้องไม่อยู่ใน git  
> รัน `git status` แล้วดูว่าไม่มี `.env.production` ติดมาด้วย

### 1.3 อัปเดตครั้งถัดไป

```powershell
cd D:\Work\Website\ShotX
git add .
git commit -m "fix: แก้ bug XYZ"
git push
```
แล้วไป SSH บน Droplet รัน `bash /opt/shotx/deploy.sh` เพื่ออัปเดต

---

## ขั้นที่ 2 — สร้าง DigitalOcean Droplet

### 2.1 สมัคร / Login

ไปที่ https://cloud.digitalocean.com

### 2.2 สร้าง Droplet

1. คลิก **Create** → **Droplets**
2. เลือก settings ตามนี้:

| ตัวเลือก | ค่าที่แนะนำ |
|----------|------------|
| **Region** | Singapore (sgp1) — ใกล้ไทยที่สุด |
| **OS** | Ubuntu **24.04 LTS** x64 |
| **Plan** | Basic — Shared CPU |
| **Size** | **Regular $12/mo** (2 vCPU, 2 GB RAM, 50 GB SSD) |
| **Backups** | เปิด (เพิ่ม 20% = $2.4/mo) — แนะนำ |
| **SSH Key** | ดูขั้นตอน 2.3 |
| **Hostname** | shotx-prod |

> 💡 ถ้ามีผู้ใช้งานเยอะหรือรูปเยอะ อัพเป็น **$24/mo (4GB RAM)**

### 2.3 สร้าง SSH Key (ครั้งแรกเท่านั้น)

รันบน **Windows PowerShell**:

```powershell
# สร้าง key pair
ssh-keygen -t ed25519 -C "shotx-droplet" -f "$env:USERPROFILE\.ssh\shotx_do"
# กด Enter 2 ครั้ง (ไม่ต้องใส่ passphrase)

# ดู public key เพื่อ copy
Get-Content "$env:USERPROFILE\.ssh\shotx_do.pub"
```

คัดลอก output ทั้งบรรทัด (ขึ้นต้นด้วย `ssh-ed25519 ...`)

กลับที่ DigitalOcean → คลิก **New SSH Key** → วาง public key → บันทึก

### 2.4 สร้าง Droplet และ SSH เข้าครั้งแรก

หลัง Droplet สร้างเสร็จ จะได้ **IP address** เช่น `167.99.123.45`

```powershell
# SSH เข้า (Windows PowerShell)
ssh -i "$env:USERPROFILE\.ssh\shotx_do" root@157.245.145.47
```

---

## ขั้นที่ 3 — ชี้ Domain ไปที่ Droplet

> ถ้ายังไม่มี domain ข้ามขั้นนี้ได้ และใช้ IP ตรงๆ (ดูหมายเหตุในขั้นที่ 5.3)

ไปที่ DNS provider ของ domain คุณ (Cloudflare, Namecheap, ฯลฯ) เพิ่ม A Record:

| Name | Type | Value | TTL |
|------|------|-------|-----|
| `shotx` | A | `167.99.123.45` | Auto |
| `api.shotx` | A | `167.99.123.45` | Auto |

รอ DNS propagate 5–30 นาที ตรวจด้วย:
```bash
nslookup shotx.yourdomain.com
```

---

## ขั้นที่ 4 — ติดตั้ง Docker บน Droplet

รันบน **Droplet** (หลัง SSH เข้าแล้ว):

```bash
# อัปเดต package list
apt-get update && apt-get upgrade -y

# ติดตั้ง Docker (official script)
curl -fsSL https://get.docker.com | sh

# ตรวจสอบ
docker --version
docker compose version
```

ผลที่ถูกต้องจะเห็น:
```
Docker version 27.x.x, build ...
Docker Compose version v2.x.x
```

---

## ขั้นที่ 5 — Clone โปรเจคและตั้งค่า

> ใช้ repo เดียวแบบโฟลเดอร์ `ShotX` ปัจจุบันดีที่สุด ไม่ต้องแยก repo เพราะ Docker Compose และ Dockerfile ตอนนี้ออกแบบให้ build จาก root เดียวที่มี `frontend/`, `backend/`, `worker/` อยู่ด้วยกัน

### 5.1 Clone repo เดียวทั้งโปรเจค

```bash
# รันบน Droplet
git clone https://github.com/MeowHito/ShotX.git /opt/shotx
cd /opt/shotx
```

> ถ้า repo เป็น Private จะถามรหัส → ใส่ GitHub username + Personal Access Token  
> สร้าง token ได้ที่: GitHub → Settings → Developer settings → Personal access tokens → Generate new token (scope: repo)

หลัง clone แล้วโครงสร้างบน Droplet ต้องเป็นแบบนี้:

```text
/opt/shotx/
  frontend/
  backend/
  worker/
  ...
```

### 5.2 สร้างและแก้ไข .env.production

```bash
cd /opt/shotx
cp .env.production.example .env.production
nano .env.production
```

แก้ค่าเหล่านี้:

```env
# ── URLs (ใส่ domain จริง) ──────────────────────────────────
APP_URL=https://shotx.yourdomain.com
NEXT_PUBLIC_API_URL=https://api.shotx.yourdomain.com

# ── Postgres password (ตั้งเองได้เลย ห้ามใส่ช่องว่าง) ───────
POSTGRES_PASSWORD=MyStr0ng!P@ssw0rd2025

# ── JWT Secret (generate ด้วย openssl) ─────────────────────
# รัน:  openssl rand -hex 64
# หรือรันบน Windows: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# แล้ว copy ผลลัพธ์มาใส่ตรงนี้
JWT_SECRET=ใส่ผลจาก_openssl_rand_hex_64

# ── Storage (เก็บไฟล์บนเครื่อง server) ─────────────────────
STORAGE_DIR=/var/www/shotx/uploads
STORAGE_PUBLIC_URL=https://api.shotx.yourdomain.com/uploads
```

กด `Ctrl+X` → `Y` → `Enter` เพื่อบันทึก

**Generate JWT_SECRET:**
```bash
openssl rand -hex 64
# copy output ไปใส่ใน .env.production
```

ถ้ารันบน Windows แล้วไม่มี `openssl` ให้ใช้ Node.js แทน:

```powershell
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

### 5.3 ตั้งค่า Caddyfile

```bash
nano /opt/shotx/Caddyfile
```

ตอนยังไม่มี domain ให้ใช้ IP mode แบบนี้:

```caddyfile
:80 {
    handle /api/* {
        reverse_proxy backend:4000
    }

    handle /uploads/* {
        reverse_proxy backend:4000
    }

    handle {
        reverse_proxy frontend:3000
    }
}
```

ถ้ามี domain แล้วค่อยเปลี่ยนเป็นแบบนี้:

```caddyfile
shotx.yourdomain.com {
    handle {
        reverse_proxy frontend:3000
    }
}

api.shotx.yourdomain.com {
    handle {
        reverse_proxy backend:4000
    }
}
```

และแก้ `.env.production`:
```env
APP_URL=http://167.99.123.45
NEXT_PUBLIC_API_URL=http://167.99.123.45/api/v1
```

> ⚠️ โหมด IP ไม่มี HTTPS — ใช้ทดสอบเท่านั้น ห้าม production จริง

---

## ขั้นที่ 6 — Deploy!

```bash
cd /opt/shotx

# ให้ script รันได้
chmod +x deploy.sh

# Deploy หลังจาก clone repo แล้ว
bash deploy.sh
```

> ไม่ต้อง `export REPO_URL` ถ้าคุณ clone repo ไว้ที่ `/opt/shotx` แล้ว  
> `REPO_URL` ใช้เฉพาะกรณีเรียก `deploy.sh` จากที่อื่นแล้วต้องการให้ script clone โปรเจคให้เอง

Script จะทำให้เองทั้งหมด:
1. ✓ ตรวจสอบ Docker
2. ✓ Pull โค้ดล่าสุดจาก GitHub
3. ✓ ตรวจ .env.production
4. ✓ Build Docker images (~10–15 นาทีครั้งแรก)
5. ✓ Start ทุก services
6. ✓ Health check

ดู progress:
```bash
# อีก terminal หนึ่ง
docker compose -f /opt/shotx/docker-compose.production.yml logs -f
```

---

## ขั้นที่ 7 — อัปเดต Google OAuth

ไปที่ https://console.cloud.google.com/apis/credentials

เปิด **OAuth 2.0 Client ID** ของโปรเจค → แก้:

**Authorized JavaScript origins** เพิ่ม:
```
    https://shotx.yourdomain.com
```

**Authorized redirect URIs** เพิ่ม:
```
https://shotx.yourdomain.com/auth/callback
```

คลิก **Save**

---

## ขั้นที่ 8 — ตรวจสอบว่าทุกอย่างทำงาน

```bash
# ทุก container ควร Up (ไม่มี Exit)
docker compose -f /opt/shotx/docker-compose.production.yml ps

# ทดสอบ API
curl https://api.shotx.yourdomain.com/api/v1/health

# ทดสอบ frontend
curl -I https://shotx.yourdomain.com
```

เปิดเบราว์เซอร์ไปที่ `https://shotx.yourdomain.com` — เว็บควรขึ้น 🎉

---
ถึงนี้ละ ------------------------------------------------------------------------------------------------------------------------------------
---

## คำสั่งที่ใช้บ่อยบน Droplet

```bash
# Alias สั้น (optional — เพิ่มใน ~/.bashrc)
alias dc='docker compose -f /opt/shotx/docker-compose.production.yml'

# ── ดู logs ────────────────────────────────────────────────
dc logs -f                        # ทุก service
dc logs backend -f --tail 100    # เฉพาะ backend
dc logs frontend -f --tail 100   # เฉพาะ frontend
dc logs worker -f --tail 100     # เฉพาะ AI worker

# ── ดู status ──────────────────────────────────────────────
dc ps                             # สถานะทุก container

# ── Restart ────────────────────────────────────────────────
dc restart backend
dc restart frontend
dc restart worker

# ── หยุด / เริ่ม ───────────────────────────────────────────
dc down                           # หยุดทั้งหมด
dc up -d                          # เริ่มใหม่ทั้งหมด

# ── อัปเดตโค้ดใหม่ (หลัง git push จาก PC) ─────────────────
bash /opt/shotx/deploy.sh

# ── เข้า psql ดู database ───────────────────────────────────
dc exec postgres psql -U shotx -d shotx

# ── ดูพื้นที่ disk ──────────────────────────────────────────
df -h
docker system df

# ── ลบ image เก่า (ประหยัด disk) ────────────────────────────
docker image prune -f
```

---

## แก้ปัญหาที่พบบ่อย

### Backend ไม่ขึ้น (container Exit)
```bash
dc logs backend --tail 50
```
สาเหตุที่พบบ่อย:
- `.env.production` ขาดค่า → เช็ค `POSTGRES_PASSWORD`, `JWT_SECRET`
- Postgres ยังไม่พร้อม → รอสัก 15 วินาทีแล้ว `dc restart backend`
- Port ชน → `dc ps` ดูว่า postgres ขึ้นหรือเปล่า

### Deploy แล้วขึ้น `fatal: couldn't find remote ref main`
แปลว่า `deploy.sh` บน Droplet ยังเป็นเวอร์ชันเก่าที่พยายามดึง branch `main` แต่ repo นี้ใช้ branch `master`

```bash
cd /opt/shotx
git fetch origin master
git reset --hard origin/master
BRANCH=master bash deploy.sh
```

ตรวจสอบเพิ่มเติมได้ด้วย:

```bash
git branch -a
grep -n 'BRANCH=' deploy.sh
git remote -v
```

### Worker build แล้วขึ้น `error: command 'g++' failed`
แปลว่า Docker image ของ worker ยังไม่มี build tools สำหรับ compile `insightface` ให้ pull โค้ดล่าสุดแล้ว build ใหม่:

```bash
cd /opt/shotx
git fetch origin master
git reset --hard origin/master
BRANCH=master bash deploy.sh
```

### Caddy แสดง "certificate not found"
- DNS ยังไม่ propagate → รอ 5–30 นาที
- ตรวจ: `nslookup shotx.yourdomain.com` ต้องได้ IP ของ Droplet
- ดู Caddy log: `dc logs caddy --tail 30`

### Frontend แสดง 502 Bad Gateway
- Next.js ยังอยู่ระหว่าง start → รอ 1-2 นาที
- `dc logs frontend --tail 30`

### Google Login ไม่ทำงาน
- ตรวจว่าเพิ่ม redirect URI ใน Google Console แล้วหรือยัง
- URI ต้องตรงทุกตัวอักษร รวม `/auth/callback` ท้าย

### Upload รูปแล้ว error
- ตรวจ `STORAGE_DIR` และ permission ของโฟลเดอร์ upload
- `dc logs backend --tail 50` หา error เกี่ยวกับการเขียนไฟล์หรือ path

### Disk เต็ม
```bash
df -h                            # ดูพื้นที่
docker system prune -f           # ลบ image/container ที่ไม่ได้ใช้
```

---

## Workflow อัปเดตโค้ด (ทุกครั้ง)

```
1. แก้โค้ดบน PC
         ↓
2. git add . && git commit -m "fix: ..." && git push
         ↓
3. SSH เข้า Droplet
         ↓
4. bash /opt/shotx/deploy.sh
         ↓
5. รอ build + health check
         ↓
   เว็บอัปเดตแล้ว ✓
```

---

## ค่าใช้จ่าย (DigitalOcean)

| รายการ | ราคา/เดือน |
|--------|-----------|
| Droplet $12 (2GB RAM) | $12 |
| Backup (20%) | $2.40 |
| **รวม** | **~$14.40 (~฿520)** |
