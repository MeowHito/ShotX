'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Shell } from '@/components/Shell';
import { GoogleButton } from '@/components/GoogleButton';
import { authFetch, setToken, type Photographer } from '@/lib/auth';

type AuthResponse = { token: string; photographer: Photographer };

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await authFetch<AuthResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      setToken(data.token);
      if (data.photographer.role === 'admin') {
        router.push('/admin');
        return;
      }
      try {
        const sub = await authFetch<{ plan: string } | null>('/billing/subscription');
        router.push(sub ? '/dashboard' : '/pricing');
      } catch {
        router.push('/pricing');
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Shell>
      <div className="mx-auto max-w-md">
        <div className="card p-6">
          <h1 className="text-2xl font-black">เข้าสู่ระบบช่างภาพ</h1>
          <p className="mt-2 text-sm text-violet-100/60">ผู้ที่จะค้นหารูปด้วย selfie ไม่ต้องล็อกอิน — เปิด URL ที่ช่างภาพส่งให้ได้เลย</p>

          <div className="mt-5">
            <GoogleButton intent="login" label="เข้าสู่ระบบด้วย Google" />
          </div>

          <div className="my-5 flex items-center gap-3 text-xs text-violet-200/40">
            <span className="h-px flex-1 bg-violet-500/20" /> หรือ <span className="h-px flex-1 bg-violet-500/20" />
          </div>

          <form onSubmit={handleSubmit} className="grid gap-3">
            <input
              className="rounded-xl border-violet-500/20 bg-white/5"
              type="email"
              placeholder="email@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              className="rounded-xl border-violet-500/20 bg-white/5"
              type="password"
              placeholder="รหัสผ่าน"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
            />
            <button className="btn-primary py-3" disabled={loading}>
              {loading ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
            </button>
          </form>

          {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}

          <p className="mt-5 text-sm text-violet-100/60">
            ยังไม่มีบัญชี? <Link href="/register" className="text-violet-200 underline">สมัครสมาชิก (ช่างภาพเท่านั้น)</Link>
          </p>
        </div>
      </div>
    </Shell>
  );
}
