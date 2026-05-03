'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/Shell';
import { API_URL } from '@/lib/api';
import { authFetch, getToken, useMe } from '@/lib/auth';

type FolderRow = {
  id: string;
  name: string;
  slug: string;
  photoCount: number;
  status: string;
  expiresAt: string;
  createdAt: string;
};

type Subscription = {
  plan: string;
  plan_name: string;
  current_period_end: string;
  limits: { storage_gb: number; max_folders: number; max_photos_per_folder: number; ai_quota: number };
};

export default function DashboardPage() {
  const router = useRouter();
  const { me, loading: meLoading } = useMe();
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [subLoaded, setSubLoaded] = useState(false);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  const [name, setName] = useState('');
  const [venue, setVenue] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!meLoading && !me) router.replace('/login');
  }, [me, meLoading, router]);

  useEffect(() => {
    if (!me) return;
    authFetch<Subscription | null>('/billing/subscription')
      .then((s) => setSubscription(s))
      .catch(() => undefined)
      .finally(() => setSubLoaded(true));
  }, [me]);

  useEffect(() => {
    if (!subLoaded) return;
    if (!subscription) {
      router.replace('/pricing');
    }
  }, [subscription, subLoaded, router]);

  async function refresh() {
    try {
      const list = await authFetch<FolderRow[]>('/events');
      setFolders(list);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => { if (subscription) refresh(); }, [subscription]);

  async function createFolder(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await authFetch('/events', {
        method: 'POST',
        body: JSON.stringify({ name, venue: venue || undefined, event_date: eventDate || undefined }),
      });
      setName(''); setVenue(''); setEventDate('');
      refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function upload(folderId: string, files: FileList | null) {
    if (!files?.length) return;
    const token = getToken();
    if (!token) { router.replace('/login'); return; }
    setActiveId(folderId);
    setStatus(`กำลังอัปโหลด ${files.length} รูป…`);
    const form = new FormData();
    Array.from(files).forEach((file) => form.append('files', file));
    try {
      const res = await fetch(`${API_URL}/events/${folderId}/photos`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const text = await res.text();
      setStatus(res.ok ? `อัปโหลดสำเร็จ` : `ผิดพลาด: ${text}`);
      refresh();
    } catch (err) {
      setStatus(`ผิดพลาด: ${(err as Error).message}`);
    }
  }

  function shareUrl(slug: string) {
    if (typeof window === 'undefined') return '';
    return `${window.location.origin}/guest?slug=${encodeURIComponent(slug)}`;
  }

  async function copyLink(slug: string) {
    const url = shareUrl(slug);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(slug);
      setTimeout(() => setCopied(null), 1500);
    } catch {}
  }

  if (meLoading || !me || !subLoaded) {
    return <Shell><p className="text-violet-100/60">กำลังโหลด…</p></Shell>;
  }

  if (!subscription) {
    return <Shell><p className="text-violet-100/60">กำลังพาไปหน้าเลือกแพคเกจ…</p></Shell>;
  }

  return (
    <Shell>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black">โฟลเดอร์ของฉัน</h1>
          <p className="mt-1 text-sm text-violet-100/60">{me.name} · แพคเกจ {subscription.plan_name} · {folders.length}/{subscription.limits.max_folders} โฟลเดอร์</p>
        </div>
        <a href="/pricing" className="rounded-full border border-violet-400/30 px-4 py-2 text-sm hover:bg-violet-500/10">เปลี่ยนแพคเกจ</a>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_2fr]">
        <div className="card p-5 h-fit">
          <h2 className="mb-4 text-lg font-bold">+ สร้างโฟลเดอร์ใหม่</h2>
          <form onSubmit={createFolder} className="grid gap-3">
            <input className="rounded-xl border-violet-500/20 bg-white/5" placeholder="ชื่อโฟลเดอร์ (เช่น งานแต่งคู่ A&B)" value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
            <input className="rounded-xl border-violet-500/20 bg-white/5" placeholder="สถานที่ (ไม่บังคับ)" value={venue} onChange={(e) => setVenue(e.target.value)} maxLength={200} />
            <input className="rounded-xl border-violet-500/20 bg-white/5" type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
            <button className="btn-primary py-2">สร้างโฟลเดอร์</button>
          </form>
          {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
        </div>

        <div className="card p-5">
          <h2 className="mb-4 text-lg font-bold">📁 โฟลเดอร์ทั้งหมด</h2>
          {folders.length === 0 ? (
            <p className="text-sm text-violet-100/50">ยังไม่มีโฟลเดอร์ — สร้างโฟลเดอร์แรกของคุณเลย</p>
          ) : (
            <div className="grid gap-3">
              {folders.map((ev) => (
                <div key={ev.id} className="rounded-xl border border-violet-500/15 bg-white/[0.03] p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2 font-bold">
                        <span>📁</span>{ev.name}
                      </div>
                      <div className="text-xs text-violet-100/50">รูป: {ev.photoCount} · slug: {ev.slug}</div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        className="rounded-full border border-violet-400/30 px-3 py-1 text-xs hover:bg-violet-500/10"
                        onClick={() => copyLink(ev.slug)}
                      >
                        {copied === ev.slug ? '✓ คัดลอกแล้ว' : '🔗 คัดลอกลิงก์ลูกค้า'}
                      </button>
                      <label className="cursor-pointer rounded-full bg-violet-600 px-3 py-1 text-xs text-white hover:bg-violet-500">
                        ⬆ อัปโหลดรูป
                        <input
                          hidden type="file" accept="image/*" multiple
                          onChange={(e) => upload(ev.id, e.target.files)}
                        />
                      </label>
                    </div>
                  </div>
                  {activeId === ev.id && status && (
                    <pre className="mt-3 overflow-auto rounded-xl bg-black/30 p-3 text-xs text-violet-100/70">{status}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Shell>
  );
}
