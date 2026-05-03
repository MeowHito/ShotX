'use client';

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? '';

export function GoogleButton({ label = 'เข้าสู่ระบบด้วย Google', intent = 'login' }: { label?: string; intent?: 'login' | 'register' }) {
  function start() {
    if (!GOOGLE_CLIENT_ID) return;
    const redirectUri = `${window.location.origin}/auth/callback`;
    const state = encodeURIComponent(JSON.stringify({ intent, ts: Date.now() }));
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: redirectUri,
      response_type: 'token',
      scope: 'openid email profile',
      include_granted_scopes: 'true',
      prompt: 'select_account',
      state,
    });
    const url = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    console.log('[GoogleButton] redirect_uri:', redirectUri);
    console.log('[GoogleButton] client_id:', GOOGLE_CLIENT_ID);
    console.log('[GoogleButton] auth URL:', url);
    window.location.href = url;
  }

  if (!GOOGLE_CLIENT_ID) {
    return <p className="text-xs text-amber-300/80">ตั้งค่า NEXT_PUBLIC_GOOGLE_CLIENT_ID ใน .env.local เพื่อเปิดใช้งาน Google Sign-In</p>;
  }

  return (
    <button
      type="button"
      onClick={start}
      className="flex w-full items-center justify-center gap-3 rounded-full bg-white px-5 py-2.5 text-sm font-medium text-slate-900 shadow hover:bg-slate-100"
    >
      <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
        <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
        <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.583-5.036-3.71H.957v2.332A8.997 8.997 0 0 0 9 18z" />
        <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" />
        <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
      </svg>
      {label}
    </button>
  );
}
