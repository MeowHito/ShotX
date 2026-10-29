'use client';

import {
  Button,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  SheetTitle,
} from '@shotx/ui';
import type { DriveItem, OwnerShare } from '@shotx/shared';
import { type LucideIcon, MoreVerticalIcon } from 'lucide-react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
  useRef,
  useState,
} from 'react';
import { PHONE_QUERY, useMediaQuery } from '@/components/studio/studio-context';
import { useLongPress } from '@/lib/studio/long-press';
import { useShares } from '@/lib/studio/queries';

/**
 * One menu definition for an item (or a selection), rendered three ways from the same entries:
 * the kebab (⋮) dropdown, the right-click context menu, and on phones a bottom sheet opened by
 * the kebab or a long-press. Radix gives both menus their keyboard behaviour (arrows, Enter,
 * Escape, submenus with → and ←).
 */
export type MenuEntry =
  | {
      type: 'item';
      id: string;
      label: string;
      icon: LucideIcon;
      /** A hint, e.g. ⌥⌘E, or the "soon" label for something not available yet. */
      hint?: string;
      disabled?: boolean;
      destructive?: boolean;
      onSelect: () => void;
    }
  | { type: 'link'; id: string; label: string; icon: LucideIcon; href: string }
  | { type: 'sub'; id: string; label: string; icon: LucideIcon; entries: MenuEntry[] }
  | { type: 'separator'; id: string };

/** Drops empty submenus and leading, trailing and doubled separators. */
export function tidyEntries(entries: MenuEntry[]): MenuEntry[] {
  const kept = entries
    .map((e) => (e.type === 'sub' ? { ...e, entries: tidyEntries(e.entries) } : e))
    .filter((e) => e.type !== 'sub' || e.entries.length > 0);
  return kept.filter(
    (e, i) =>
      e.type !== 'separator' || (i > 0 && i < kept.length - 1 && kept[i - 1]?.type !== 'separator'),
  );
}

interface MenuParts {
  Item: ComponentType<{
    onSelect?: (event: Event) => void;
    disabled?: boolean;
    variant?: 'default' | 'destructive';
    asChild?: boolean;
    children?: ReactNode;
  }>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{ children?: ReactNode }>;
  SubContent: ComponentType<{ children?: ReactNode; collisionPadding?: number }>;
  Separator: ComponentType<object>;
  Shortcut: ComponentType<{ children?: ReactNode }>;
}

const DROPDOWN: MenuParts = {
  Item: DropdownMenuItem,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
};

const CONTEXT: MenuParts = {
  Item: ContextMenuItem,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
};

function MenuEntries({ entries, parts }: { entries: MenuEntry[]; parts: MenuParts }) {
  const { Item, Sub, SubTrigger, SubContent, Separator, Shortcut } = parts;
  return (
    <>
      {entries.map((entry) => {
        switch (entry.type) {
          case 'separator':
            return <Separator key={entry.id} />;
          case 'link':
            return (
              <Item key={entry.id} asChild>
                <Link href={entry.href}>
                  <entry.icon aria-hidden />
                  {entry.label}
                </Link>
              </Item>
            );
          case 'sub':
            return (
              <Sub key={entry.id}>
                <SubTrigger>
                  <entry.icon aria-hidden />
                  {entry.label}
                </SubTrigger>
                <SubContent collisionPadding={12}>
                  <MenuEntries entries={entry.entries} parts={parts} />
                </SubContent>
              </Sub>
            );
          case 'item':
            return (
              <Item
                key={entry.id}
                disabled={entry.disabled}
                variant={entry.destructive ? 'destructive' : 'default'}
                onSelect={entry.onSelect}
              >
                <entry.icon aria-hidden />
                {entry.label}
                {entry.hint ? <Shortcut>{entry.hint}</Shortcut> : null}
              </Item>
            );
        }
      })}
    </>
  );
}

/** The phone rendering: every entry as a 48 px row, submenus as titled groups. */
function SheetEntries({ entries, onDone }: { entries: MenuEntry[]; onDone: () => void }) {
  const row =
    'flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left text-base outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45 [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-muted-foreground';
  return (
    <ul className="space-y-0.5">
      {entries.map((entry) => {
        switch (entry.type) {
          case 'separator':
            return <li key={entry.id} role="separator" className="my-1.5 h-px bg-border" />;
          case 'link':
            return (
              <li key={entry.id}>
                <Link href={entry.href} className={row} onClick={onDone}>
                  <entry.icon aria-hidden />
                  {entry.label}
                </Link>
              </li>
            );
          case 'sub':
            return (
              <li key={entry.id} role="group" aria-label={entry.label} className="pt-2">
                <p className="px-3 pb-1 text-xs font-medium text-muted-foreground">{entry.label}</p>
                <SheetEntries entries={entry.entries} onDone={onDone} />
              </li>
            );
          case 'item':
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  className={cn(
                    row,
                    entry.destructive && 'text-destructive [&_svg]:text-destructive',
                  )}
                  disabled={entry.disabled}
                  onClick={() => {
                    onDone();
                    entry.onSelect();
                  }}
                >
                  <entry.icon aria-hidden />
                  <span className="flex-1">{entry.label}</span>
                  {entry.hint ? (
                    <span aria-hidden className="text-xs text-muted-foreground">
                      {entry.hint}
                    </span>
                  ) : null}
                </button>
              </li>
            );
        }
      })}
    </ul>
  );
}

/**
 * Builds the entries for the items a menu acts on. `shares` are the single target's shares
 * (undefined while loading, or for a selection of several).
 */
export type BuildItemMenu = (targets: DriveItem[], shares: OwnerShare[] | undefined) => MenuEntry[];

const BuildItemMenuContext = createContext<BuildItemMenu>(() => []);

/** The page that shows items provides how their menus are built. */
export const ItemMenuProvider = BuildItemMenuContext.Provider;

/** Mounted only while a menu is open, so the shares query runs only then. */
function Entries({
  targets,
  render,
}: {
  targets: DriveItem[];
  render: (entries: MenuEntry[]) => ReactNode;
}) {
  const build = useContext(BuildItemMenuContext);
  const single = targets.length === 1 ? targets[0] : undefined;
  const shares = useShares(
    single === undefined
      ? null
      : single.kind === 'file'
        ? { fileId: single.id }
        : { folderId: single.id },
  );
  return render(
    tidyEntries(
      build(targets, single !== undefined && shares.isSuccess ? shares.items : undefined),
    ),
  );
}

/**
 * The menus of one item (or of the selection it belongs to: `targets`). `children` receives the
 * kebab button to place in the card.
 */
export function ItemMenus({
  label,
  title,
  targets,
  children,
}: {
  /** Accessible name of the kebab button. */
  label: string;
  /** Heading of the phone sheet (the item name, or the selection count). */
  title: string;
  targets: DriveItem[];
  children: (kebab: ReactNode) => ReactNode;
}) {
  const t = useTranslations('common');
  const phone = useMediaQuery(PHONE_QUERY);
  const [sheetOpen, setSheetOpen] = useState(false);
  const wrapper = useRef<HTMLDivElement>(null);
  const longPress = useLongPress((point) => {
    if (phone) {
      setSheetOpen(true);
      return;
    }
    // Tablets: open the context menu where the finger is, sooner than Radix's own 700 ms.
    wrapper.current?.dispatchEvent(
      new MouseEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
      }),
    );
  });

  const kebabClass =
    'size-11 rounded-full bg-background/85 shadow-sm backdrop-blur-sm sm:size-9 pointer-coarse:size-11 lg:opacity-0 lg:group-hover:opacity-100 lg:group-focus-within:opacity-100 lg:data-[state=open]:opacity-100 pointer-coarse:opacity-100';

  const kebab = phone ? (
    <Button
      variant="ghost"
      size="icon"
      className={kebabClass}
      aria-label={label}
      aria-haspopup="dialog"
      onClick={() => setSheetOpen(true)}
    >
      <MoreVerticalIcon aria-hidden />
    </Button>
  ) : (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className={kebabClass} aria-label={label}>
          <MoreVerticalIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={12}>
        <Entries
          targets={targets}
          render={(entries) => <MenuEntries entries={entries} parts={DROPDOWN} />}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild disabled={phone}>
          <div ref={wrapper} className="touch-menu h-full" {...longPress}>
            {children(kebab)}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent collisionPadding={12}>
          <Entries
            targets={targets}
            render={(entries) => <MenuEntries entries={entries} parts={CONTEXT} />}
          />
        </ContextMenuContent>
      </ContextMenu>
      {phone ? (
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="bottom" closeLabel={t('close')} aria-describedby={undefined}>
            <SheetTitle className="truncate pr-10 text-base font-semibold">{title}</SheetTitle>
            {sheetOpen ? (
              <Entries
                targets={targets}
                render={(entries) => (
                  <SheetEntries entries={entries} onDone={() => setSheetOpen(false)} />
                )}
              />
            ) : null}
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
}
