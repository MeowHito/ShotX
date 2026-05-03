# EventDD — Developer Handoff

> **AI-powered event photography platform**  
> Guests scan QR → take a selfie → AI finds their photos instantly

---

## Quick Overview

| | |
|---|---|
| **Product** | EventDD SaaS Platform |
| **Target Users** | Event photographers (B2B), Event guests (B2C end-users) |
| **Core Tech** | InsightFace + pgvector face recognition, LINE LIFF |
| **Prototype** | `/prototype/*.html` — open in browser, no server needed |

---

## Repository Structure

```
eventdd/
├── prototype/               ← UI reference (open in browser)
│   ├── index.html           ← Landing + Pricing page
│   ├── dashboard.html       ← Photographer dashboard
│   ├── admin.html           ← Super admin panel
│   └── guest.html           ← Guest mobile UI (LIFF-ready)
│
├── docs/
│   ├── README.md            ← This file
│   ├── PRD.md               ← Product requirements + business rules
│   ├── API_SPEC.md          ← REST API endpoints + request/response
│   ├── DATA_MODEL.md        ← Database schema (PostgreSQL + pgvector)
│   └── FLOW.md              ← User flows + system flow diagrams
│
└── assets/                  ← Logos, brand assets (TBD)
```

---

## Prototype Pages — What Each Does

| File | Role | Key Features to Note |
|---|---|---|
| `index.html` | Public landing page | Pricing tiers, feature showcase |
| `dashboard.html` | Photographer's workspace | Events, AI Queue, Watermark, Storage, Analytics, Billing |
| `admin.html` | Internal admin panel | User management, Revenue, GPU workers, System health, Logs |
| `guest.html` | Guest mobile UI | Face scan, like photos, select & download, LINE LIFF share |

> **Dark/Light mode toggle** is built into all pages (top-right button). State is saved in `localStorage` key `edd-theme`.

---

## Tech Stack

### Backend
| Layer | Technology | Notes |
|---|---|---|
| API Server | Node.js + Fastify **or** Python FastAPI | Recommend Fastify for performance |
| Database | PostgreSQL 16 | Main data store |
| Vector Search | pgvector extension | Face embedding similarity search |
| Job Queue | Redis + BullMQ | Photo processing jobs |
| AI Worker | Python + InsightFace | Separate worker service |
| File Storage | EC2 local filesystem | Original + watermarked photos |
| Cache | Redis | Session, rate limiting |

### Frontend
| Layer | Technology | Notes |
|---|---|---|
| Photographer UI | Next.js 14 (App Router) | Or use prototype HTML directly |
| Guest UI | Vanilla JS / Next.js | Must support LIFF SDK |
| LINE Integration | LIFF SDK 2.x | Guest login + ShareTargetPicker |
| Styling | Tailwind CSS | Already in prototype |

### Infrastructure
| Service | Provider | Notes |
|---|---|---|
| App Server | Railway / Render / AWS EC2 | |
| GPU Workers | Vast.ai / RunPod | On-demand, scale by queue depth |
| Storage | EC2 attached disk | Serve files from backend `/uploads` |
| CDN | Cloudflare | Photo delivery |
| DNS | Cloudflare | |

### Payments
| Item | Provider |
|---|---|
| Subscription billing | Stripe (or Omise for Thai cards) |
| PromptPay QR | Omise |

---

## Environment Variables (minimum set)

```env
# App
NODE_ENV=production
APP_URL=https://eventdd.app
PORT=3000
JWT_SECRET=...

# Database
DATABASE_URL=postgresql://user:pass@host:5432/eventdd

# Redis
REDIS_URL=redis://host:6379

# Storage
STORAGE_DIR=/var/www/shotx/uploads
STORAGE_PUBLIC_URL=https://api.eventdd.app/uploads

# AI Worker
WORKER_API_URL=http://worker:8000
INSIGHTFACE_MODEL=buffalo_l

# LINE LIFF
LIFF_ID=...
LINE_CHANNEL_ACCESS_TOKEN=...

# Stripe
STRIPE_SECRET_KEY=...
STRIPE_WEBHOOK_SECRET=...
```

---

## Read First

1. [`PRD.md`](./PRD.md) — Start here to understand the product & business rules
2. [`DATA_MODEL.md`](./DATA_MODEL.md) — Database schema before writing any code
3. [`API_SPEC.md`](./API_SPEC.md) — API contracts
4. [`FLOW.md`](./FLOW.md) — System flows & sequences

---

## Contact

| Role | Contact |
|---|---|
| Product Owner | (ใส่ชื่อ/อีเมล) |
| Design Reference | ไฟล์ HTML ใน `/prototype/` |
