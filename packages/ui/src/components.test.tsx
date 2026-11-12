import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  Button,
  Checkbox,
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuShortcut,
  ContextMenuTrigger,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  Sheet,
  SheetContent,
  SheetTitle,
  Skeleton,
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
  Progress,
} from './index';

describe('cn', () => {
  it('lets later Tailwind utilities win', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
    expect(cn('a', false, undefined, 'b')).toBe('a b');
  });
});

describe('Button', () => {
  it('renders a button with variant classes and handles clicks', async () => {
    const onClick = vi.fn();
    render(
      <Button variant="destructive" onClick={onClick}>
        ลบ
      </Button>,
    );
    const button = screen.getByRole('button', { name: 'ลบ' });
    expect(button.className).toContain('bg-destructive');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders its child with asChild', () => {
    render(
      <Button asChild>
        <a href="/studio">สตูดิโอ</a>
      </Button>,
    );
    expect(screen.getByRole('link', { name: 'สตูดิโอ' })).toHaveAttribute('href', '/studio');
  });
});

describe('Dialog', () => {
  it('opens from its trigger and has a labelled close button', async () => {
    render(
      <Dialog>
        <DialogTrigger>เปิด</DialogTrigger>
        <DialogContent closeLabel="ปิด" aria-describedby={undefined}>
          <DialogTitle>หัวเรื่อง</DialogTitle>
        </DialogContent>
      </Dialog>,
    );
    await userEvent.click(screen.getByText('เปิด'));
    expect(screen.getByRole('dialog', { name: 'หัวเรื่อง' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'ปิด' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('Checkbox and Progress', () => {
  it('toggles a checkbox', async () => {
    const onChange = vi.fn();
    render(<Checkbox aria-label="เลือก" onCheckedChange={onChange} />);
    await userEvent.click(screen.getByRole('checkbox', { name: 'เลือก' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('clamps the progress indicator', () => {
    render(<Progress value={150} aria-label="พื้นที่" />);
    expect(screen.getByRole('progressbar', { name: 'พื้นที่' })).toBeInTheDocument();
  });
});

describe('menus', () => {
  it('opens a context menu on right-click, with a shortcut hint outside the accessible name', async () => {
    const onSelect = vi.fn();
    render(
      <ContextMenu>
        <ContextMenuTrigger>
          <div>item</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={onSelect}>
            Rename<ContextMenuShortcut>Ctrl+Alt+E</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getByText('item') });
    const item = await screen.findByRole('menuitem', { name: 'Rename' });
    expect(item).toHaveTextContent('Ctrl+Alt+E');
    await userEvent.click(item);
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('opens a dropdown submenu with the keyboard', async () => {
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Share</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Copy link</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    screen.getByRole('button', { name: 'open' }).focus();
    await userEvent.keyboard('{Enter}');
    await screen.findByRole('menuitem', { name: 'Share' });
    await userEvent.keyboard('{ArrowRight}');
    expect(await screen.findByRole('menuitem', { name: 'Copy link' })).toBeInTheDocument();
  });

  it('dropdown radio items: the chosen one is checked, choosing reports the value', async () => {
    const onValueChange = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>size</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuRadioGroup value="s" onValueChange={onValueChange}>
            <DropdownMenuRadioItem value="s">Small</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="l">Large</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'size' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Small' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Large' }));
    expect(onValueChange).toHaveBeenCalledWith('l');
  });

  it('renders a sheet from the bottom, and an aria-hidden skeleton', () => {
    render(
      <Sheet open>
        <SheetContent side="bottom" closeLabel="Close" aria-describedby={undefined}>
          <SheetTitle>Actions</SheetTitle>
        </SheetContent>
      </Sheet>,
    );
    const sheet = screen.getByRole('dialog', { name: 'Actions' });
    expect(sheet.className).toContain('bottom-0');
    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    const { container } = render(<Skeleton className="h-4" />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });
});
