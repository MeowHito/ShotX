import { BILLING_ROUTES } from '@shotx/shared';
import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { FakeApi } from '../../../test/fake-api';
import { apiClientFor, renderWithProviders } from '../../../test/render';
import { createPublicApiClient } from '@/lib/api/client';
import { th } from '@/messages/th';
import { PricingTable } from './pricing-table';

describe('pricing cards', () => {
  it('highlights the recommended plan from config, and only that one', async () => {
    const fake = new FakeApi();
    const plans = await createPublicApiClient({ fetch: fake.fetch }).call(BILLING_ROUTES.plans);
    renderWithProviders(<PricingTable plans={plans} recommendedPlanCode="standard" />, {
      api: apiClientFor(fake.fetch),
    });
    const cards = within(screen.getByRole('list', { name: th.pricing.listLabel })).getAllByRole(
      'listitem',
    );
    const featured = cards.filter((c) => c.hasAttribute('data-featured'));
    expect(featured).toHaveLength(1);
    expect(featured[0]).toHaveTextContent(th.pricing.recommended);
    expect(featured[0]?.className).toContain('shadow-featured');
    // The others keep the badge's space but hide it from screen readers.
    expect(
      screen
        .getAllByText(th.pricing.recommended)
        .filter((e) => e.getAttribute('aria-hidden') !== 'true'),
    ).toHaveLength(1);
  });

  it('highlights nothing without a recommendation', async () => {
    const fake = new FakeApi();
    const plans = await createPublicApiClient({ fetch: fake.fetch }).call(BILLING_ROUTES.plans);
    const { container } = renderWithProviders(<PricingTable plans={plans} />, {
      api: apiClientFor(fake.fetch),
    });
    expect(container.querySelector('[data-featured]')).toBeNull();
  });
});
