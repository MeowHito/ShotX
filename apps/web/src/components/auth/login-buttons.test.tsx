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

describe('login choices', () => {
  it('shows LINE then Google as links to /auth/login, and no email sign-in', () => {
    renderButtons({ options: { oidc: ['line', 'google'], devLogin: false }, next: '/s/abc' });
    const links = screen.getAllByRole('link');
    expect(links.map((l) => l.textContent)).toEqual([th.login.line, th.login.google]);
    expect(links[0]).toHaveAttribute('href', '/auth/login?provider=line&next=%2Fs%2Fabc');
    expect(links[1]).toHaveAttribute('href', '/auth/login?provider=google&next=%2Fs%2Fabc');
    expect(screen.queryByText(/อีเมล/)).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('hides a provider the API has no credentials for', () => {
    renderButtons({ options: { oidc: ['google'], devLogin: false }, next: '/studio' });
    expect(screen.queryByRole('link', { name: th.login.line })).toBeNull();
    expect(screen.getByRole('link', { name: th.login.google })).toBeInTheDocument();
  });

  it('offers the development form in local mode: a POST, so the email never lands in a URL', () => {
    const { container } = renderButtons({
      options: { oidc: [], devLogin: true },
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
    renderButtons({ options: { oidc: [], devLogin: false }, next: '/studio' });
    expect(screen.getByText(th.login.noProviders)).toBeInTheDocument();
  });
});
