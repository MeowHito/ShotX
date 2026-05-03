'use client';

import { useEffect, useState } from 'react';
import { Shell } from '@/components/Shell';
import { BarChart } from '@/components/BarChart';
import { authFetch, useMe } from '@/lib/auth';

type Stats = {
  active_users: number;
  active_events: number;
  total_photos: number;
  queued_ai_jobs: number;
  total_downloads: number;
  total_searches: number;
  total_revenue_thb: number;
};

type Revenue = {
  monthly: { month: string; revenue_thb: number; subscriptions: number }[];
  by_plan: { plan: string; revenue_thb: number; subscriptions: number }[];
  signups_30d: { day: string; signups: number }[];
};

const ADMIN_SECRET_KEY = 'shotx_admin_secret';

export default function AdminPage() {
  const { me, loading: meLoading } = useMe();
  const [adminSecret, setAdminSecret] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [revenue, setRevenue] = useState<Revenue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setAdminSecret(window.localStorage.getItem(ADMIN_SECRET_KEY) ?? '');
    }
  }, []);

  async function load() {
    if (!adminSecret) {
      setError('กรอก admin secret ก่อน');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      window.localStorage.setItem(ADMIN_SECRET_KEY, adminSecret);
      const headers = { 'X-Admin-Secret': adminSecret };
      const [s, r] = await Promise.all([
        authFetch<Stats>('/admin/stats', { headers }),
        authFetch<Revenue>('/admin/revenue', { headers }),
      ]);
      setStats(s);
      setRevenue(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (meLoading) {
    return <Shell><p className="text-violet-100/60">กำลังโหลด…</p></Shell>;
  }

  if (!me) {
    return (
      <Shell>
        <div className="card mx-auto max-w-md p-6">
          <h1 className="text-2xl font-black">Admin Console</h1>
          <p className="mt-3 text-violet-100/60">ต้องเข้าสู่ระบบด้วยบัญชีที่มีสิทธิ์ admin ก่อน</p>
          <a href="/login" className="btn-primary mt-5 inline-block px-5 py-2">ไปหน้า Login</a>
        </div>
      </Shell>
    );
  }

  const monthlyData = (revenue?.monthly ?? []).map((m) => ({
    label: new Date(m.month).toLocaleDateString('th-TH', { month: 'short', year: '2-digit' }),
    value: m.revenue_thb,
  }));
  const planData = (revenue?.by_plan ?? []).map((p) => ({ label: p.plan, value: p.revenue_thb }));
  const signupData = (revenue?.signups_30d ?? []).map((s) => ({
    label: new Date(s.day).toLocaleDateString('th-TH', { day: 'numeric', month: 'numeric' }),
    value: s.signups,
  }));

  const cards = stats
    ? [
        ['ช่างภาพ Active', stats.active_users.toLocaleString()],
        ['งาน Active', stats.active_events.toLocaleString()],
        ['ภาพทั้งหมด', stats.total_photos.toLocaleString()],
        ['คิว AI', stats.queued_ai_jobs.toLocaleString()],
        ['ยอดดาวน์โหลด', stats.total_downloads.toLocaleString()],
        ['การค้นหาด้วยใบหน้า', stats.total_searches.toLocaleString()],
        ['รายได้สะสม (THB)', `฿${stats.total_revenue_thb.toLocaleString()}`],
      ]
    : [];

  return (
    <Shell>
      <h1 className="text-3xl font-black">Admin Console</h1>
      <p className="mt-2 text-violet-100/60">สรุปรายได้, ผู้ใช้งาน, ภาพ และระบบ AI</p>

      <div className="card mt-6 p-5">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <input
            className="rounded-xl border-violet-500/20 bg-white/5"
            type="password"
            placeholder="Admin secret (X-Admin-Secret)"
            value={adminSecret}
            onChange={(e) => setAdminSecret(e.target.value)}
          />
          <button className="btn-primary px-5 py-2" disabled={loading} onClick={load}>
            {loading ? 'กำลังโหลด…' : 'โหลดข้อมูล'}
          </button>
        </div>
        {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}
      </div>

      {stats && (
        <div className="mt-6 grid gap-4 md:grid-cols-3 lg:grid-cols-4">
          {cards.map(([title, value]) => (
            <div key={title} className="card p-5">
              <div className="text-sm text-violet-100/50">{title}</div>
              <div className="mt-3 text-2xl font-black">{value}</div>
            </div>
          ))}
        </div>
      )}

      {revenue && (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <div className="card p-5">
            <h2 className="mb-4 text-lg font-bold">รายได้รายเดือน (12 เดือนล่าสุด)</h2>
            <BarChart data={monthlyData} formatValue={(v) => `฿${v.toLocaleString()}`} />
          </div>
          <div className="card p-5">
            <h2 className="mb-4 text-lg font-bold">รายได้ตามแพคเกจ</h2>
            <BarChart data={planData} formatValue={(v) => `฿${v.toLocaleString()}`} />
          </div>
          <div className="card p-5 lg:col-span-2">
            <h2 className="mb-4 text-lg font-bold">การสมัครใหม่ 30 วันล่าสุด</h2>
            <BarChart data={signupData} />
          </div>
        </div>
      )}
    </Shell>
  );
}
