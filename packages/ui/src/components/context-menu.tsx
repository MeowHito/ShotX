import { ChevronRightIcon } from 'lucide-react';
import { ContextMenu as ContextMenuPrimitive } from 'radix-ui';
import type * as React from 'react';
import { cn } from '../lib/cn';
import {
  menuContentClass,
  menuItemClass,
  menuLabelClass,
  menuSeparatorClass,
  menuShortcutClass,
} from './menu-styles';

/** Right-click (and long-press on touch) menu, styled like DropdownMenu. */
export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuGroup = ContextMenuPrimitive.Group;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

export function ContextMenuContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content className={cn(menuContentClass, className)} {...props} />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  variant?: 'default' | 'destructive';
}) {
  return (
    <ContextMenuPrimitive.Item
      data-variant={variant}
      className={cn(menuItemClass, className)}
      {...props}
    />
  );
}

export function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger>) {
  return (
    <ContextMenuPrimitive.SubTrigger className={cn(menuItemClass, className)} {...props}>
      {children}
      <ChevronRightIcon className="ml-auto" aria-hidden />
    </ContextMenuPrimitive.SubTrigger>
  );
}

export function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent className={cn(menuContentClass, className)} {...props} />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label>) {
  return <ContextMenuPrimitive.Label className={cn(menuLabelClass, className)} {...props} />;
}

export function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator>) {
  return (
    <ContextMenuPrimitive.Separator className={cn(menuSeparatorClass, className)} {...props} />
  );
}

export function ContextMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return <span aria-hidden className={cn(menuShortcutClass, className)} {...props} />;
}
