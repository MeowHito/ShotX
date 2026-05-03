export type PlanKey = 'basic' | 'standard' | 'pro';

export type PlanConfig = {
  key: PlanKey;
  name: string;
  priceThb: number;
  periodDays: number;
  storageGb: number;
  maxFolders: number;
  maxPhotosPerFolder: number;
  aiQuota: number;
  features: string[];
};

export const PLANS: Record<PlanKey, PlanConfig> = {
  basic: {
    key: 'basic',
    name: 'Basic',
    priceThb: 299,
    periodDays: 30,
    storageGb: 20,
    maxFolders: 5,
    maxPhotosPerFolder: 500,
    aiQuota: 2_000,
    features: [
      'พื้นที่เก็บรูป 20 GB',
      'สร้างได้ 5 โฟลเดอร์',
      'รูปสูงสุด 500 รูป/โฟลเดอร์',
      'AI face search (มาตรฐาน)',
      'แชร์ลิงก์ให้ลูกค้า + สแกนหน้า',
      'ใส่ลายน้ำอัตโนมัติ',
    ],
  },
  standard: {
    key: 'standard',
    name: 'Standard',
    priceThb: 699,
    periodDays: 30,
    storageGb: 100,
    maxFolders: 25,
    maxPhotosPerFolder: 3_000,
    aiQuota: 15_000,
    features: [
      'พื้นที่เก็บรูป 100 GB',
      'สร้างได้ 25 โฟลเดอร์',
      'รูปสูงสุด 3,000 รูป/โฟลเดอร์',
      'AI face search (เร็วขึ้น)',
      'ดาวน์โหลดเป็นชุด ZIP',
      'ลายน้ำแบบกำหนดเอง',
    ],
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    priceThb: 1_490,
    periodDays: 30,
    storageGb: 500,
    maxFolders: 200,
    maxPhotosPerFolder: 20_000,
    aiQuota: 100_000,
    features: [
      'พื้นที่เก็บรูป 500 GB',
      'โฟลเดอร์ไม่จำกัดในทางปฏิบัติ',
      'รูปสูงสุด 20,000 รูป/โฟลเดอร์',
      'AI face search (Priority queue)',
      'ลบ selfie อัตโนมัติ + รายงาน PDPA',
      'Support ตอบใน 2 ชม.',
    ],
  },
};

export function getPlan(key: string): PlanConfig {
  return PLANS[key as PlanKey] ?? PLANS.basic;
}
