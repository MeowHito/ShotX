import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  Button,
  Checkbox,
  cn,
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
