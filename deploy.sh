#!/usr/bin/env bash
# ============================================================
#  ShotX — Deploy / Update Script
#
#  โปรเจคนี้เป็น monorepo:
#    shotx/
#      frontend/    Next.js
#      backend/     NestJS
#      worker/      Python AI
#      infra/
#      Caddyfile
#      docker-compose.production.yml
#
#  ── ใช้งาน ──────────────────────────────────────────────
#
#  ครั้งแรก (clone + ตั้งค่า):
#    export REPO_URL=https://github.com/YOUR_USER/shotx.git
#    bash deploy.sh
#
#  ถ้าใช้ repo แยก ให้เตรียม /opt/shotx ให้มี frontend/ backend/ worker/
#  และไฟล์ deploy ที่ root ก่อน แล้วรัน bash /opt/shotx/deploy.sh
#
#  ครั้งถัดไป (อัปเดตโค้ด):
#    bash /opt/shotx/deploy.sh
#
# ============================================================
set -euo pipefail

# ── ตัวแปร ──────────────────────────────────────────────────
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"
APP_DIR="/opt/shotx"
ENV_FILE="$APP_DIR/.env.production"
LOG_FILE="/var/log/shotx-deploy.log"

# --env-file ทำให้ ${VAR} ใน docker-compose.production.yml ถูกแทนค่าจาก .env.production อัตโนมัติ
COMPOSE="docker compose --env-file $ENV_FILE -f $APP_DIR/docker-compose.production.yml"

# ── สีสำหรับ output ─────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log()  { echo -e "${GREEN}[✓]${NC} $*" | tee -a "$LOG_FILE"; }
warn() { echo -e "${YELLOW}[!]${NC} $*" | tee -a "$LOG_FILE"; }
err()  { echo -e "${RED}[✗]${NC} $*" | tee -a "$LOG_FILE"; exit 1; }

echo ""
echo "══════════════════════════════════════════════"
echo "  ShotX Deploy  ·  $(date '+%Y-%m-%d %H:%M:%S')"
echo "══════════════════════════════════════════════"
echo ""

# ════════════════════════════════════════════════
# STEP 1 — ตรวจสอบ Docker
# ════════════════════════════════════════════════
log "Step 1/6 · ตรวจสอบ Docker..."

if ! command -v docker &>/dev/null; then
  warn "Docker ยังไม่ได้ติดตั้ง → กำลังติดตั้งอัตโนมัติ..."
  curl -fsSL https://get.docker.com | sh
  log "ติดตั้ง Docker เรียบร้อย"
fi

if ! docker compose version &>/dev/null; then
  err "ไม่พบ docker compose plugin\nแก้ด้วย: apt-get install -y docker-compose-plugin"
fi

log "$(docker --version)"
log "$(docker compose version)"

# ════════════════════════════════════════════════
# STEP 2 — Clone หรือ Pull monorepo
#   ค่าเริ่มต้นรองรับ repo เดียวที่มี frontend/ backend/ worker/ รวมกัน
#   ถ้าใช้ repo แยก ให้ pull แต่ละ repo เองก่อน แล้วรัน script นี้
# ════════════════════════════════════════════════
log "Step 2/6 · ดึงโค้ด (frontend + backend + worker)..."

if [ -d "$APP_DIR/.git" ]; then
  # มี repo อยู่แล้ว → pull อัปเดต
  git -C "$APP_DIR" fetch origin "$BRANCH"
  LOCAL=$(git -C "$APP_DIR" rev-parse HEAD)
  REMOTE=$(git -C "$APP_DIR" rev-parse "origin/$BRANCH")

  if [ "$LOCAL" = "$REMOTE" ]; then
    warn "โค้ดเป็นเวอร์ชันล่าสุดแล้ว (${LOCAL:0:8}) — rebuild ต่อ"
  else
    git -C "$APP_DIR" reset --hard "origin/$BRANCH"
    log "อัปเดตโค้ดสำเร็จ: ${LOCAL:0:8} → ${REMOTE:0:8}"
    log "  - frontend/  (Next.js)"
    log "  - backend/   (NestJS)"
    log "  - worker/    (Python AI)"
  fi
else
  if [ -d "$APP_DIR/frontend/.git" ] && [ -d "$APP_DIR/backend/.git" ] && [ -d "$APP_DIR/worker/.git" ]; then
    log "พบ repo แยกใน /opt/shotx — pull ทีละส่วน"
    for PART in frontend backend worker; do
      git -C "$APP_DIR/$PART" fetch origin "$BRANCH"
      git -C "$APP_DIR/$PART" reset --hard "origin/$BRANCH"
      log "  - $PART อัปเดตแล้ว"
    done
  else
    # ยังไม่มี → clone ครั้งแรก
    [ -z "$REPO_URL" ] && \
      err "ยังไม่มีโปรเจค และไม่ได้ตั้ง REPO_URL\nตั้งด้วย: export REPO_URL=https://github.com/YOUR_USER/shotx.git\nหรือ clone repo แยกไว้ที่ $APP_DIR/frontend, $APP_DIR/backend, $APP_DIR/worker"

    log "กำลัง clone $REPO_URL → $APP_DIR"
    git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
    log "Clone สำเร็จ — พบ:"
    ls "$APP_DIR" | grep -E "^(frontend|backend|worker|infra|Caddyfile|docker-compose)" | while read f; do
      log "  $f"
    done
  fi
fi

cd "$APP_DIR"

# ════════════════════════════════════════════════
# STEP 3 — ตรวจสอบ .env.production
# ════════════════════════════════════════════════
log "Step 3/6 · ตรวจสอบ .env.production..."

if [ ! -f "$ENV_FILE" ]; then
  err ".env.production ไม่พบ!\n\nทำก่อน deploy:\n  cp $APP_DIR/.env.production.example $ENV_FILE\n  nano $ENV_FILE"
fi

# ตรวจว่าค่าสำคัญถูกตั้งแล้ว
REQUIRED=(POSTGRES_PASSWORD JWT_SECRET APP_URL NEXT_PUBLIC_API_URL STORAGE_DIR STORAGE_PUBLIC_URL)
BAD=()
for VAR in "${REQUIRED[@]}"; do
  VAL=$(grep -E "^${VAR}=" "$ENV_FILE" | cut -d= -f2- | sed 's/[[:space:]#].*//')
  if [ -z "$VAL" ] || echo "$VAL" | grep -qiE "CHANGE|replace_with|yourdomain"; then
    BAD+=("$VAR")
  fi
done

if [ ${#BAD[@]} -gt 0 ]; then
  err "ค่าต่อไปนี้ใน .env.production ยังไม่ได้ตั้ง:\n  $(printf '  %s\n' "${BAD[@]}")\n\nแก้ด้วย: nano $ENV_FILE"
fi

log ".env.production ผ่านการตรวจสอบ ✓"

# ════════════════════════════════════════════════
# STEP 4 — Build Docker images ทั้ง 3 services
#   --env-file .env.production ทำให้ compose อ่าน
#   ${POSTGRES_PASSWORD}, ${NEXT_PUBLIC_API_URL} ฯลฯ
#   โดยอัตโนมัติ ไม่ต้อง export manual
# ════════════════════════════════════════════════
log "Step 4/6 · Build Docker images..."
log "  context = repo root (.) — ครอบคลุม frontend/ + backend/ + worker/"
log "  (ครั้งแรกอาจใช้เวลา 10–15 นาที)"

$COMPOSE build --parallel 2>&1 | tee -a "$LOG_FILE"
log "Build ทั้ง 3 services เสร็จสิ้น ✓"

# ════════════════════════════════════════════════
# STEP 5 — Start / Restart services
# ════════════════════════════════════════════════
log "Step 5/6 · เริ่ม services..."

$COMPOSE up -d --remove-orphans

log "Services ที่ทำงานอยู่:"
$COMPOSE ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || $COMPOSE ps

# ════════════════════════════════════════════════
# STEP 6 — Health check
# ════════════════════════════════════════════════
log "Step 6/6 · Health check..."

BACKEND_OK=false
for i in $(seq 1 20); do
  if curl -sf "http://localhost:4000/api/v1/health" >/dev/null 2>&1; then
    BACKEND_OK=true
    break
  fi
  printf "  รอ backend... (%d/20)\r" "$i"
  sleep 3
done
echo ""

if $BACKEND_OK; then
  log "Backend พร้อมใช้งาน ✓"
else
  warn "Backend ยังไม่ตอบสนองหลัง 60 วินาที"
  warn "ดู log เพิ่มเติม: $COMPOSE logs backend --tail 50"
fi

# ── สรุปผล ──────────────────────────────────────────────────
FRONTEND_URL=$(grep -E "^APP_URL=" "$ENV_FILE" | cut -d= -f2- | sed 's/[[:space:]#].*//')
API_URL=$(grep -E "^NEXT_PUBLIC_API_URL=" "$ENV_FILE" | cut -d= -f2- | sed 's/[[:space:]#].*//')

echo ""
echo "══════════════════════════════════════════════"
echo "  ✅  Deploy เสร็จสิ้น!"
echo ""
echo "  🌐  Frontend  : $FRONTEND_URL"
echo "  🔌  API       : $API_URL"
echo ""
echo "  คำสั่งที่ใช้บ่อย:"
echo "  ├─ ดู log ทั้งหมด    : $COMPOSE logs -f"
echo "  ├─ ดู log backend   : $COMPOSE logs backend -f"
echo "  ├─ ดู log frontend  : $COMPOSE logs frontend -f"
echo "  ├─ ดู log worker    : $COMPOSE logs worker -f"
echo "  ├─ Restart backend  : $COMPOSE restart backend"
echo "  ├─ ดู container     : $COMPOSE ps"
echo "  └─ หยุดทั้งหมด       : $COMPOSE down"
echo "══════════════════════════════════════════════"
echo ""
