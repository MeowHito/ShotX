import {
  LATEST_CONSENT_POLICY_VERSION,
  PUBLIC_SHARE_ROUTES,
  type ShareMetaDesign,
  designTemplateDoc,
} from '@shotx/shared';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeApi, MEDIA, type PublicShareFixture } from '../../../test/fake-api';
import { fakeNavigator, renderSharePage } from '../../../test/share-harness';
import { th } from '@/messages/th';

vi.mock('photoswipe', () => ({
  default: class {
    on() {}
    init() {}
    destroy() {}
  },
}));

/** IntersectionObserver stand-in: tests say when the watched element is on screen. */
const observers = vi.hoisted(() => ({
  list: [] as { callback: IntersectionObserverCallback; elements: Element[] }[],
}));

/** The observers watching the card's scan buttons. */
const buttonObservers = () =>
  observers.list.filter((o) =>
    o.elements.some((el) => el.getAttribute('data-element-type') === 'scanButtons'),
  );

async function setOnScreen(visible: boolean) {
  await waitFor(() => expect(buttonObservers().length).toBeGreaterThan(0));
  act(() => {
    for (const o of buttonObservers()) {
      const entries = o.elements.map(
        (target) => ({ target, isIntersecting: visible }) as IntersectionObserverEntry,
      );
      o.callback(entries, {} as IntersectionObserver);
    }
  });
}

const originalWidth = window.innerWidth;

beforeAll(() => {
  // A phone (ADR 0013: mobile first): 390 x 844.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 844 });
  window.dispatchEvent(new Event('resize'));
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  URL.createObjectURL = () => 'blob:selfie';
  URL.revokeObjectURL = () => undefined;
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { get: () => 1280 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { get: () => 960 });
  globalThis.IntersectionObserver = class {
    private entry: { callback: IntersectionObserverCallback; elements: Element[] };
    constructor(callback: IntersectionObserverCallback) {
      this.entry = { callback, elements: [] };
      observers.list.push(this.entry);
    }
    observe(el: Element) {
      this.entry.elements.push(el);
    }
    unobserve() {}
    disconnect() {
      this.entry.elements = [];
    }
    takeRecords() {
      return [];
    }
  } as unknown as typeof IntersectionObserver;
});

afterAll(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
});

beforeEach(() => {
  observers.list.length = 0;
});

function designFor(locale: 'th' | 'en' = 'th'): ShareMetaDesign {
  const doc = designTemplateDoc('pastel-glow', locale);
  return { doc, assets: {} };
}

function designedShare(fake: FakeApi, extra: Partial<PublicShareFixture> = {}) {
  const share = fake.addPublicShare({
    faceSearchAvailable: true,
    itemCount: 4,
    design: designFor(),
    ...extra,
  });
  const [a, b] = share.items;
  share.faceMatches = { strong: [a?.id ?? ''], maybe: [b?.id ?? ''] };
  return share;
}

const policy = th.consent.policies.face_search[LATEST_CONSENT_POLICY_VERSION];

describe('share page with a design (ADR 0013), phone viewport', () => {
  it('the designed card replaces the title and cover; the photos follow below in gallery mode', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = designedShare(fake);
    renderSharePage(fake, share.token);

    const card = await screen.findByRole('region', { name: th.share.design.label });
    // The template's own text, as text.
    expect(within(card).getByText('ชื่องานของคุณ')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: th.share.design.camera })).toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: th.share.design.choosePhoto }),
    ).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: th.share.design.help })).toBeInTheDocument();
    // No event title or cover (the design is the header).
    expect(screen.queryByRole('heading', { level: 1, name: share.title })).toBeNull();
    expect(screen.queryByTestId('share-cover')).toBeNull();
    // The top bar stays above the card; the photos come after it.
    const nav = screen.getByRole('navigation', { name: th.publicNav.label });
    expect(nav.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const grid = await screen.findByRole('list', { name: th.share.galleryLabel });
    expect(card.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Full-screen first screen: the viewport under the top bar, less the "scroll down for all
    // photos" strip that tells viewers the photos are below (ADR 0019).
    expect(card.className).toContain('min-h-[calc(100svh-3.5rem)]');
    // The top bar floats over the design, transparent (owner, 2026-11-13: it hid the logo).
    expect(nav.closest('header')).toHaveAttribute('data-overlay', 'clear');
    expect(nav.closest('header')).toHaveClass('fixed', 'bg-transparent');
    const seeAll = screen.getByRole('button', { name: th.share.design.seeAll });
    expect(card.compareDocumentPosition(seeAll) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(seeAll.compareDocumentPosition(grid) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('hides the sticky face-search button while the card’s buttons are on screen', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = designedShare(fake);
    renderSharePage(fake, share.token);
    await screen.findByRole('region', { name: th.share.design.label });
    // The card's buttons do the same: no second button.
    expect(screen.queryAllByRole('button', { name: th.share.scan })).toHaveLength(0);
    await setOnScreen(false);
    expect(await screen.findByRole('button', { name: th.share.scan })).toBeInTheDocument();
    await setOnScreen(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: th.share.scan })).toBeNull());
  });

  it('"take a selfie" records the consent, then opens the live camera (ADR 0015)', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = designedShare(fake);
    const { nav, getUserMedia } = fakeNavigator();
    renderSharePage(fake, share.token, { nav });
    await userEvent.click(await screen.findByRole('button', { name: th.share.design.camera }));
    expect(await screen.findByRole('button', { name: th.capture.takePhoto })).toBeInTheDocument();
    // No consent text to read; the consent row is written before the camera starts.
    expect(screen.queryByRole('heading', { name: policy.title })).toBeNull();
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.giveConsent)).toHaveLength(1);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it('"use a photo" opens the phone\'s picker itself; the picked photo is searched at once (after consent)', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = designedShare(fake);
    const { nav, getUserMedia } = fakeNavigator();
    renderSharePage(fake, share.token, { nav });
    const button = await screen.findByRole('button', { name: th.share.design.choosePhoto });
    const input = screen.getByTestId<HTMLInputElement>('design-photo-input');
    expect(input).toHaveAttribute('type', 'file');
    // Named types: Android opens the photo picker itself, not a chooser of apps.
    expect(input).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    expect(input).not.toHaveAttribute('capture');
    // The tap opens the picker (a click on the file input, inside the tap), not the sheet.
    const pick = vi.spyOn(input, 'click');
    await userEvent.click(button);
    expect(pick).toHaveBeenCalledOnce();
    expect(screen.queryByRole('region', { name: th.capture.title })).toBeNull();

    await userEvent.upload(input, new File(['raw'], 'me.jpg', { type: 'image/jpeg' }));
    await screen.findByRole('region', { name: th.results.strong });
    // No second picker in between: consent recorded, then the search with the re-encoded photo.
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.giveConsent)).toHaveLength(1);
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.faceSearch)).toHaveLength(1);
    expect(fake.selfieUploads[0]?.types).toEqual(['image/jpeg']);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('face_only: the card is all there is, with the camera button alone', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = designedShare(fake, { mode: 'face_only' });
    renderSharePage(fake, share.token);
    const card = await screen.findByRole('region', { name: th.share.design.label });
    expect(within(card).getByRole('button', { name: th.share.design.camera })).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: th.share.design.choosePhoto })).toBeNull();
    expect(screen.queryByText(th.share.faceOnly.body)).toBeNull();
    expect(screen.queryByRole('list', { name: th.share.galleryLabel })).toBeNull();
    // No photos below (a face_only share, or a design with "show photos" off, ADR 0019): no
    // "scroll down" strip, and the card fills the screen.
    expect(screen.queryByRole('button', { name: th.share.design.seeAll })).toBeNull();
    expect(card.className).toContain('min-h-svh');
  });

  it('after a scan the card is hidden and the found photos come first', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = designedShare(fake);
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.design.camera }));
    const take = await screen.findByRole('button', { name: th.capture.takePhoto });
    await waitFor(() => expect(take).toBeEnabled());
    await userEvent.click(take);
    expect(await screen.findByRole('heading', { name: 'พบรูปของคุณ 2 รูป' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: th.share.design.label })).toBeNull();
    // No card any more: the top bar is the normal solid, sticky one again.
    const header = screen.getByRole('navigation', { name: th.publicNav.label }).closest('header');
    expect(header).not.toHaveAttribute('data-overlay');
    expect(header).toHaveClass('sticky');
    // The sticky button scans again.
    expect(screen.getByRole('button', { name: th.share.scanAgain })).toBeInTheDocument();
  });

  it('"how it works" opens a short how-to sheet', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = designedShare(fake);
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.design.help }));
    const sheet = await screen.findByRole('dialog', { name: th.share.design.howTo.title });
    expect(within(sheet).getByText(th.share.design.howTo.camera)).toBeInTheDocument();
    expect(within(sheet).getByText(th.share.design.howTo.choosePhoto)).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole('button', { name: th.share.design.howTo.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('design images come from the meta asset map; the labels follow the viewer’s language', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const assetId = crypto.randomUUID();
    const base = designFor('en');
    const design: ShareMetaDesign = {
      doc: {
        ...base.doc,
        background: { type: 'image', assetId, blur: 8, dim: 0.3, color: '#000000' },
      },
      assets: {
        [assetId]: {
          url: `${MEDIA}/designs/p/${assetId}/web.webp?Signature=x`,
          width: 1200,
          height: 2400,
        },
      },
    };
    const share = designedShare(fake, { design });
    renderSharePage(fake, share.token, { locale: 'en' });
    const card = await screen.findByRole('region', { name: 'Event page' });
    expect(within(card).getByRole('button', { name: 'Take a selfie' })).toBeInTheDocument();
    const image = screen.getByTestId('design-background-image');
    expect(image).toHaveAttribute('src', `${MEDIA}/designs/p/${assetId}/web.webp?Signature=x`);
    // The whole image covers the artboard as designed (a phone of another shape never crops a
    // logo in it); a blurred copy fills the screen around it.
    expect(
      within(screen.getByTestId('design-artboard')).getByTestId('design-background-image'),
    ).toBe(image);
    const backdrop = screen.getByTestId('design-background-backdrop');
    expect(backdrop).toHaveAttribute('src', image.getAttribute('src'));
    expect(
      within(screen.getByTestId('design-artboard')).queryByTestId('design-background-backdrop'),
    ).toBeNull();
  });

  it('without a design the layout is unchanged (title, no card)', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = fake.addPublicShare({ faceSearchAvailable: true });
    renderSharePage(fake, share.token);
    expect(await screen.findByRole('heading', { level: 1, name: share.title })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: th.share.design.label })).toBeNull();
    expect(screen.getByRole('button', { name: th.share.scan })).toBeInTheDocument();
  });
});
