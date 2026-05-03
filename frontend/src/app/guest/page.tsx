'use client';

import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Shell } from '@/components/Shell';
import { API_URL } from '@/lib/api';

type SearchResponse = {
  matched_count: number;
  latency_ms: number;
  threshold: number;
  photos: { id: string; thumbnailUrl: string; fileUrl: string; similarity: number }[];
};

export default function GuestPage() {
  return (
    <Suspense fallback={<Shell><p className="text-violet-100/60">กำลังโหลด…</p></Shell>}>
      <GuestPageContent />
    </Suspense>
  );
}

function GuestPageContent() {
  const params = useSearchParams();
  const [slug, setSlug] = useState('');
  const [eventName, setEventName] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const s = params.get('slug') ?? '';
    setSlug(s);
  }, [params]);

  useEffect(() => {
    if (!slug) return;
    fetch(`${API_URL}/guest/events/${encodeURIComponent(slug)}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text());
        return r.json();
      })
      .then((d: { name: string }) => setEventName(d.name))
      .catch(() => setEventName(null));
  }, [slug]);

  async function search(file?: File) {
    if (!file || !slug) return;
    setError(null);
    setLoading(true);
    setResult(null);
    try {
      const form = new FormData();
      form.append('selfie', file);
      form.append('session_id', crypto.randomUUID());
      const res = await fetch(`${API_URL}/guest/events/${encodeURIComponent(slug)}/search`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      setResult(await res.json());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Shell>
      <div className="mx-auto max-w-2xl">
        <div className="card p-6 text-center">
          <div className="mx-auto mb-5 flex h-32 w-32 items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-400/10 text-5xl">🤳</div>
          <h1 className="text-2xl font-black">ค้นหารูปของคุณ</h1>
          {eventName ? (
            <p className="mt-2 text-sm text-violet-100/70">งาน: <span className="font-bold">{eventName}</span></p>
          ) : (
            <p className="mt-2 text-sm text-violet-100/60">กรอก slug งานหรือเปิดลิงก์ที่ช่างภาพส่งให้</p>
          )}
          <input
            className="mt-4 w-full rounded-xl border-violet-500/20 bg-white/5"
            placeholder="event slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
          <input
            ref={inputRef}
            hidden
            type="file"
            accept="image/*"
            capture="user"
            onChange={(e) => search(e.target.files?.[0])}
          />
          <button
            className="btn-primary mt-5 w-full px-5 py-3"
            onClick={() => inputRef.current?.click()}
            disabled={!slug || loading}
          >
            {loading ? 'กำลังค้นหา…' : 'เปิดกล้อง / เลือก Selfie'}
          </button>
          <p className="mt-3 text-xs text-violet-100/50">รูป selfie จะถูกใช้สำหรับการค้นหาเท่านั้น และจะถูกลบหลังประมวลผลเสร็จ</p>
          {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
        </div>

        {result && (
          <div className="card mt-6 p-6">
            <h2 className="text-lg font-bold">พบ {result.matched_count} รูป (ใช้เวลา {result.latency_ms} ms)</h2>
            {result.photos.length === 0 ? (
              <p className="mt-3 text-sm text-violet-100/60">ไม่พบรูปที่ตรงกับใบหน้าของคุณ ลองถ่าย selfie ใหม่อีกครั้ง</p>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
                {result.photos.map((p) => (
                  <div key={p.id} className="group relative overflow-hidden rounded-xl">
                    <img src={p.thumbnailUrl} alt="match" loading="lazy" decoding="async" className="h-40 w-full object-cover transition group-hover:scale-105" />
                    <span className="absolute bottom-1 right-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] text-white">
                      {(p.similarity * 100).toFixed(0)}%
                    </span>
                    <a
                      href={`${API_URL}/guest/events/${encodeURIComponent(slug)}/photos/${p.id}/download`}
                      className="absolute inset-x-0 bottom-0 hidden bg-violet-600/90 py-1 text-center text-xs text-white group-hover:block"
                    >ดาวน์โหลด</a>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}
