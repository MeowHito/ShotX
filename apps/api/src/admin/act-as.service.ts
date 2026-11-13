import { Inject, Injectable } from '@nestjs/common';
import { users } from '@shotx/db';
import type { ActAsResponse, AuthTokenResponse } from '@shotx/shared';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { sessionUser, tokenResponse } from '../auth/auth.service';
import { newOpaqueToken, startSession } from '../auth/sessions';
import { SHOTX_AUTH, type ShotxAuth } from '../auth/shotx-auth';
import type { ApiConfig } from '../config';
import type { Db, Queryable } from '../db/db';
import { ApiError, notFound } from '../http/api-error';
import { sha256Hex } from '../http/client';
import {
  API_CONFIG,
  CLOCK,
  type Clock,
  DATABASE,
  KEY_VALUE_STORE,
  type KeyValueStore,
} from '../tokens';
import { writeAdminAudit } from './admin-audit';

/** Path of web's route handler that exchanges the code and opens the studio. */
export const WEB_ACT_AS_PATH = '/auth/act-as';

/** Redis key of a pending act-as code: its SHA-256 only, so a store dump can't be replayed. */
export const actAsCodeKey = (code: string) => `act-as:${sha256Hex(code)}`;

const pendingSchema = z.object({ userId: z.string(), adminId: z.string() });

const ended = () =>
  new ApiError('UNAUTHENTICATED', 'This link has expired; open it again from the admin app');

async function activeAccount(q: Queryable, id: string, role: 'admin' | 'photographer') {
  const [row] = await q
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(and(eq(users.id, id), eq(users.role, role)))
    .limit(1);
  return row ?? null;
}

/**
 * Admin act-as (ADR 0018): an admin opens a photographer's studio as them to help.
 * - `start` (POST /admin/users/:id/act-as): a one-time CSPRNG code in Redis for
 *   ADMIN_ACT_AS_CODE_SECONDS, audited (`admin.user.act_as`), as a link to web's /auth/act-as.
 * - `exchange` (POST /auth/act-as, web's BFF): takes the code once, re-checks that the admin and
 *   the photographer are still active, and starts a users-pool session of the photographer that
 *   carries `acting_admin_id` and ends after ADMIN_ACT_AS_SESSION_SECONDS (never extended).
 * The photographer's own sessions are untouched; their temporary password doesn't restrict the
 * admin. The guard audits every change made in the session and refuses the password change.
 */
@Injectable()
export class ActAsService {
  constructor(
    @Inject(DATABASE) private readonly db: Db,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(KEY_VALUE_STORE) private readonly store: KeyValueStore,
    @Inject(SHOTX_AUTH) private readonly auth: ShotxAuth | null,
  ) {}

  private shotx(): ShotxAuth {
    if (this.auth === null) {
      throw new ApiError('CONFLICT', 'Acting as a photographer needs AUTH_PROVIDER=shotx');
    }
    return this.auth;
  }

  async start(adminId: string, rawUserId: string): Promise<ActAsResponse> {
    this.shotx();
    const userId = rawUserId.toLowerCase();
    const photographer = await activeAccount(this.db, userId, 'photographer');
    if (photographer === null) throw notFound('User');
    if (photographer.status !== 'active') {
      throw new ApiError('CONFLICT', 'This account is disabled; enable it first');
    }
    const now = this.clock.now();
    const seconds = this.config.adminConsole.actAsCodeSeconds;
    const expiresAt = new Date(now.getTime() + seconds * 1000);
    const code = newOpaqueToken();
    await this.store.setWithTtl(actAsCodeKey(code), JSON.stringify({ userId, adminId }), seconds);
    await writeAdminAudit(this.db, {
      actorId: adminId,
      action: 'admin.user.act_as',
      target: 'user',
      targetId: userId,
      meta: { expiresAt: expiresAt.toISOString() },
      now,
    });
    const base = new URL(this.config.app.publicBaseUrl).origin;
    return {
      url: `${base}${WEB_ACT_AS_PATH}?${new URLSearchParams({ code }).toString()}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async exchange(code: string): Promise<AuthTokenResponse> {
    const auth = this.shotx();
    // One time: taken before anything else, so a replay finds nothing.
    const raw = await this.store.take(actAsCodeKey(code));
    if (raw === null) throw ended();
    let pending: z.output<typeof pendingSchema>;
    try {
      pending = pendingSchema.parse(JSON.parse(raw));
    } catch {
      throw ended();
    }
    const [admin, photographer] = await Promise.all([
      activeAccount(this.db, pending.adminId, 'admin'),
      activeAccount(this.db, pending.userId, 'photographer'),
    ]);
    if (admin?.status !== 'active' || photographer?.status !== 'active') throw ended();
    const now = this.clock.now();
    const session = await startSession(this.db, {
      userId: pending.userId,
      pool: 'users',
      now,
      ttlSeconds: this.config.adminConsole.actAsSessionSeconds,
      amr: ['pwd'],
      actingAdminId: pending.adminId,
    });
    return tokenResponse(
      auth,
      'users',
      await sessionUser(this.db, pending.userId),
      session,
      ['pwd'],
      now,
    );
  }
}
