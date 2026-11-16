import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ADMIN_ROUTES, IDEMPOTENCY_KEY_HEADER } from '@shotx/shared';
import type { Request } from 'express';
import type { z } from 'zod';
import { AdminGuard, CurrentAdmin } from '../auth/admin.guard';
import { BffKeyGuard } from '../auth/bff.guard';
import type { AppUser } from '../auth/users';
import { parseRequestPart, respond, ZodPipe } from '../http/zod';
import { AdminUsersService } from './admin-users.service';
import { CashPaymentsService } from './cash-payments.service';
import { ActAsService } from './act-as.service';
import { AuditLogService } from './audit-log.service';
import { ExpensesService } from './expenses.service';
import { FinanceService } from './finance.service';
import { AdminSystemService } from './system.service';

const R = ADMIN_ROUTES;
type Out<T extends z.ZodType> = z.output<T>;

/**
 * ADMIN_ROUTES (ADR 0010): user management and the cash-payment ledger. BffKeyGuard first (the
 * admin app's server only), then AdminGuard (admins-pool token with `pwd` + `otp`, live session,
 * active account). The acting admin always
 * comes from the guard, never from the request. Request bodies (passwords) are never logged.
 */
@Controller()
@UseGuards(BffKeyGuard, AdminGuard)
export class AdminController {
  constructor(
    @Inject(AdminUsersService) private readonly users: AdminUsersService,
    @Inject(CashPaymentsService) private readonly cash: CashPaymentsService,
    @Inject(AdminSystemService) private readonly system: AdminSystemService,
    @Inject(ActAsService) private readonly actAs: ActAsService,
    @Inject(AuditLogService) private readonly auditLog: AuditLogService,
    @Inject(ExpensesService) private readonly expenses: ExpensesService,
    @Inject(FinanceService) private readonly finance: FinanceService,
  ) {}

  /** ADR 0018: a one-time link that opens the photographer's studio as them. Audited. */
  @Post(R.actAs.path)
  @HttpCode(R.actAs.status)
  async startActAs(
    @CurrentAdmin() admin: AppUser,
    @Param(new ZodPipe(R.actAs.params, 'params')) params: Out<typeof R.actAs.params>,
  ) {
    return respond(R.actAs.response, await this.actAs.start(admin.id, params.id));
  }

  /** ADR 0016: the overview tab. Read-only, so not audited. */
  @Get(R.system.path)
  @HttpCode(R.system.status)
  async getSystem() {
    return respond(R.system.response, await this.system.overview());
  }

  @Get(R.listUsers.path)
  @HttpCode(R.listUsers.status)
  async listUsers(
    @Query(new ZodPipe(R.listUsers.query, 'query')) query: Out<typeof R.listUsers.query>,
  ) {
    return respond(R.listUsers.response, await this.users.list(query));
  }

  @Post(R.createUser.path)
  @HttpCode(R.createUser.status)
  async createUser(
    @CurrentAdmin() admin: AppUser,
    @Body(new ZodPipe(R.createUser.body, 'body')) body: Out<typeof R.createUser.body>,
  ) {
    return respond(R.createUser.response, await this.users.create(admin.id, body));
  }

  @Get(R.getUser.path)
  @HttpCode(R.getUser.status)
  async getUser(
    @Param(new ZodPipe(R.getUser.params, 'params')) params: Out<typeof R.getUser.params>,
  ) {
    return respond(R.getUser.response, await this.users.get(params.id));
  }

  @Patch(R.updateUser.path)
  @HttpCode(R.updateUser.status)
  async updateUser(
    @CurrentAdmin() admin: AppUser,
    @Param(new ZodPipe(R.updateUser.params, 'params')) params: Out<typeof R.updateUser.params>,
    @Body(new ZodPipe(R.updateUser.body, 'body')) body: Out<typeof R.updateUser.body>,
  ) {
    return respond(R.updateUser.response, await this.users.update(admin.id, params.id, body));
  }

  @Post(R.resetPassword.path)
  @HttpCode(R.resetPassword.status)
  async resetPassword(
    @CurrentAdmin() admin: AppUser,
    @Param(new ZodPipe(R.resetPassword.params, 'params'))
    params: Out<typeof R.resetPassword.params>,
    @Body(new ZodPipe(R.resetPassword.body, 'body')) body: Out<typeof R.resetPassword.body>,
  ) {
    return respond(
      R.resetPassword.response,
      await this.users.resetPassword(admin.id, params.id, body.password),
    );
  }

  @Get(R.listCashPayments.path)
  @HttpCode(R.listCashPayments.status)
  async listCashPayments(
    @Query(new ZodPipe(R.listCashPayments.query, 'query'))
    query: Out<typeof R.listCashPayments.query>,
  ) {
    return respond(R.listCashPayments.response, await this.cash.list(query));
  }

  @Post(R.createCashPayment.path)
  @HttpCode(R.createCashPayment.status)
  async createCashPayment(
    @CurrentAdmin() admin: AppUser,
    @Req() req: Request,
    @Body(new ZodPipe(R.createCashPayment.body, 'body'))
    body: Out<typeof R.createCashPayment.body>,
  ) {
    const headers = parseRequestPart(R.createCashPayment.headers, 'headers', {
      [IDEMPOTENCY_KEY_HEADER]: req.headers[IDEMPOTENCY_KEY_HEADER],
    });
    return respond(
      R.createCashPayment.response,
      await this.cash.create(admin.id, headers[IDEMPOTENCY_KEY_HEADER], body),
    );
  }

  /** ADR 0027 §1: the audit log viewer. Read-only, so not audited. */
  @Get(R.auditLog.path)
  @HttpCode(R.auditLog.status)
  async listAuditLog(
    @Query(new ZodPipe(R.auditLog.query, 'query')) query: Out<typeof R.auditLog.query>,
  ) {
    return respond(R.auditLog.response, await this.auditLog.list(query));
  }

  @Get(R.listExpenses.path)
  @HttpCode(R.listExpenses.status)
  async listExpenses(
    @Query(new ZodPipe(R.listExpenses.query, 'query')) query: Out<typeof R.listExpenses.query>,
  ) {
    return respond(R.listExpenses.response, await this.expenses.list(query));
  }

  /** ADR 0027 §2: audited `finance.expense_created` in the same transaction. Not idempotent. */
  @Post(R.createExpense.path)
  @HttpCode(R.createExpense.status)
  async createExpense(
    @CurrentAdmin() admin: AppUser,
    @Body(new ZodPipe(R.createExpense.body, 'body')) body: Out<typeof R.createExpense.body>,
  ) {
    return respond(R.createExpense.response, await this.expenses.create(admin.id, body));
  }

  /** ADR 0027 §2: soft delete, audited `finance.expense_deleted`; again is a 204 no-op. */
  @Delete(R.deleteExpense.path)
  @HttpCode(R.deleteExpense.status)
  async deleteExpense(
    @CurrentAdmin() admin: AppUser,
    @Param(new ZodPipe(R.deleteExpense.params, 'params'))
    params: Out<typeof R.deleteExpense.params>,
  ): Promise<void> {
    await this.expenses.delete(admin.id, params.id);
  }

  /** ADR 0027 §3: income, expenses and profit over a range. Read-only. */
  @Get(R.finance.path)
  @HttpCode(R.finance.status)
  async getFinance(
    @Query(new ZodPipe(R.finance.query, 'query')) query: Out<typeof R.finance.query>,
  ) {
    return respond(R.finance.response, await this.finance.summary(query));
  }

  /** ADR 0027 §4: one photographer's orders, payments and estimated cost. Read-only. */
  @Get(R.userFinance.path)
  @HttpCode(R.userFinance.status)
  async getUserFinance(
    @Param(new ZodPipe(R.userFinance.params, 'params')) params: Out<typeof R.userFinance.params>,
  ) {
    return respond(R.userFinance.response, await this.finance.user(params.id));
  }
}
