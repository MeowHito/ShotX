import { packageTotal, type PackagesResponse, type PublicPackage } from '@shotx/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, MESSAGES, TIME_ZONE } from '@/i18n/config';
import { enStudio } from '@/messages/en-studio';
import { th } from '@/messages/th';
import { zhStudio } from '@/messages/zh-studio';
import { PackageFaq, uploadTypeLabels } from './package-faq';

// ADR 0027 §6: the home page's FAQ under the package cards, in the behaviour of ADR 0026.

const MiB = 1024 * 1024;
const LIMITS = { image: 100 * MiB, video: 5 * 1024 * MiB };

function pkg(code: string, name: string, priceSatang: number, vat = 700): PublicPackage {
  return {
    code,
    name,
    kind: 'plan',
    days: 7,
    photoLimit: 1000,
    featured: false,
    free: code === 'free',
    price: packageTotal(priceSatang, vat),
  };
}

function data(packages: PublicPackage[], vatRateBasisPoints = 700): PackagesResponse {
  return {
    packages,
    currency: 'THB',
    vatRateBasisPoints,
    sales: { salesEnabled: true, featuredCode: 'd7', onlinePayment: false },
  };
}

function renderIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider
      locale={DEFAULT_LOCALE}
      messages={MESSAGES[DEFAULT_LOCALE]}
      timeZone={TIME_ZONE}
    >
      {ui}
    </NextIntlClientProvider>,
  );
}

const faq = th.home.faq;

function item(question: string): HTMLDetailsElement {
  return screen.getByText(question).closest('details') as HTMLDetailsElement;
}

describe('PackageFaq', () => {
  it('shows the heading, lead and every question, only the first one open', () => {
    renderIntl(<PackageFaq data={data([])} maxBytes={LIMITS} />);
    expect(screen.getByRole('heading', { level: 2, name: faq.title })).toBeInTheDocument();
    expect(screen.getByText(faq.lead)).toBeInTheDocument();
    const questions = Object.values(faq.items).map((i) => i.question);
    const details = questions.map(item);
    expect(details.map((d) => d.open)).toEqual(questions.map((_, i) => i === 0));
    expect(within(details[0]!).getByText(faq.items.perAccount.answer)).toBeInTheDocument();
  });

  it('opens a closed item on tap', async () => {
    renderIntl(<PackageFaq data={data([])} maxBytes={LIMITS} />);
    const period = item(faq.items.period.question);
    expect(period.open).toBe(false);
    await userEvent.click(screen.getByText(faq.items.period.question));
    expect(period.open).toBe(true);
  });

  it('lists each paid package’s total with VAT from the API data, not Free', () => {
    renderIntl(
      <PackageFaq
        data={data([
          pkg('free', 'Free', 0),
          pkg('d3', '3 Days', 39_900),
          pkg('d30', '30 Days', 129_900),
        ])}
        maxBytes={LIMITS}
      />,
    );
    const vat = item(faq.items.vat.question);
    expect(vat).toHaveTextContent('ราคาบนการ์ดแพ็กเกจยังไม่รวม VAT 7%');
    const totals = within(vat)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(totals).toEqual(['3 Days ฿426.93', '30 Days ฿1,389.93']);
  });

  it('follows the API’s VAT rate and prices', () => {
    renderIntl(
      <PackageFaq data={data([pkg('d7', '7 Days', 50_000, 750)], 750)} maxBytes={LIMITS} />,
    );
    const vat = item(faq.items.vat.question);
    expect(vat).toHaveTextContent('VAT 7.5%');
    expect(within(vat).getByRole('listitem')).toHaveTextContent('7 Days ฿537.50');
  });

  it('names no amounts when the packages could not be loaded', () => {
    renderIntl(<PackageFaq data={null} maxBytes={LIMITS} />);
    const vat = item(faq.items.vat.question);
    expect(vat).toHaveTextContent(faq.items.vat.answerNoData);
    expect(within(vat).queryByRole('listitem')).toBeNull();
  });

  it('shows the upload allowlist and the per-file limits of the upload config', () => {
    renderIntl(<PackageFaq data={data([])} maxBytes={LIMITS} />);
    expect(item(faq.items.files.question)).toHaveTextContent(
      'รูปภาพ JPEG, PNG, WEBP ไฟล์ละไม่เกิน 100 MB และวิดีโอ MP4, MOV ไฟล์ละไม่เกิน 5 GB',
    );
  });

  it('says the size is checked before upload when the limits are unknown', () => {
    renderIntl(<PackageFaq data={data([])} maxBytes={null} />);
    expect(item(faq.items.files.question)).toHaveTextContent(
      'รูปภาพ JPEG, PNG, WEBP และวิดีโอ MP4, MOV ระบบจะแจ้งก่อนอัปโหลดถ้าไฟล์ใหญ่เกิน',
    );
  });

  it('has no draft wording, and the same questions in every language', () => {
    const texts = JSON.stringify(faq);
    expect(texts).not.toMatch(/ข้อเสนอ|ฉบับร่าง|รอทีมกำหนด|ยังต้องกำหนด/);
    for (const messages of [enStudio, zhStudio]) {
      expect(Object.keys(messages.home.faq.items)).toEqual(Object.keys(faq.items));
    }
  });
});

describe('uploadTypeLabels', () => {
  it('names the allowlist by kind', () => {
    expect(uploadTypeLabels('image')).toBe('JPEG, PNG, WEBP');
    expect(uploadTypeLabels('video')).toBe('MP4, MOV');
  });
});
