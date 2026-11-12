'use client';

import {
  DESIGN_NAME_MAX_LENGTH,
  DESIGN_TEMPLATE_IDS,
  type DesignDoc,
  type DesignSummary,
  type DesignTemplateId,
  designNameSchema,
  designTemplateDoc,
  blankDesignDoc,
} from '@shotx/shared';
import {
  Alert,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
  Label,
} from '@shotx/ui';
import {
  CopyIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  StarIcon,
  StarOffIcon,
  Trash2Icon,
} from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { type FormEvent, useId, useMemo, useState } from 'react';
import { designHref } from '@/components/drive/paths';
import {
  assetUrls,
  useCreateDesign,
  useDeleteDesign,
  useDesigns,
  useSaveDesign,
  useSetDefaultDesign,
} from '@/lib/design/queries';
import { useErrorMessage } from '@/lib/errors/use-error-message';
import { DesignPreview } from './design-preview';

const CARD_PREVIEW_WIDTH = 150;
const PICKER_PREVIEW_WIDTH = 104;

/** A name cut to DESIGN_NAME_MAX_LENGTH characters (code points). */
function fitName(name: string): string {
  return [...name].slice(0, DESIGN_NAME_MAX_LENGTH).join('').trim();
}

/**
 * The share page designs tab (ADR 0013, /studio/designs): every design with a live mini preview; create
 * (template picker or blank), rename, duplicate, delete (confirmed), make or stop being the
 * default. The limits come from GET /designs. `onOpen` opens the editor of a new design.
 */
export function DesignsList({ onOpen }: { onOpen: (designId: string) => void }) {
  const t = useTranslations('designs');
  const tc = useTranslations('common');
  const describe = useErrorMessage();
  const designs = useDesigns();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<DesignSummary | null>(null);
  const [deleting, setDeleting] = useState<DesignSummary | null>(null);
  const [notice, setNotice] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);
  const create = useCreateDesign();
  const setDefault = useSetDefaultDesign();
  const assets = useMemo(() => assetUrls(designs.data?.assets ?? {}), [designs.data]);

  const limits = designs.data?.limits;
  const items = designs.data?.items ?? [];
  const full = limits !== undefined && items.length >= limits.maxDesigns;

  async function duplicate(design: DesignSummary) {
    setNotice(null);
    try {
      await create.mutateAsync({
        name: fitName(t('copyName', { name: design.name })),
        doc: design.doc,
      });
    } catch (err) {
      setNotice({ kind: 'error', text: describe(err) });
    }
  }

  async function toggleDefault(design: DesignSummary) {
    setNotice(null);
    try {
      await setDefault.mutateAsync({ id: design.id, isDefault: !design.isDefault });
    } catch (err) {
      setNotice({ kind: 'error', text: describe(err) });
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('intro')}</p>
          <p className="text-xs text-muted-foreground">{t('defaultHint')}</p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button onClick={() => setCreating(true)} disabled={designs.isPending || full}>
            <PlusIcon aria-hidden />
            {t('create')}
          </Button>
          {limits !== undefined ? (
            <span className="text-xs text-muted-foreground">
              {t('count', { count: items.length, max: limits.maxDesigns })}
            </span>
          ) : null}
        </div>
      </div>

      {full && limits !== undefined ? (
        <Alert variant="warning">{t('limitReached', { max: limits.maxDesigns })}</Alert>
      ) : null}
      {notice !== null ? (
        <Alert variant={notice.kind === 'error' ? 'destructive' : 'default'} role="status">
          {notice.text}
        </Alert>
      ) : null}

      {designs.isError ? (
        <Alert variant="destructive" className="flex items-center justify-between gap-2">
          <span>
            {t('loadError')}: {describe(designs.error)}
          </span>
          <Button size="sm" variant="outline" onClick={() => void designs.refetch()}>
            {tc('retry')}
          </Button>
        </Alert>
      ) : designs.isPending ? (
        <p role="status" className="text-muted-foreground">
          {tc('loading')}
        </p>
      ) : items.length === 0 ? (
        <div className="space-y-1 rounded-xl border-2 border-dashed p-8 text-center">
          <p className="font-medium">{t('empty')}</p>
          <p className="text-sm text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : (
        <ul
          aria-label={t('listLabel')}
          className="grid grid-cols-[repeat(auto-fill,minmax(10.5rem,1fr))] gap-4"
        >
          {items.map((design) => (
            <li key={design.id}>
              <DesignCard
                design={design}
                assets={assets}
                canDuplicate={!full}
                onRename={() => setRenaming(design)}
                onDuplicate={() => void duplicate(design)}
                onToggleDefault={() => void toggleDefault(design)}
                onDelete={() => setDeleting(design)}
              />
            </li>
          ))}
        </ul>
      )}

      <CreateDesignDialog open={creating} onOpenChange={setCreating} onCreated={onOpen} />
      <RenameDesignDialog design={renaming} onClose={() => setRenaming(null)} />
      <DeleteDesignDialog
        design={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => setNotice({ kind: 'info', text: t('deleted') })}
      />
    </div>
  );
}

function DesignCard({
  design,
  assets,
  canDuplicate,
  onRename,
  onDuplicate,
  onToggleDefault,
  onDelete,
}: {
  design: DesignSummary;
  assets: Record<string, string | null>;
  canDuplicate: boolean;
  onRename: () => void;
  onDuplicate: () => void;
  onToggleDefault: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations('designs');
  const format = useFormatter();
  return (
    <article
      className="group relative flex h-full flex-col gap-2 rounded-xl border bg-background p-2 shadow-card"
      aria-label={design.name}
    >
      <Link
        href={designHref(design.id)}
        className="flex justify-center overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label={t('previewOf', { name: design.name })}
      >
        <DesignPreview doc={design.doc} assets={assets} width={CARD_PREVIEW_WIDTH} />
      </Link>
      <div className="flex items-start gap-1 px-1">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium" title={design.name}>
            {design.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('updated', {
              date: format.dateTime(new Date(design.updatedAt), { dateStyle: 'medium' }),
            })}
          </p>
          {design.isDefault ? (
            <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
              <StarIcon className="size-3" aria-hidden />
              {t('defaultBadge')}
            </span>
          ) : null}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-9 shrink-0"
              aria-label={t('menu', { name: design.name })}
            >
              <MoreHorizontalIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href={designHref(design.id)}>
                <PencilIcon aria-hidden />
                {t('edit')}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onRename}>
              <PencilIcon aria-hidden />
              {t('rename')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onDuplicate} disabled={!canDuplicate}>
              <CopyIcon aria-hidden />
              {t('duplicate')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onToggleDefault}>
              {design.isDefault ? <StarOffIcon aria-hidden /> : <StarIcon aria-hidden />}
              {design.isDefault ? t('unsetDefault') : t('makeDefault')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onDelete} className="text-destructive">
              <Trash2Icon aria-hidden />
              {t('delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </article>
  );
}

type StartingPoint = DesignTemplateId | 'blank';

/** The template picker: blank or one of DESIGN_TEMPLATES, with live previews, and a name. */
function CreateDesignDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (designId: string) => void;
}) {
  const t = useTranslations('designs');
  const tc = useTranslations('common');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? (
        <DialogContent
          closeLabel={tc('close')}
          aria-describedby={undefined}
          className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
        >
          <DialogHeader>
            <DialogTitle>{t('picker.title')}</DialogTitle>
          </DialogHeader>
          <CreateDesignForm onDone={onOpenChange} onCreated={onCreated} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function CreateDesignForm({
  onDone,
  onCreated,
}: {
  onDone: (open: boolean) => void;
  onCreated: (designId: string) => void;
}) {
  const t = useTranslations('designs');
  const tc = useTranslations('common');
  const locale = useLocale();
  const describe = useErrorMessage();
  const create = useCreateDesign();
  const inputId = useId();
  const [choice, setChoice] = useState<StartingPoint>(DESIGN_TEMPLATE_IDS[0]);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const docs = useMemo(() => {
    const map = new Map<StartingPoint, DesignDoc>([['blank', blankDesignDoc()]]);
    for (const id of DESIGN_TEMPLATE_IDS) map.set(id, designTemplateDoc(id, locale));
    return map;
  }, [locale]);
  const options: StartingPoint[] = [...DESIGN_TEMPLATE_IDS, 'blank'];
  const label = (p: StartingPoint) => (p === 'blank' ? t('picker.blank') : t(`templates.${p}`));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const finalName = name.trim() === '' ? label(choice) : name;
    const parsed = designNameSchema.safeParse(finalName);
    if (!parsed.success) {
      setError(t('nameInvalid', { max: DESIGN_NAME_MAX_LENGTH }));
      return;
    }
    setError(null);
    try {
      const design = await create.mutateAsync(
        choice === 'blank'
          ? { name: parsed.data }
          : { name: parsed.data, templateId: choice, locale },
      );
      onDone(false);
      onCreated(design.id);
    } catch (err) {
      setError(describe(err));
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-medium">{t('picker.choose')}</legend>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-3">
          {options.map((p) => {
            const checked = choice === p;
            return (
              <label
                key={p}
                className={cn(
                  'flex cursor-pointer flex-col items-center gap-2 rounded-xl border p-2 text-center text-sm transition-colors',
                  checked ? 'border-primary ring-2 ring-primary' : 'hover:bg-accent/60',
                )}
              >
                <input
                  type="radio"
                  name={`${inputId}-template`}
                  value={p}
                  checked={checked}
                  onChange={() => setChoice(p)}
                  className="sr-only"
                />
                <span className="overflow-hidden rounded-lg border">
                  <DesignPreview
                    doc={docs.get(p) as DesignDoc}
                    assets={{}}
                    width={PICKER_PREVIEW_WIDTH}
                  />
                </span>
                <span className={cn(checked && 'font-semibold text-primary')}>{label(p)}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="grid gap-2">
        <Label htmlFor={`${inputId}-name`}>{t('nameLabel')}</Label>
        <Input
          id={`${inputId}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={label(choice)}
          maxLength={DESIGN_NAME_MAX_LENGTH}
          autoComplete="off"
        />
      </div>
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onDone(false)}>
          {tc('cancel')}
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {t('picker.create')}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RenameDesignDialog({
  design,
  onClose,
}: {
  design: DesignSummary | null;
  onClose: () => void;
}) {
  const t = useTranslations('designs');
  const tc = useTranslations('common');
  return (
    <Dialog open={design !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {design !== null ? (
        <DialogContent closeLabel={tc('close')} aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>{t('rename')}</DialogTitle>
          </DialogHeader>
          <RenameForm design={design} onClose={onClose} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}

function RenameForm({ design, onClose }: { design: DesignSummary; onClose: () => void }) {
  const t = useTranslations('designs');
  const tc = useTranslations('common');
  const describe = useErrorMessage();
  const save = useSaveDesign();
  const inputId = useId();
  const [name, setName] = useState(design.name);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = designNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(t('nameInvalid', { max: DESIGN_NAME_MAX_LENGTH }));
      return;
    }
    try {
      await save.mutateAsync({ ...design, name: parsed.data });
      onClose();
    } catch (err) {
      setError(describe(err));
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
      <div className="grid gap-2">
        <Label htmlFor={inputId}>{t('nameLabel')}</Label>
        <Input
          id={inputId}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={DESIGN_NAME_MAX_LENGTH}
          autoComplete="off"
          autoFocus
        />
      </div>
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {tc('cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {tc('save')}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeleteDesignDialog({
  design,
  onClose,
  onDeleted,
}: {
  design: DesignSummary | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const t = useTranslations('designs');
  const tc = useTranslations('common');
  const describe = useErrorMessage();
  const remove = useDeleteDesign();
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    if (design === null) return;
    try {
      await remove.mutateAsync(design.id);
      setError(null);
      onClose();
      onDeleted();
    } catch (err) {
      setError(describe(err));
    }
  }

  return (
    <Dialog
      open={design !== null}
      onOpenChange={(open) => {
        if (!open) {
          setError(null);
          onClose();
        }
      }}
    >
      {design !== null ? (
        <DialogContent closeLabel={tc('close')} role="alertdialog">
          <DialogHeader>
            <DialogTitle>{t('deleteTitle', { name: design.name })}</DialogTitle>
            <DialogDescription>{t('deleteBody')}</DialogDescription>
          </DialogHeader>
          {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              {tc('cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => void confirm()}
              disabled={remove.isPending}
            >
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
