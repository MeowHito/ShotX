'use client';

import { type AuditAction, type AuditLogEntry, idSchema, isAuditAction } from '@shotx/shared';
import { Alert, Button, Input, Label, Skeleton } from '@shotx/ui';
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { type FormEvent, Fragment, useId, useMemo, useState } from 'react';
import { NativeSelect } from '@/components/ui/select';
import { userDetailHref } from '@/components/users/users-table';
import {
  actionFilterOf,
  AUDIT_GROUP_IDS,
  AUDIT_GROUPS,
  type AuditGroup,
  auditActionLabel,
  auditLabelKey,
} from '@/lib/audit/labels';
import { type AuditFilters, useAuditLog } from '@/lib/audit/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { useFormat } from '@/lib/i18n/use-format';

const KNOWN_TARGET_TYPES = [
  'user',
  'admin_login',
  'photographer_login',
  'cash_payment',
  'package_order',
  'expense',
] as const;
type KnownTargetType = (typeof KNOWN_TARGET_TYPES)[number];

const isKnownTargetType = (type: string): type is KnownTargetType =>
  (KNOWN_TARGET_TYPES as readonly string[]).includes(type);

interface Draft {
  group: AuditGroup | '';
  action: AuditAction | '';
  actorId: string;
  targetId: string;
  from: string;
  to: string;
}

const EMPTY: Draft = { group: '', action: '', actorId: '', targetId: '', from: '', to: '' };

/** The query of a draft, or the field that is wrong. */
export function auditFiltersOf(
  draft: Draft,
): { ok: true; filters: AuditFilters } | { ok: false; problem: 'actor' | 'order' } {
  const actorId = draft.actorId.trim();
  const targetId = draft.targetId.trim();
  if (actorId !== '' && !idSchema.safeParse(actorId).success)
    return { ok: false, problem: 'actor' };
  if (draft.from !== '' && draft.to !== '' && draft.from > draft.to) {
    return { ok: false, problem: 'order' };
  }
  const action = actionFilterOf(
    draft.group === '' ? null : draft.group,
    draft.action === '' ? null : draft.action,
  );
  return {
    ok: true,
    filters: {
      ...(action !== undefined ? { action } : {}),
      ...(actorId !== '' ? { actorId } : {}),
      ...(targetId !== '' ? { targetId: targetId.slice(0, 255) } : {}),
      ...(draft.from !== '' ? { from: draft.from } : {}),
      ...(draft.to !== '' ? { to: draft.to } : {}),
    },
  };
}

/**
 * "บันทึกกิจกรรม" (ADR 0027 §1): the audit log newest first, with filters (action group or exact
 * action, actor, target, Bangkok days) and cursor "load more". Every known action has a label in
 * the UI language; an action outside AUDIT_ACTIONS shows as stored. A null actor is "ระบบ"; user
 * actors and targets link to their user page. `meta` is shown raw on expand (it never holds
 * secrets, by the earlier ADRs).
 */
export function AuditLogPage() {
  const t = useTranslations('auditLog');
  const tc = useTranslations('common');
  const errorMessage = useErrorMessage();
  const format = useFormat();
  const id = useId();

  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [filters, setFilters] = useState<AuditFilters>({});
  const [problem, setProblem] = useState<'actor' | 'order' | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const list = useAuditLog(filters);
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const filtered = Object.keys(filters).length > 0;
  const groupActions: readonly AuditAction[] =
    draft.group === ''
      ? AUDIT_GROUP_IDS.flatMap((g) => AUDIT_GROUPS[g].actions)
      : AUDIT_GROUPS[draft.group].actions;

  const label = (action: string) => auditActionLabel(action, (key) => t(`actions.${key}`));

  function submit(event: FormEvent) {
    event.preventDefault();
    const result = auditFiltersOf(draft);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setProblem(null);
    setExpanded(new Set());
    setFilters(result.filters);
  }

  function clear() {
    setDraft(EMPTY);
    setProblem(null);
    setExpanded(new Set());
    setFilters({});
  }

  function toggle(entryId: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }

  return (
    <div className="min-w-0 space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl">{t('title')}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t('description')}</p>
      </div>

      <form
        role="search"
        aria-label={t('filters.label')}
        onSubmit={submit}
        noValidate
        className="flex flex-wrap items-end gap-3 rounded-xl border bg-sidebar p-3"
      >
        <div className="w-full space-y-1 min-[420px]:w-44">
          <Label htmlFor={`${id}-group`}>{t('filters.group')}</Label>
          <NativeSelect
            id={`${id}-group`}
            value={draft.group}
            onChange={(e) => {
              const group = e.target.value as AuditGroup | '';
              setDraft((d) => ({
                ...d,
                group,
                // An exact action outside the new group no longer applies.
                action:
                  d.action !== '' &&
                  group !== '' &&
                  !(AUDIT_GROUPS[group].actions as readonly string[]).includes(d.action)
                    ? ''
                    : d.action,
              }));
            }}
          >
            <option value="">{t('filters.allGroups')}</option>
            {AUDIT_GROUP_IDS.map((g) => (
              <option key={g} value={g}>
                {t(`groups.${g}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="w-full space-y-1 min-[420px]:w-64">
          <Label htmlFor={`${id}-action`}>{t('filters.action')}</Label>
          <NativeSelect
            id={`${id}-action`}
            value={draft.action}
            onChange={(e) =>
              setDraft((d) => ({ ...d, action: e.target.value as AuditAction | '' }))
            }
          >
            <option value="">{t('filters.allActions')}</option>
            {groupActions.map((a) => (
              <option key={a} value={a}>
                {t(`actions.${auditLabelKey(a)}`)}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="w-full space-y-1 min-[420px]:w-56">
          <Label htmlFor={`${id}-actor`}>{t('filters.actor')}</Label>
          <Input
            id={`${id}-actor`}
            className="h-10 font-mono text-xs"
            placeholder={t('filters.idPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            value={draft.actorId}
            aria-invalid={problem === 'actor' ? true : undefined}
            onChange={(e) => setDraft((d) => ({ ...d, actorId: e.target.value }))}
          />
        </div>
        <div className="w-full space-y-1 min-[420px]:w-56">
          <Label htmlFor={`${id}-target`}>{t('filters.target')}</Label>
          <Input
            id={`${id}-target`}
            className="h-10 font-mono text-xs"
            placeholder={t('filters.idPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            maxLength={255}
            value={draft.targetId}
            onChange={(e) => setDraft((d) => ({ ...d, targetId: e.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-from`}>{t('filters.from')}</Label>
          <Input
            id={`${id}-from`}
            type="date"
            className="h-10 w-40"
            value={draft.from}
            aria-invalid={problem === 'order' ? true : undefined}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-to`}>{t('filters.to')}</Label>
          <Input
            id={`${id}-to`}
            type="date"
            className="h-10 w-40"
            value={draft.to}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
          />
        </div>
        <div className="flex gap-2">
          <Button type="submit">{t('filters.apply')}</Button>
          {filtered ? (
            <Button type="button" variant="ghost" onClick={clear}>
              {t('filters.clear')}
            </Button>
          ) : null}
        </div>
        {problem !== null ? (
          <p role="alert" className="w-full text-sm text-destructive">
            {problem === 'actor' ? t('filters.invalidActor') : t('filters.order')}
          </p>
        ) : null}
      </form>

      {list.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-label={tc('loading')}>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : list.isError && items.length === 0 ? (
        <Alert variant="destructive">
          <p>
            {t('loadError')}: {errorMessage(list.error)}
          </p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void list.refetch()}>
            {tc('retry')}
          </Button>
        </Alert>
      ) : items.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border bg-background shadow-card">
            <table className="w-full min-w-[56rem] text-left text-sm">
              <caption className="sr-only">{t('tableLabel')}</caption>
              <thead className="border-b bg-sidebar text-xs text-muted-foreground">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('columns.time')}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('columns.action')}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('columns.actor')}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('columns.target')}
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    {t('columns.meta')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <AuditRow
                    key={entry.id}
                    entry={entry}
                    label={label(entry.action)}
                    known={isAuditAction(entry.action)}
                    time={format.dateTime(entry.createdAt)}
                    open={expanded.has(entry.id)}
                    onToggle={() => toggle(entry.id)}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {list.hasNextPage ? (
            <div className="flex justify-center">
              <Button
                variant="outline"
                onClick={() => void list.fetchNextPage()}
                disabled={list.isFetchingNextPage}
              >
                {list.isFetchingNextPage ? t('loadingMore') : t('loadMore')}
              </Button>
            </div>
          ) : null}
          {list.isFetchNextPageError ? (
            <Alert variant="destructive">{errorMessage(list.error)}</Alert>
          ) : null}
        </>
      )}
    </div>
  );
}

const linkClass =
  'break-all underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

function AuditRow({
  entry,
  label,
  known,
  time,
  open,
  onToggle,
}: {
  entry: AuditLogEntry;
  label: string;
  known: boolean;
  time: string;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations('auditLog');
  const metaId = `audit-meta-${entry.id}`;
  const hasMeta = Object.keys(entry.meta).length > 0;
  const targetType = isKnownTargetType(entry.targetType)
    ? t(`targetTypes.${entry.targetType}`)
    : entry.targetType;
  return (
    <Fragment>
      <tr className="border-t align-top first:border-t-0" data-testid="audit-row">
        <td className="px-4 py-3 whitespace-nowrap tabular-nums">{time}</td>
        <td className="px-4 py-3">
          <div className="font-medium">{label}</div>
          {known ? (
            <div className="font-mono text-xs text-muted-foreground">{entry.action}</div>
          ) : null}
        </td>
        <td className="px-4 py-3">
          {entry.actorId === null ? (
            <span className="text-muted-foreground">{t('system')}</span>
          ) : (
            <Link href={userDetailHref(entry.actorId)} className={linkClass}>
              {entry.actorEmail ?? entry.actorId}
            </Link>
          )}
        </td>
        <td className="px-4 py-3">
          <div className="text-xs text-muted-foreground">{targetType}</div>
          {entry.targetType === 'user' && idSchema.safeParse(entry.targetId).success ? (
            <Link href={userDetailHref(entry.targetId)} className={linkClass}>
              {entry.targetEmail ?? entry.targetId}
            </Link>
          ) : (
            <span className="font-mono text-xs break-all">{entry.targetId}</span>
          )}
        </td>
        <td className="px-4 py-2">
          {hasMeta ? (
            <Button
              variant="ghost"
              size="sm"
              aria-expanded={open}
              aria-controls={metaId}
              onClick={onToggle}
            >
              {open ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
              {open ? t('hideMeta') : t('showMeta')}
            </Button>
          ) : (
            <span className="text-xs text-muted-foreground">{t('noMeta')}</span>
          )}
        </td>
      </tr>
      {open && hasMeta ? (
        <tr id={metaId}>
          <td colSpan={5} className="bg-sidebar px-4 pb-3">
            <pre className="max-h-80 overflow-auto rounded-lg border bg-background p-3 font-mono text-xs whitespace-pre-wrap break-all">
              {JSON.stringify(entry.meta, null, 2)}
            </pre>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}
