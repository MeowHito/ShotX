import type { ReactNode } from 'react';
import { SiteFooter, SiteHeader } from '@/components/site/site-header';

/** The checkout pages' frame: the public header and footer around one white card (ADR 0026). */
export function CheckoutShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-[#f3f7fb] text-[#14293b]">
      <SiteHeader />
      <main className="flex flex-1 items-start justify-center px-[18px] py-10 sm:items-center sm:py-16">
        <div className="w-full max-w-md rounded-[18px] border border-[#dce6ee] bg-white p-6 shadow-[0_9px_25px_#123c5e0a] sm:p-8">
          {children}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
