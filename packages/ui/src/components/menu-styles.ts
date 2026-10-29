/** Classes shared by DropdownMenu and ContextMenu, so both menus look and behave the same. */
export const menuContentClass =
  'z-50 min-w-56 animate-pop-in overflow-hidden rounded-xl border bg-popover p-1.5 text-popover-foreground shadow-float outline-none';

export const menuItemClass =
  'relative flex min-h-10 cursor-default items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm transition-colors duration-150 outline-none select-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-45 data-[state=open]:bg-accent data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground data-[variant=destructive]:[&_svg]:text-destructive';

export const menuSeparatorClass = '-mx-1.5 my-1.5 h-px bg-border';

export const menuLabelClass = 'px-2.5 py-1.5 text-xs font-medium text-muted-foreground';

export const menuShortcutClass =
  'ml-auto pl-6 text-xs tracking-wide text-muted-foreground tabular-nums';
