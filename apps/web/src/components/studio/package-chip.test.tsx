import { type MyPackage, PACKAGE_ROUTES, STUDIO_PACKAGE_PATH } from '@shotx/shared';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { DEFAULT_LOCALE, MESSAGES, TIME_ZONE } from '@/i18n/config';
import { th } from '@/messages/th';
import { ShareUnavailable } from '../share/share-gates';
import { PackageChip, PackageExpiredBanner } from './package-chip';
import { StudioShellView } from './studio-shell';

// ADR 0026: the package chip and expired banner in the studio, and the closed share page.

const NOW = new Date('2026-11-16T05:00:00.000Z');

function myPackage(overrides: Partial<MyPackage> = {}): MyPackage {
  return {
    code: 'd7',
    name: '7 Days',
    startsAt: '2026-11-14T05:00:00.000Z',
    // 4 days and 1 hour from NOW: a started day counts, so 5 days left.
    expiresAt: '2026-11-20T06:00:00.000Z',
    photoLimit: 3000,
    photosUsed: 1250,
    expired: false,
    ...overrides,
  };
}

function renderShell(fake: FakeApi) {
  return renderWithProviders(
    <StudioShellView pathname="/studio" user={null} onSearch={() => undefined}>
      <p>page content</p>
    </StudioShellView>,
    { api: apiClientFor(fake.fetch) },
  );
}

describe('package chip', () => {
  it('shows name, days left and photos used, with "renew" to the studio package page', async () => {
    const fake = new FakeApi({ myPackage: myPackage() });
    renderWithProviders(<PackageChip now={NOW} />, { api: apiClientFor(fake.fetch) });
    const chip = await screen.findByTestId('package-chip');
    expect(chip).toHaveTextContent('แพ็กเกจ 7 Days');
    expect(chip).toHaveTextContent('เหลือ 5 วัน');
    expect(chip).toHaveTextContent('ใช้ไป 1,250 / 3,000 ภาพ');
    expect(within(chip).getByRole('link', { name: th.studio.package.renew })).toHaveAttribute(
      'href',
      STUDIO_PACKAGE_PATH,
    );
    expect(fake.callsTo(PACKAGE_ROUTES.myPackage)).toHaveLength(1);
    expect(fake.callsTo(PACKAGE_ROUTES.myPackage)[0]?.prefix).toBe('/bff');
  });

  it('says expired once the package has run out', async () => {
    const fake = new FakeApi({
      myPackage: myPackage({ expiresAt: '2026-11-15T05:00:00.000Z', expired: true }),
    });
    renderWithProviders(<PackageChip now={NOW} />, { api: apiClientFor(fake.fetch) });
    const chip = await screen.findByTestId('package-chip');
    expect(chip).toHaveTextContent(th.studio.package.expired);
    expect(chip).toHaveAttribute('data-expired', 'true');
  });

  it('the tablet rail: an icon link to the packages, labelled with the whole summary', async () => {
    const fake = new FakeApi({ myPackage: myPackage() });
    renderWithProviders(<PackageChip compact now={NOW} />, { api: apiClientFor(fake.fetch) });
    const link = await screen.findByRole('link', {
      name: 'แพ็กเกจ 7 Days · เหลือ 5 วัน · ใช้ไป 1,250 / 3,000 ภาพ',
    });
    expect(link).toHaveAttribute('href', STUDIO_PACKAGE_PATH);
  });

  it('is in the studio aside and drawer; nothing at all for an unlimited account', async () => {
    const withPackage = renderShell(new FakeApi({ myPackage: myPackage() }));
    expect((await screen.findAllByTestId('package-chip')).length).toBeGreaterThan(0);
    withPackage.unmount();

    const fake = new FakeApi({ myPackage: null });
    renderShell(fake);
    await screen.findByText('page content');
    await new Promise((r) => setTimeout(r, 20));
    expect(fake.callsTo(PACKAGE_ROUTES.myPackage).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('package-chip')).toBeNull();
    expect(screen.queryByText(th.studio.package.expiredBanner)).toBeNull();
  });

  it('the studio shows the expired banner with "renew"', async () => {
    renderShell(new FakeApi({ myPackage: myPackage({ expired: true }) }));
    const banner = (await screen.findByText(th.studio.package.expiredBanner)).closest(
      '[role="alert"]',
    ) as HTMLElement;
    expect(within(banner).getByRole('link', { name: th.studio.package.renew })).toHaveAttribute(
      'href',
      STUDIO_PACKAGE_PATH,
    );
  });

  it('no banner while the package runs', async () => {
    const fake = new FakeApi({ myPackage: myPackage() });
    renderWithProviders(<PackageExpiredBanner />, { api: apiClientFor(fake.fetch) });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(th.studio.package.expiredBanner)).toBeNull();
  });
});

describe('share page of an expired package (reason plan_expired)', () => {
  it("says the link is closed for now, not expired, and doesn't ask for a new link", () => {
    render(
      <NextIntlClientProvider
        locale={DEFAULT_LOCALE}
        messages={MESSAGES[DEFAULT_LOCALE]}
        timeZone={TIME_ZONE}
      >
        <ShareUnavailable reason="plan_expired" />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('heading', { name: 'ลิงก์นี้ปิดชั่วคราว' })).toBeInTheDocument();
    expect(screen.getByText(th.share.unavailable.reasons.plan_expired)).toBeInTheDocument();
    expect(screen.queryByText(th.share.unavailable.body)).toBeNull();
  });
});
