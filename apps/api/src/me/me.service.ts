import { Inject, Injectable } from '@nestjs/common';
import { plans, subscriptions, users } from '@shotx/db';
import { generateOpaqueToken, type MeResponse, viewerSessionKey } from '@shotx/shared';
import { desc, eq, sql } from 'drizzle-orm';
import type { ApiConfig } from '../config';
import type { Db, Queryable } from '../db/db';
import { sha256Hex } from '../http/client';
import { API_CONFIG, DATABASE, KEY_VALUE_STORE, type KeyValueStore } from '../tokens';

/** Subscription statuses that hold the photographer's one live subscription. */
const LIVE = sql`${subscriptions.status} IN ('trial', 'active', 'grace')`;

/**
 * The signed-in user (`/me`). The guard has already provisioned the `users` row. Nobody becomes a
 * photographer here any more (ADR 0010: admins create photographer accounts).
 */
@Injectable()
export class MeService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
  ) {}

  /** `passwordChangeRequired`: the session is restricted (PASSWORD_CHANGE_CLAIM, ADR 0010). */
  async me(
    userId: string,
    passwordChangeRequired: boolean,
    q: Queryable = this.db,
  ): Promise<MeResponse> {
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
      passwordChangeRequired,
    };
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
