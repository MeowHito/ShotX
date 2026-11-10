import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, MESSAGES, TIME_ZONE } from '@/i18n/config';
import { th } from '@/messages/th';
import { LoginButtons, type LoginButtonsProps } from './login-buttons';

function renderButtons(props: LoginButtonsProps) {
  return render(
    <NextIntlClientProvider
      locale={DEFAULT_LOCALE}
      messages={MESSAGES[DEFAULT_LOCALE]}
      timeZone={TIME_ZONE}
    >
      <LoginButtons {...props} />
    </NextIntlClientProvider>,
  );
}

describe('studio sign-in (ADR 0010)', () => {
  it('puts email + password first, says to ask the admin, and has no sign-up', () => {
    const { container } = renderButtons({
      options: { password: true, oidc: ['line', 'google'], devLogin: false },
      next: '/studio',
    });
    const email = screen.getByLabelText(th.login.email);
    const password = screen.getByLabelText(th.login.password);
    expect(email).toHaveAttribute('type', 'email');
    expect(email).toHaveAttribute('autocomplete', 'username');
    expect(password).toHaveAttribute('type', 'password');
    expect(password).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getByRole('button', { name: th.login.submit })).toBeInTheDocument();
    expect(screen.getByText(th.login.noAccount)).toBeInTheDocument();
    // No sign-up or "become a photographer" anywhere.
    expect(container.textContent).not.toMatch(/สมัคร|ทดลองใช้|เป็นช่างภาพ/);
    // LINE and Google stay, after the form and as secondary (outline) buttons.
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([th.login.line, th.login.google]);
    expect(screen.getByText(th.login.legacy)).toBeInTheDocument();
    const form = container.querySelector('form');
    expect(form?.compareDocumentPosition(links[0] as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(links[0]?.className).not.toContain('#06C755');
  });

  it('keeps the email form without LINE/Google when the API has none', () => {
    renderButtons({ options: { password: true, oidc: [], devLogin: false }, next: '/studio' });
    expect(screen.getByLabelText(th.login.email)).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    expect(screen.queryByText(th.login.noProviders)).toBeNull();
  });
});

describe('login choices', () => {
  it('shows LINE then Google as links to /auth/login, and no email sign-in', () => {
    renderButtons({
      options: { password: false, oidc: ['line', 'google'], devLogin: false },
      next: '/s/abc',
    });
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([th.login.line, th.login.google]);
    expect(links[0]).toHaveAttribute('href', '/auth/login?provider=line&next=%2Fs%2Fabc');
    expect(links[1]).toHaveAttribute('href', '/auth/login?provider=google&next=%2Fs%2Fabc');
    expect(screen.queryByText(/อีเมล/)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('hides a provider the API has no credentials for', () => {
    renderButtons({
      options: { password: false, oidc: ['google'], devLogin: false },
      next: '/studio',
    });
    expect(screen.queryByRole('link', { name: th.login.line })).toBeNull();
    expect(screen.getByRole('link', { name: th.login.google })).toBeInTheDocument();
  });

  it('offers the development form in local mode: a POST, so the email never lands in a URL', () => {
    const { container } = renderButtons({
      options: { password: false, oidc: [], devLogin: true },
      next: '/studio/trash',
    });
    const form = container.querySelector('form');
    expect(form).toHaveAttribute('method', 'post');
    expect(form).toHaveAttribute('action', '/auth/dev-login');
    expect(screen.getByLabelText(th.login.dev.email)).toHaveAttribute('name', 'email');
    expect(screen.getByLabelText(th.login.dev.name)).toHaveValue(th.login.dev.defaultName);
    expect(container.querySelector('input[name="next"]')).toHaveValue('/studio/trash');
    expect(screen.getByRole('button', { name: th.login.dev.submit })).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('says so when nothing is configured', () => {
    renderButtons({ options: { password: false, oidc: [], devLogin: false }, next: '/studio' });
    expect(screen.getByText(th.login.noProviders)).toBeInTheDocument();
  });
});
