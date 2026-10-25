import { Inject, Injectable } from '@nestjs/common';
import { plans, storageUsage, subscriptions, users } from '@shotx/db';
import {
  generateOpaqueToken,
  type MeResponse,
  TRIAL_PLAN_CODE,
  trialSubscription,
  viewerSessionKey,
} from '@shotx/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { ApiConfig } from '../config';
import type { Db, Queryable } from '../db/db';
import { sha256Hex } from '../http/client';
import {
  API_CONFIG,
  CLOCK,
  type Clock,
  DATABASE,
  KEY_VALUE_STORE,
  type KeyValueStore,
} from '../tokens';

/** Subscription statuses that hold the photographer's one live subscription. */
const LIVE = sql`${subscriptions.status} IN ('trial', 'active', 'grace')`;

/**
 * The signed-in user (`/me`). The guard has already provisioned the `users` row. Becoming a
 * photographer sets the role and starts the trial in one transaction, idempotently.
 */
@Injectable()
export class MeService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
  ) {}

  async me(userId: string, q: Queryable = this.db): Promise<MeResponse> {
    const [user] = await q.select().from(users).where(eq(users.id, userId));
    if (user === undefined || user.role === 'admin') throw new Error('Guarded user vanished');
    let subscription: MeResponse['subscription'] = null;
    if (user.role === 'photographer') {
      const [row] = await q
        .select({
          status: subscriptions.status,
          periodEnd: subscriptions.periodEnd,
          cancelAtPeriodEnd: subscriptions.cancelAtPeriodEnd,
          planCode: plans.code,
        })
        .from(subscriptions)
        .innerJoin(plans, eq(plans.id, subscriptions.planId))
        .where(eq(subscriptions.photographerId, userId))
        .orderBy(desc(LIVE), desc(subscriptions.createdAt), desc(subscriptions.id))
        .limit(1);
      if (row !== undefined) {
        subscription = {
          status: row.status,
          planCode: row.planCode,
          periodEnd: row.periodEnd.toISOString(),
          cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        };
      }
    }
    return {
      id: user.id,
      role: user.role,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt.toISOString(),
      subscription,
      features: { faceSearch: this.config.features.faceSearch },
    };
  }

  /**
   * Photographer onboarding (trialSubscription): `UPDATE users SET role = 'photographer' WHERE
   * role = 'user'` takes the row lock, so concurrent calls serialise and only the first one
   * inserts the trial and the storage_usage row. Later calls return the current state.
   */
  async becomePhotographer(
    userId: string,
    body: { name?: string | undefined },
  ): Promise<MeResponse> {
    return this.db.transaction(async (tx) => {
      const [promoted] = await tx
        .update(users)
        .set({ role: 'photographer', ...(body.name === undefined ? {} : { name: body.name }) })
        .where(and(eq(users.id, userId), eq(users.role, 'user')))
        .returning({ id: users.id });
      if (promoted !== undefined) {
        const [plan] = await tx
          .select({ id: plans.id, trialDays: plans.trialDays })
          .from(plans)
          .where(eq(plans.code, TRIAL_PLAN_CODE));
        if (plan?.trialDays == null) throw new Error('The trial plan is not seeded');
        await tx.insert(subscriptions).values({
          photographerId: userId,
          planId: plan.id,
          ...trialSubscription(this.clock.now(), plan.trialDays),
        });
        await tx.insert(storageUsage).values({ photographerId: userId }).onConflictDoNothing();
      } else if (body.name !== undefined) {
        await tx.update(users).set({ name: body.name }).where(eq(users.id, userId));
      }
      return this.me(userId, tx);
    });
  }

  /**
   * A viewer session for the public share routes: an opaque CSPRNG token whose SHA-256 maps to
   * the user id in Redis (TTL VIEWER_SESSION_TTL_SECONDS). Returns the cookie value.
   */
  async createViewerSession(userId: string): Promise<string> {
    const token = generateOpaqueToken();
    await this.store.setWithTtl(
      viewerSessionKey(sha256Hex(token)),
      userId,
      this.config.share.viewerSessionTtlSeconds,
    );
    return token;
  }

  async deleteViewerSession(token: string): Promise<void> {
    await this.store.del(viewerSessionKey(sha256Hex(token)));
  }
}
