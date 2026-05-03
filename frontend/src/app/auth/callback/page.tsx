'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Shell } from '@/components/Shell';
import { authFetch, setToken, type Photographer } from '@/lib/auth';

type AuthResponse = { token: string; photographer: Photographer };

export default function GoogleCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [debug, setDebug] = useState<string>('init');

  useEffect(() => {
    const url = window.location.href;
    const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : '';
    const search = window.location.search;
    console.log('[callback] full URL:', url);
    console.log('[callback] hash:', hash);
    console.log('[callback] search:', search);
    setDebug(`URL: ${url}\nHASH: ${hash}\nSEARCH: ${search}`);

    const params = new URLSearchParams(hash || search.slice(1));
    const accessToken = params.get('access_token');
    const errorParam = params.get('error');
    const errorDesc = params.get('error_description');

    if (errorParam) {
      setError(`Google: ${errorParam}${errorDesc ? ' - ' + errorDesc : ''}`);
      return;
    }
    if (!accessToken) {
      setError('ไม่พบ access_token จาก Google ใน URL');
      return;
    }

    let intent: 'login' | 'register' = 'login';
    try {
      const state = params.get('state');
      if (state) intent = JSON.parse(decodeURIComponent(state)).intent ?? 'login';
    } catch {}

    console.log('[callback] sending access_token to backend, intent=', intent);
    setDebug((d) => d + `\n→ POST /auth/google (intent=${intent})`);

    authFetch<AuthResponse>('/auth/google', {
      method: 'POST',
      body: JSON.stringify({ access_token: accessToken, intent }),
    })
      .then(async (data) => {
        console.log('[callback] backend OK:', data);
        setToken(data.token);
        let dest = '/dashboard';
        if (data.photographer.role === 'admin') {
          dest = '/admin';
        } else {
          try {
            const sub = await authFetch<{ plan: string } | null>('/billing/subscription');
            dest = sub ? '/dashboard' : '/pricing';
          } catch {
            dest = '/pricing';
          }
        }
        setDebug((d) => d + `\n✓ token saved → redirecting to ${dest}`);
        window.location.href = dest;
      })
      .catch((err: Error) => {
        console.error('[callback] backend error:', err);
        setError(err.message);
      });
  }, [router]);

  return (
    <Shell>
      <div className="mx-auto max-w-2xl">
        <div className="card p-6">
          {error ? (
            <>
              <h1 className="text-xl font-bold text-rose-300">เข้าสู่ระบบไม่สำเร็จ</h1>
              <p className="mt-3 break-all text-sm text-violet-100/70">{error}</p>
              <a href="/login" className="btn-primary mt-5 inline-block px-5 py-2">กลับไปหน้า Login</a>
            </>
          ) : (
            <>
              <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-violet-400 border-t-transparent" />
              <p className="mt-4 text-center text-violet-100/70">กำลังเข้าสู่ระบบด้วย Google…</p>
            </>
          )}
          <pre className="mt-6 overflow-auto rounded-xl bg-black/40 p-4 text-xs text-violet-100/60 whitespace-pre-wrap break-all">{debug}</pre>
        </div>
      </div>
    </Shell>
  );
}
