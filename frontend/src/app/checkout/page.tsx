'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Shell } from '@/components/Shell';
import { authFetch, useMe } from '@/lib/auth';

type CheckoutQuote = {
  reference: string;
  payment_method: string;
  promptpay_id: string;
  qr_payload: string;
  plan: {
    key: string;
    name: string;
    period_days: number;
    storage_gb: number;
    max_folders: number;
    max_photos_per_folder: number;
  };
  pricing: {
    subtotal_thb: number;
    vat_rate: number;
    vat_thb: number;
    total_thb: number;
  };
};

export default function CheckoutPage() {
  return (
    <Suspense fallback={<Shell><p className="text-violet-100/60">กำลังโหลด…</p></Shell>}>
      <CheckoutContent />
    </Suspense>
  );
}

function CheckoutContent() {
  const router = useRouter();
  const params = useSearchParams();
  const plan = params.get('plan') ?? '';
  const { me, loading: meLoading } = useMe();
  const [quote, setQuote] = useState<CheckoutQuote | null>(null);
  const [loading, setLoading] = useState(true);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qrUrl = useMemo(() => {
    if (!quote) return '';
    const data = encodeURIComponent(quote.qr_payload);
    return `https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=12&data=${data}`;
  }, [quote]);

  useEffect(() => {
    if (meLoading) return;
    if (!me) {
      router.replace('/login');
      return;
    }
    if (!plan) {
      router.replace('/pricing');
      return;
    }

    setLoading(true);
    setError(null);
    authFetch<CheckoutQuote>('/billing/checkout/quote', {
      method: 'POST',
      body: JSON.stringify({ plan }),
    })
      .then((data) => setQuote(data))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [me, meLoading, plan, router]);

  async function confirmPayment() {
    if (!quote) return;
    setPaying(true);
    setError(null);
    try {
      await authFetch('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ plan: quote.plan.key }),
      });
      router.push('/dashboard');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPaying(false);
    }
  }

  if (meLoading || loading) {
    return <Shell><p className="text-violet-100/60">กำลังเตรียมรายการชำระเงิน…</p></Shell>;
  }

  if (error && !quote) {
    return (
      <Shell>
        <div className="card mx-auto max-w-xl p-6 text-center">
          <h1 className="text-2xl font-black">ไม่สามารถสร้างรายการชำระเงินได้</h1>
          <p className="mt-3 text-sm text-rose-300">{error}</p>
          <button className="btn-primary mt-5 px-5 py-2" onClick={() => router.push('/pricing')}>กลับไปเลือกแพคเกจ</button>
        </div>
      </Shell>
    );
  }

  if (!quote) return null;

  return (
    <Shell>
      <div className="mx-auto grid max-w-5xl gap-6 lg:grid-cols-[1fr_.9fr]">
        <div className="card p-6">
          <p className="text-sm font-bold text-violet-200/70">Checkout</p>
          <h1 className="mt-2 text-3xl font-black">แพคเกจ {quote.plan.name}</h1>
          <p className="mt-2 text-sm text-violet-100/60">ใช้งาน {quote.plan.period_days} วัน หลังจำลองชำระเงินสำเร็จ ระบบจะพาไปหน้าโฟลเดอร์ทันที</p>

          <div className="mt-6 grid gap-3 sm:grid-cols-3">
            <div className="rounded-2xl border border-violet-500/15 bg-white/[0.03] p-4">
              <div className="text-xs text-violet-100/50">พื้นที่</div>
              <div className="mt-1 text-xl font-black">{quote.plan.storage_gb.toLocaleString()} GB</div>
            </div>
            <div className="rounded-2xl border border-violet-500/15 bg-white/[0.03] p-4">
              <div className="text-xs text-violet-100/50">โฟลเดอร์</div>
              <div className="mt-1 text-xl font-black">{quote.plan.max_folders.toLocaleString()}</div>
            </div>
            <div className="rounded-2xl border border-violet-500/15 bg-white/[0.03] p-4">
              <div className="text-xs text-violet-100/50">รูป/โฟลเดอร์</div>
              <div className="mt-1 text-xl font-black">{quote.plan.max_photos_per_folder.toLocaleString()}</div>
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-violet-500/15 bg-black/20 p-5">
            <div className="flex justify-between py-2 text-sm">
              <span className="text-violet-100/60">ราคาแพคเกจ</span>
              <span>฿{quote.pricing.subtotal_thb.toLocaleString()}</span>
            </div>
            <div className="flex justify-between py-2 text-sm">
              <span className="text-violet-100/60">VAT {(quote.pricing.vat_rate * 100).toFixed(0)}%</span>
              <span>฿{quote.pricing.vat_thb.toLocaleString()}</span>
            </div>
            <div className="mt-2 flex justify-between border-t border-violet-500/15 pt-4 text-lg font-black">
              <span>ยอดรวม</span>
              <span>฿{quote.pricing.total_thb.toLocaleString()}</span>
            </div>
          </div>

          {error && <p className="mt-4 text-sm text-rose-300">{error}</p>}
        </div>

        <div className="card p-6 text-center">
          <h2 className="text-xl font-black">สแกน QR PromptPay</h2>
          <p className="mt-2 text-sm text-violet-100/60">PromptPay: {quote.promptpay_id}</p>
          <div className="mx-auto mt-5 inline-block rounded-3xl bg-white p-4 shadow-2xl">
            <img src={qrUrl} alt="PromptPay QR" className="h-[260px] w-[260px]" />
          </div>
          <div className="mt-5 rounded-2xl border border-violet-500/15 bg-white/[0.03] p-4 text-left text-xs text-violet-100/60">
            <div>Reference: <span className="font-mono text-violet-100">{quote.reference}</span></div>
            <div className="mt-2 break-all">Payload: <span className="font-mono text-violet-100/80">{quote.qr_payload}</span></div>
          </div>
          <button className="btn-primary mt-5 w-full px-5 py-3" disabled={paying} onClick={confirmPayment}>
            {paying ? 'กำลังเปิดแพคเกจ…' : 'จำลองว่าชำระเงินแล้ว'}
          </button>
          <p className="mt-3 text-xs text-amber-200/70">โหมด Demo / Mock: ปุ่มนี้ยังไม่ตรวจสอบยอดเงินจริง ใช้สำหรับทดสอบ flow เท่านั้น</p>
        </div>
      </div>
    </Shell>
  );
}
