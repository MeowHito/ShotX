'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/Shell';
import { authFetch, useMe } from '@/lib/auth';

type Plan = {
  key: 'basic' | 'standard' | 'pro';
  name: string;
  priceThb: number;
  periodDays: number;
  storageGb: number;
  maxFolders: number;
  maxPhotosPerFolder: number;
  features: string[];
};

type Subscription = {
  plan: string;
  plan_name: string;
  current_period_end: string;
};

export default function PricingPage() {
  const router = useRouter();
  const { me, loading: meLoading } = useMe();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [current, setCurrent] = useState<Subscription | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api/v1'}/billing/plans`)
      .then((r) => r.json())
      .then((data: Plan[]) => setPlans(data))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!me) return;
    authFetch<Subscription | null>('/billing/subscription')
      .then((s) => setCurrent(s))
      .catch(() => undefined);
  }, [me]);

  async function buy(plan: string) {
    if (!me) {
      router.push('/login');
      return;
    }
    setError(null);
    router.push(`/checkout?plan=${encodeURIComponent(plan)}`);
  }

  if (meLoading) return <Shell><p className="text-violet-100/60">กำลังโหลด…</p></Shell>;

  return (
    <Shell>
      <div className="text-center">
        <h1 className="text-4xl font-black md:text-5xl">เลือกแพคเกจที่เหมาะกับคุณ</h1>
        <p className="mt-3 text-violet-100/60">สำหรับช่างภาพอีเวนต์ที่ต้องการแชร์ลิงก์ + AI face search ให้ลูกค้า</p>
        {current && (
          <p className="mt-4 inline-block rounded-full border border-emerald-400/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
            แพคเกจปัจจุบัน: <span className="font-bold">{current.plan_name}</span> — สิ้นสุด {new Date(current.current_period_end).toLocaleDateString('th-TH')}
          </p>
        )}
      </div>

      <div className="mt-10 grid gap-5 md:grid-cols-3">
        {plans.map((p) => {
          const isCurrent = current?.plan === p.key;
          const highlight = p.key === 'standard';
          return (
            <div
              key={p.key}
              className={`relative card p-6 ${highlight ? 'border-violet-400/60 bg-violet-500/10' : ''}`}
            >
              {highlight && <span className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-violet-600 px-3 py-1 text-xs font-bold uppercase">แนะนำ</span>}
              <h2 className="text-2xl font-black">{p.name}</h2>
              <p className="mt-2 text-violet-100/60 text-sm">{p.periodDays} วัน</p>
              <div className="mt-4 flex items-baseline gap-1">
                <span className="text-4xl font-black">฿{p.priceThb.toLocaleString()}</span>
                <span className="text-violet-100/60 text-sm">/ เดือน</span>
              </div>
              <ul className="mt-5 space-y-2 text-sm text-violet-100/80">
                {p.features.map((f) => (
                  <li key={f} className="flex items-start gap-2">
                    <span className="mt-0.5 text-emerald-300">✓</span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
              <button
                disabled={isCurrent}
                onClick={() => buy(p.key)}
                className={`mt-6 w-full rounded-full px-5 py-3 text-sm font-medium transition ${
                  isCurrent
                    ? 'cursor-not-allowed bg-emerald-500/20 text-emerald-200'
                    : highlight
                      ? 'bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-60'
                      : 'border border-violet-400/30 text-violet-100 hover:bg-violet-500/10 disabled:opacity-60'
                }`}
              >
                {isCurrent ? 'ใช้งานอยู่' : `เลือก ${p.name}`}
              </button>
            </div>
          );
        })}
      </div>

      {error && <p className="mt-5 text-center text-sm text-rose-300">{error}</p>}

      <p className="mt-10 text-center text-xs text-violet-100/40">
        หมายเหตุ: โหมดทดสอบจะแสดง QR PromptPay และมีปุ่มจำลองการชำระเงินเพื่อเปิดแพคเกจ
      </p>
    </Shell>
  );
}
