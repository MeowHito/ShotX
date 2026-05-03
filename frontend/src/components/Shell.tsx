'use client';

import Link from 'next/link';
import { useMe } from '@/lib/auth';

export function Shell({ children }: { children: React.ReactNode }) {
  const { me, signOut } = useMe();

  const nav = me
    ? me.role === 'admin'
      ? [{ href: '/admin', label: 'Admin' }, { href: '/dashboard', label: 'โฟลเดอร์' }, { href: '/pricing', label: 'แพคเกจ' }]
      : [{ href: '/dashboard', label: 'โฟลเดอร์' }, { href: '/pricing', label: 'แพคเกจ' }]
    : [{ href: '/', label: 'หน้าแรก' }, { href: '/pricing', label: 'แพคเกจ' }];

  return (
    <main className="min-h-screen bg-[radial-gradient(ellipse_at_top_left,_rgba(139,92,246,.24),_transparent_45%),#0d0b1e]">
      <header className="sticky top-0 z-20 border-b border-violet-500/10 bg-[#0d0b1e]/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-xl font-black">ShotX</Link>
          <nav className="flex items-center gap-4 text-sm text-violet-200/70">
            {nav.map((item) => (
              <Link key={item.href} href={item.href} className="hover:text-white">{item.label}</Link>
            ))}
            {me ? (
              <>
                <span className="hidden text-violet-200/50 sm:inline">{me.name}</span>
                <button onClick={signOut} className="rounded-full border border-violet-400/30 px-3 py-1 hover:bg-violet-500/10">ออกจากระบบ</button>
              </>
            ) : (
              <>
                <Link href="/login" className="hover:text-white">เข้าสู่ระบบ</Link>
                <Link href="/register" className="rounded-full bg-violet-600 px-3 py-1 text-white hover:bg-violet-500">สมัครช่างภาพ</Link>
              </>
            )}
          </nav>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-6 py-10">{children}</div>
    </main>
  );
}
