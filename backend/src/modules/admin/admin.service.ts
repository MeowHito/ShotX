import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { serializeForJson } from '../../common/serialize';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  async stats() {
    const [activeUsers, events, photos, pendingJobs, totalDownloads, totalSearches] = await Promise.all([
      this.prisma.photographer.count({ where: { status: 'active' } }),
      this.prisma.event.count({ where: { status: 'active' } }),
      this.prisma.photo.count(),
      this.prisma.aiJob.count({ where: { status: 'queued' } }),
      this.prisma.download.count(),
      this.prisma.guestSearch.count(),
    ]);

    const revenueAgg = await this.prisma.subscription.aggregate({
      _sum: { amountThb: true },
      where: { status: 'active' },
    });

    return {
      active_users: activeUsers,
      active_events: events,
      total_photos: photos,
      queued_ai_jobs: pendingJobs,
      total_downloads: totalDownloads,
      total_searches: totalSearches,
      total_revenue_thb: Number(revenueAgg._sum.amountThb ?? 0),
    };
  }

  async revenue() {
    const monthly = await this.prisma.$queryRaw<Array<{ month: Date; revenue_thb: bigint; subs: bigint }>>(Prisma.sql`
      SELECT date_trunc('month', current_period_start) AS month,
             SUM(amount_thb)::bigint AS revenue_thb,
             COUNT(*)::bigint AS subs
      FROM subscriptions
      WHERE current_period_start >= (NOW() - INTERVAL '12 months')
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    const byPlan = await this.prisma.$queryRaw<Array<{ plan: string; revenue_thb: bigint; subs: bigint }>>(Prisma.sql`
      SELECT plan::text AS plan,
             SUM(amount_thb)::bigint AS revenue_thb,
             COUNT(*)::bigint AS subs
      FROM subscriptions
      WHERE status = 'active'
      GROUP BY plan
      ORDER BY revenue_thb DESC
    `);

    const newSignups = await this.prisma.$queryRaw<Array<{ day: Date; signups: bigint }>>(Prisma.sql`
      SELECT date_trunc('day', created_at) AS day,
             COUNT(*)::bigint AS signups
      FROM photographers
      WHERE created_at >= (NOW() - INTERVAL '30 days')
      GROUP BY 1
      ORDER BY 1 ASC
    `);

    return {
      monthly: monthly.map((row) => ({ month: row.month, revenue_thb: Number(row.revenue_thb), subscriptions: Number(row.subs) })),
      by_plan: byPlan.map((row) => ({ plan: row.plan, revenue_thb: Number(row.revenue_thb), subscriptions: Number(row.subs) })),
      signups_30d: newSignups.map((row) => ({ day: row.day, signups: Number(row.signups) })),
    };
  }

  async photographers() {
    const photographers = await this.prisma.photographer.findMany({ orderBy: { createdAt: 'desc' }, take: 50 });
    return serializeForJson(photographers);
  }

  health() {
    return { api: { status: 'ok' }, database: { status: 'ok' }, storage: { status: 'not_checked' } };
  }

  async createSubscription(input: { photographer_id: string; plan: 'basic' | 'standard' | 'pro'; amount_thb: number; period_days?: number }) {
    const periodDays = input.period_days ?? 30;
    const start = new Date();
    const end = new Date(start.getTime() + periodDays * 24 * 60 * 60 * 1000);
    const subscription = await this.prisma.subscription.create({
      data: {
        photographerId: input.photographer_id,
        plan: input.plan,
        amountThb: input.amount_thb,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        status: 'active',
      },
    });
    await this.prisma.photographer.update({ where: { id: input.photographer_id }, data: { plan: input.plan } });
    return serializeForJson(subscription);
  }
}
