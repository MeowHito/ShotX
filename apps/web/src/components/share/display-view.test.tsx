import { designDisplayTemplateDoc, designTemplateDoc, PUBLIC_SHARE_ROUTES } from '@shotx/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeApi, shareItem } from '../../../test/fake-api';
import { renderDisplayPage } from '../../../test/share-harness';
import { th } from '@/messages/th';

const shownPhoto = () =>
  screen.getAllByTestId('latest-photo').find((img) => img.dataset.current === 'true');

describe('event screen /{ref}/display (ADR 0033)', () => {
  it('shows the built-in screen: the event name, the newest photo and the link QR', async () => {
    const fake = new FakeApi();
    const newest = shareItem('newest.jpg');
    const share = fake.addPublicShare({
      title: 'Chiangmai Thailand by UTMB',
      items: [newest, shareItem('older.jpg')],
      design: { doc: designTemplateDoc('pastel-glow'), assets: {} },
    });
    renderDisplayPage(fake, share.token);

    expect(await screen.findByRole('region', { name: th.share.display.label })).toBeVisible();
    // The built-in screen takes the share page design's background and the event name.
    expect(screen.getByText('Chiangmai Thailand by UTMB')).toBeInTheDocument();
    await waitFor(() => expect(shownPhoto()?.getAttribute('src')).toBe(newest.previewUrl));
    // One photo (count 1): only the newest.
    expect(screen.getAllByTestId('latest-photo')).toHaveLength(1);
    // The QR code of the share's own page (never the /display page).
    expect(screen.getByRole('img', { name: th.share.design.qr })).toBeInTheDocument();
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.display).length).toBeGreaterThan(0);
  });

  it('uses the chosen display design and cycles through its newest photos', async () => {
    const fake = new FakeApi();
    const doc = designDisplayTemplateDoc('display-clean');
    const photos = doc.elements.map((e) =>
      e.type === 'latestPhotos' ? { ...e, count: 3, intervalSec: 2 } : e,
    );
    const items = [shareItem('1.jpg'), shareItem('2.jpg'), shareItem('3.jpg'), shareItem('4.jpg')];
    const share = fake.addPublicShare({
      items,
      displayDesign: { doc: { ...doc, elements: photos }, assets: {} },
    });
    renderDisplayPage(fake, share.token);
    await waitFor(() => expect(screen.getAllByTestId('latest-photo')).toHaveLength(3));
    expect(shownPhoto()?.getAttribute('src')).toBe(items[0]?.previewUrl);
    expect(screen.getByText(/สแกนหาภาพ/)).toBeInTheDocument();
  });

  it('shows no photos for a scan-only share', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = fake.addPublicShare({ mode: 'face_only', faceSearchAvailable: true });
    renderDisplayPage(fake, share.token);
    expect(await screen.findByRole('region', { name: th.share.display.label })).toBeVisible();
    await waitFor(() =>
      expect(fake.callsTo(PUBLIC_SHARE_ROUTES.display).length).toBeGreaterThan(0),
    );
    expect(screen.queryAllByTestId('latest-photo')).toHaveLength(0);
  });

  it('asks for the password first on a locked share', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare({ password: 'pin-1234' });
    renderDisplayPage(fake, share.token);
    const input = await screen.findByLabelText(th.share.password.label);
    await userEvent.type(input, 'pin-1234');
    await userEvent.click(screen.getByRole('button', { name: th.share.password.submit }));
    expect(await screen.findByRole('region', { name: th.share.display.label })).toBeVisible();
  });
});
