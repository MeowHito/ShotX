import {
  type MyPackage,
  PACKAGE_ROUTES,
  type PackageKind,
  type PackageOffersResponse,
  packageTotal,
  type PublicPackage,
} from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { navigateTo } from '@/lib/browser/navigate';
import { PACKAGE_ORDER_PATHS } from '@/lib/packages/paths';
import { th } from '@/messages/th';
import { MyPackagePage } from './my-package-page';

// ADR 0032: the studio page to renew, or buy more days or photos.

vi.mock('@/lib/browser/navigate', () => ({ navigateTo: vi.fn() }));
const navigate = vi.mocked(navigateTo);

const NOW = new Date('2026-11-24T05:00:00.000Z');
const t = th.studio.myPackage;

function myPackage(overrides: Partial<MyPackage> = {}): MyPackage {
  return {
    code: 'd7',
    name: '7 Days',
    startsAt: '2026-11-20T05:00:00.000Z',
    expiresAt: '2026-11-27T05:00:00.000Z',
    photoLimit: 3000,
    photosUsed: 1200,
    expired: false,
    ...overrides,
  };
}

function offer(
  code: string,
  kind: PackageKind,
  days: number,
  photoLimit: number,
  price: number,
): PublicPackage {
  return {
    code,
    name: code,
    kind,
    days,
    photoLimit,
    featured: false,
    free: false,
    price: packageTotal(price, 700),
  };
}

const OFFERS: PackageOffersResponse = {
  packages: [
    offer('d3', 'plan', 3, 1000, 39_900),
    offer('d7', 'plan', 7, 3000, 59_900),
    offer('day1', 'days', 1, 0, 7_900),
    offer('day3', 'days', 3, 0, 19_900),
    offer('photo1000', 'photos', 0, 1000, 19_900),
  ],
  currency: 'THB',
  vatRateBasisPoints: 700,
  sales: { salesEnabled: true, featuredCode: 'd7', onlinePayment: true },
};

function renderPage(pkg: MyPackage | null, offers: PackageOffersResponse = OFFERS) {
  const fake = new FakeApi({ myPackage: pkg, packageOffers: offers });
  renderWithProviders(<MyPackagePage now={NOW} />, { api: apiClientFor(fake.fetch) });
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
  navigate.mockReset();
});

describe('my package page', () => {
  it('shows the package and the three kinds of offers', async () => {
    const fake = renderPage(myPackage());
    const current = await screen.findByTestId('current-package');
    expect(current).toHaveTextContent('แพ็กเกจ 7 Days');
    expect(current).toHaveTextContent('เหลือ 3 วัน');
    expect(current).toHaveTextContent('ใช้ไป 1,200 / 3,000 ภาพ');
    expect(current).toHaveTextContent('อัปโหลดได้อีก 1,800 ภาพ');

    for (const title of [t.daysTitle, t.photosTitle, t.plansTitle]) {
      expect(screen.getByRole('heading', { name: title, level: 2 })).toBeInTheDocument();
    }
    expect(screen.getByTestId('offer-day3')).toHaveTextContent('+3 วัน');
    expect(screen.getByTestId('offer-day3')).toHaveTextContent('฿199');
    expect(screen.getByTestId('offer-photo1000')).toHaveTextContent('+1,000 ภาพ');
    expect(screen.getByTestId('offer-d7')).toHaveTextContent('7 วัน · 3,000 ภาพ');
    expect(fake.callsTo(PACKAGE_ROUTES.offers)).toHaveLength(1);
  });

  it('expired: says so, and photos wait for days or a renewal', async () => {
    renderPage(myPackage({ expiresAt: '2026-11-23T05:00:00.000Z', expired: true }));
    const current = await screen.findByTestId('current-package');
    expect(current).toHaveAttribute('data-expired', 'true');
    expect(current).toHaveTextContent('หมดอายุเมื่อ');
    expect(screen.getByText(t.photosNeedDays)).toBeInTheDocument();
    const photos = screen.getByTestId('offer-photo1000');
    expect(within(photos).getByRole('button')).toBeDisabled();
    expect(within(screen.getByTestId('offer-day1')).getByRole('button')).toBeEnabled();
  });

  it('buying days opens the dialog for the account and goes to the pay page', async () => {
    const sent: { path: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        path: input as string,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      });
      return Promise.resolve(
        new Response(JSON.stringify({ redirectUrl: 'https://pay.example.com/d' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });
    renderPage(myPackage());
    const card = await screen.findByTestId('offer-day3');
    await userEvent.click(within(card).getByRole('button'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('ซื้อวันเพิ่ม · เพิ่ม 3 วัน · จำนวนภาพเท่าเดิม');
    // VAT on top: 199 + 13.93 = 212.93.
    expect(dialog).toHaveTextContent('฿212.93');
    expect(within(dialog).queryByLabelText(th.packageDialog.email)).toBeNull();
    await userEvent.click(within(dialog).getByRole('button', { name: th.packageDialog.pay }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://pay.example.com/d'));
    expect(sent).toEqual([{ path: PACKAGE_ORDER_PATHS.order, body: { packageCode: 'day3' } }]);
  });

  it('an unlimited account has nothing to buy', async () => {
    renderPage(null, { ...OFFERS, packages: [] });
    expect(await screen.findByText(t.unlimited)).toBeInTheDocument();
    expect(screen.queryByTestId('current-package')).toBeNull();
  });
});
