import Link from 'next/link';
import { Camera, Cloud, ScanFace, ShieldCheck } from 'lucide-react';
import { Shell } from '@/components/Shell';

const features = [
  { icon: Camera, title: 'Upload & Sync', text: 'ช่างภาพอัปโหลดภาพเข้างาน แล้วส่งเข้า AI queue อัตโนมัติ' },
  { icon: ScanFace, title: 'AI Face Search', text: 'แขกถ่าย selfie แล้วค้นภาพด้วย pgvector + InsightFace' },
  { icon: Cloud, title: 'EC2 Storage', text: 'เก็บ originals, thumbnails และไฟล์ watermark-ready บน storage ของ server' },
  { icon: ShieldCheck, title: 'Private by design', text: 'แยก original private, ลบ selfie หลังค้นหา และรองรับ PDPA' },
];

export default function HomePage() {
  return (
    <Shell>
      <section className="grid gap-10 py-16 lg:grid-cols-[1.2fr_.8fr] lg:items-center">
        <div>
          <div className="mb-5 inline-flex rounded-full border border-violet-400/30 bg-violet-500/10 px-4 py-2 text-sm text-violet-200">AI Event Photography Platform</div>
          <h1 className="text-5xl font-black leading-tight md:text-7xl">ถ่าย อัปโหลด แขกหาภาพตัวเองได้ทันที</h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-violet-100/70">EventDD/ShotX สำหรับช่างภาพ Event: สร้างงาน อัปโหลดภาพ ค้นหาใบหน้าด้วย AI ดาวน์โหลดพร้อม watermark และจัดการ storage/billing ได้ในระบบเดียว</p>
          <div className="mt-8 flex flex-wrap gap-4">
            <Link href="/register" className="btn-primary px-6 py-3">เริ่มต้นใช้งาน</Link>
            <Link href="/pricing" className="btn-outline px-6 py-3">ดูแพคเกจ</Link>
          </div>
          <p className="mt-3 text-sm text-violet-100/50">ลูกค้าของช่างภาพไม่ต้องสมัคร — เปิดลิงก์ที่ได้รับเพื่อค้นหารูปด้วย selfie ได้เลย</p>
        </div>
        <div className="card p-6">
          <div className="rounded-3xl bg-violet-500/10 p-6">
            <div className="mb-4 text-sm text-violet-200/60">Live flow</div>
            {['Create event', 'Upload photos to server storage', 'AI worker extracts faces', 'Guest selfie search'].map((step, index) => (
              <div key={step} className="mb-3 flex items-center gap-3 rounded-2xl bg-white/5 p-4">
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-violet-600 text-sm font-bold">{index + 1}</span>
                <span>{step}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
      <section className="grid gap-4 md:grid-cols-4">
        {features.map((item) => <div key={item.title} className="card p-5"><item.icon className="mb-4 text-violet-300" /><h3 className="font-bold">{item.title}</h3><p className="mt-2 text-sm text-violet-100/60">{item.text}</p></div>)}
      </section>
    </Shell>
  );
}
