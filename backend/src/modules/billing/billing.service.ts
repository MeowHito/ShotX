import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { PLANS, PlanKey, getPlan } from './plans';

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  listPlans() {
    return Object.values(PLANS);
  }

  async currentSubscription(photographerId: string) {
    const sub = await this.prisma.subscription.findFirst({
      where: { photographerId, status: 'active', currentPeriodEnd: { gt: new Date() } },
      orderBy: { currentPeriodEnd: 'desc' },
    });
    if (!sub) return null;
    const plan = getPlan(sub.plan);
    return {
      id: sub.id,
      plan: plan.key,
      plan_name: plan.name,
      amount_thb: sub.amountThb,
      current_period_start: sub.currentPeriodStart,
      current_period_end: sub.currentPeriodEnd,
      limits: {
        storage_gb: plan.storageGb,
        max_folders: plan.maxFolders,
        max_photos_per_folder: plan.maxPhotosPerFolder,
        ai_quota: plan.aiQuota,
      },
    };
  }

  checkoutQuote(planKey: string) {
    if (!(planKey in PLANS)) throw new BadRequestException('invalid_plan');
    const plan = PLANS[planKey as PlanKey];
    const vatRate = Number(this.config.get<string>('VAT_RATE') ?? '0.07');
    const subtotalThb = plan.priceThb;
    const vatThb = Math.round(subtotalThb * vatRate);
    const totalThb = subtotalThb + vatThb;
    const promptpayId = this.config.get<string>('PROMPTPAY_ID') ?? '0812345678';
    const reference = `SHOTX-${plan.key}-${Date.now()}`;

    return {
      reference,
      payment_method: 'promptpay_qr_demo',
      promptpay_id: maskPromptPayId(promptpayId),
      qr_payload: createPromptPayPayload(promptpayId, totalThb),
      plan: {
        key: plan.key,
        name: plan.name,
        period_days: plan.periodDays,
        storage_gb: plan.storageGb,
        max_folders: plan.maxFolders,
        max_photos_per_folder: plan.maxPhotosPerFolder,
      },
      pricing: {
        subtotal_thb: subtotalThb,
        vat_rate: vatRate,
        vat_thb: vatThb,
        total_thb: totalThb,
      },
    };
  }

  async checkout(photographerId: string, planKey: string) {
    if (!(planKey in PLANS)) throw new BadRequestException('invalid_plan');
    const plan = PLANS[planKey as PlanKey];
    const quote = this.checkoutQuote(planKey);

    const existing = await this.prisma.photographer.findUnique({ where: { id: photographerId } });
    if (!existing) throw new NotFoundException('photographer_not_found');

    const start = new Date();
    const end = new Date(start.getTime() + plan.periodDays * 24 * 60 * 60 * 1000);

    const sub = await this.prisma.subscription.create({
      data: {
        photographerId,
        plan: plan.key,
        amountThb: quote.pricing.total_thb,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        status: 'active',
      },
    });
    await this.prisma.photographer.update({
      where: { id: photographerId },
      data: { plan: plan.key, status: 'active' },
    });
    return {
      id: sub.id,
      plan: plan.key,
      amount_thb: sub.amountThb,
      current_period_end: sub.currentPeriodEnd,
    };
  }

  async requireActiveSubscription(photographerId: string) {
    const current = await this.currentSubscription(photographerId);
    if (!current) throw new BadRequestException('subscription_required');
    return current;
  }
}

function maskPromptPayId(value: string) {
  const digits = value.replace(/\D/g, '');
  if (digits.length <= 4) return value;
  return `${digits.slice(0, 3)}${'*'.repeat(Math.max(digits.length - 6, 3))}${digits.slice(-3)}`;
}

function createPromptPayPayload(promptpayId: string, amountThb: number) {
  const merchantInfo = emv('00', 'A000000677010111') + emv('01', normalizePromptPayId(promptpayId));
  const payload = [
    emv('00', '01'),
    emv('01', '12'),
    emv('29', merchantInfo),
    emv('58', 'TH'),
    emv('53', '764'),
    emv('54', amountThb.toFixed(2)),
  ].join('');
  const checksumInput = `${payload}6304`;
  return `${checksumInput}${crc16Ccitt(checksumInput)}`;
}

function normalizePromptPayId(value: string) {
  const digits = value.replace(/\D/g, '');
  if (digits.length === 10 && digits.startsWith('0')) return `0066${digits.slice(1)}`;
  return digits;
}

function emv(id: string, value: string) {
  return `${id}${value.length.toString().padStart(2, '0')}${value}`;
}

function crc16Ccitt(value: string) {
  let crc = 0xffff;
  for (let i = 0; i < value.length; i += 1) {
    crc ^= value.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
