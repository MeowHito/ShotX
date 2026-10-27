import { CAPTCHA_TOKEN_HEADER, PUBLIC_SHARE_ROUTES } from '@shotx/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeApi, type PublicShareFixture } from '../../../test/fake-api';
import { FakeTurnstile } from '../../../test/fake-turnstile';
import {
  renderFaceDeletionPage,
  renderSharePage,
  TURNSTILE_FACE_CONFIG,
} from '../../../test/share-harness';
import { th } from '@/messages/th';

vi.mock('photoswipe', () => ({
  default: class {
    on() {}
    init() {}
    destroy() {}
  },
}));

beforeAll(() => {
  URL.createObjectURL = () => `blob:selfie-${Math.random()}`;
  URL.revokeObjectURL = () => undefined;
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { get: () => 1280 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { get: () => 960 });
});

const SITE_KEY = '1x00000000000000000000AA';

function limitedShare(fake: FakeApi, rateLimit: PublicShareFixture['rateLimit']) {
  const share = fake.addPublicShare({
    faceSearchAvailable: true,
    itemCount: 4,
    consented: true,
    rateLimit,
  });
  const [a, b] = share.items;
  share.faceMatches = { strong: [a?.id ?? ''], maybe: [b?.id ?? ''] };
  return share;
}

async function scanOnce() {
  await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
  await userEvent.click(await screen.findByRole('button', { name: th.capture.openCamera }));
  await userEvent.click(await screen.findByRole('button', { name: th.capture.takePhoto }));
  await userEvent.click(await screen.findByRole('button', { name: th.capture.search }));
}

const searches = (fake: FakeApi) => fake.callsTo(PUBLIC_SHARE_ROUTES.faceSearch);

describe('Turnstile after a rate-limit hit', () => {
  it('never loads the script on a normal scan', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = limitedShare(fake, null);
    const turnstile = new FakeTurnstile();
    renderSharePage(fake, share.token, {
      faceConfig: TURNSTILE_FACE_CONFIG,
      loadTurnstile: turnstile.loader,
    });
    await scanOnce();
    expect(await screen.findByRole('region', { name: th.results.strong })).toBeInTheDocument();
    expect(turnstile.loads).toBe(0);
    expect(searches(fake)[0]?.headers).not.toHaveProperty(CAPTCHA_TOKEN_HEADER);
  });

  it('renders the widget with the site key and action, then re-sends the same selfie with the token', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = limitedShare(fake, {
      captcha: true,
      retryAfterSeconds: 300,
      tokens: { 'token-ok': 'ok' },
    });
    const turnstile = new FakeTurnstile();
    const page = renderSharePage(fake, share.token, {
      faceConfig: TURNSTILE_FACE_CONFIG,
      loadTurnstile: turnstile.loader,
    });
    await scanOnce();

    expect(await screen.findByText(th.errors.details.captchaRequired)).toBeInTheDocument();
    await waitFor(() => expect(turnstile.live()).toHaveLength(1));
    expect(turnstile.loads).toBe(1);
    expect(turnstile.widgets[0]?.options).toMatchObject({
      sitekey: SITE_KEY,
      action: 'face_search',
      language: 'th',
    });
    // The API refused before reading the selfie; nothing was uploaded yet.
    expect(fake.selfieUploads).toHaveLength(0);

    turnstile.solve('token-ok');
    expect(await screen.findByRole('region', { name: th.results.strong })).toBeInTheDocument();
    const [first, retry] = searches(fake);
    expect(first?.headers).not.toHaveProperty(CAPTCHA_TOKEN_HEADER);
    expect(retry?.headers[CAPTCHA_TOKEN_HEADER]).toBe('token-ok');
    // The same in-memory selfie: encoded once, sent again without a new capture.
    expect(page.toJpeg).toHaveBeenCalledTimes(1);
    expect(fake.selfieUploads).toEqual([
      { route: 'search', sizes: [new Blob(['jpeg-bytes']).size], types: ['image/jpeg'] },
    ]);
    expect(turnstile.live()).toHaveLength(0);
  });

  it('says why a token was refused and shows a fresh widget', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = limitedShare(fake, {
      captcha: true,
      retryAfterSeconds: 300,
      tokens: { spent: 'expired', forged: 'invalid', good: 'ok' },
    });
    const turnstile = new FakeTurnstile();
    renderSharePage(fake, share.token, {
      faceConfig: TURNSTILE_FACE_CONFIG,
      loadTurnstile: turnstile.loader,
    });
    await scanOnce();
    await waitFor(() => expect(turnstile.live()).toHaveLength(1));

    turnstile.solve('spent');
    expect(await screen.findByText(th.errors.details.captchaExpired)).toBeInTheDocument();
    await waitFor(() => expect(turnstile.widgets).toHaveLength(2));
    expect(turnstile.widgets[0]?.removed).toBe(true);

    turnstile.solve('forged');
    expect(await screen.findByText(th.errors.details.captchaInvalid)).toBeInTheDocument();
    await waitFor(() => expect(turnstile.widgets).toHaveLength(3));

    turnstile.solve('good');
    expect(await screen.findByRole('region', { name: th.results.strong })).toBeInTheDocument();
    expect(fake.captchaTokens).toEqual(['spent', 'forged', 'good']);
    // Every widget asks the loader, which (createTurnstileLoader) adds the script only once.
    expect(turnstile.loads).toBe(3);
  });

  it('shows the wait message when only waiting helps, without loading Turnstile', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = limitedShare(fake, { captcha: false, retryAfterSeconds: 290, tokens: {} });
    const turnstile = new FakeTurnstile();
    renderSharePage(fake, share.token, {
      faceConfig: TURNSTILE_FACE_CONFIG,
      loadTurnstile: turnstile.loader,
    });
    await scanOnce();
    expect(
      await screen.findByText('ส่งคำขอบ่อยเกินไป กรุณารออีก 5 นาทีแล้วลองใหม่'),
    ).toBeInTheDocument();
    expect(turnstile.loads).toBe(0);
    // The selfie is dropped: the camera is offered again for a later try.
    expect(screen.getByRole('button', { name: th.capture.openCamera })).toBeInTheDocument();
  });

  it('treats a Cloudflare outage at the API (rejected: unavailable) as wait', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = limitedShare(fake, {
      captcha: true,
      retryAfterSeconds: 60,
      tokens: { t1: 'unavailable' },
    });
    const turnstile = new FakeTurnstile();
    renderSharePage(fake, share.token, {
      faceConfig: TURNSTILE_FACE_CONFIG,
      loadTurnstile: turnstile.loader,
    });
    await scanOnce();
    await waitFor(() => expect(turnstile.live()).toHaveLength(1));
    turnstile.solve('t1');
    expect(
      await screen.findByText('ส่งคำขอบ่อยเกินไป กรุณารออีก 1 นาทีแล้วลองใหม่'),
    ).toBeInTheDocument();
    expect(turnstile.live()).toHaveLength(0);
  });

  it('offers a retry when the widget itself fails, and falls back to waiting without turnstile', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = limitedShare(fake, {
      captcha: true,
      retryAfterSeconds: 120,
      tokens: { good: 'ok' },
    });
    const turnstile = new FakeTurnstile();
    turnstile.failLoad = true;
    renderSharePage(fake, share.token, {
      faceConfig: TURNSTILE_FACE_CONFIG,
      loadTurnstile: turnstile.loader,
    });
    await scanOnce();
    expect(await screen.findByText(th.errors.client.captchaUnavailable)).toBeInTheDocument();
    turnstile.failLoad = false;
    await userEvent.click(screen.getByRole('button', { name: th.capture.captchaRetry }));
    await waitFor(() => expect(turnstile.live()).toHaveLength(1));
    turnstile.solve('good');
    expect(await screen.findByRole('region', { name: th.results.strong })).toBeInTheDocument();
  });

  it('with another captcha provider in web, a challenge offer is shown as the wait message', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = limitedShare(fake, { captcha: true, retryAfterSeconds: 120, tokens: {} });
    renderSharePage(fake, share.token);
    await scanOnce();
    expect(
      await screen.findByText('ส่งคำขอบ่อยเกินไป กรุณารออีก 2 นาทีแล้วลองใหม่'),
    ).toBeInTheDocument();
  });

  it('guards "ขอลบใบหน้าของฉัน" the same way, with the face_deletion action', async () => {
    const fake = new FakeApi({ faceSearch: false });
    const share = fake.addPublicShare({
      deletionConsented: true,
      deletionMatches: 2,
      rateLimit: { captcha: true, retryAfterSeconds: 300, tokens: { good: 'ok' } },
    });
    const turnstile = new FakeTurnstile();
    renderFaceDeletionPage(fake, share.token, {
      faceConfig: TURNSTILE_FACE_CONFIG,
      loadTurnstile: turnstile.loader,
    });
    await userEvent.click(await screen.findByRole('button', { name: th.capture.openCamera }));
    await userEvent.click(await screen.findByRole('button', { name: th.capture.takePhoto }));
    await userEvent.click(await screen.findByRole('button', { name: th.faceDeletion.submit }));
    await waitFor(() => expect(turnstile.live()).toHaveLength(1));
    expect(turnstile.widgets[0]?.options.action).toBe('face_deletion');
    turnstile.solve('good');
    expect(
      await screen.findByText('พบใบหน้าของคุณ 2 ใบหน้า และกำลังลบออกจากระบบค้นหา'),
    ).toBeInTheDocument();
    const calls = fake.callsTo(PUBLIC_SHARE_ROUTES.faceDeletion);
    expect(calls.map((c) => c.headers[CAPTCHA_TOKEN_HEADER])).toEqual([undefined, 'good']);
  });
});
