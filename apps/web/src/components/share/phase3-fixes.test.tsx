import { PUBLIC_SHARE_ROUTES, LATEST_CONSENT_POLICY_VERSION } from '@shotx/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeApi, type PublicShareFixture } from '../../../test/fake-api';
import { renderFaceDeletionPage, renderSharePage } from '../../../test/share-harness';
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

const searchPolicy = th.consent.policies.face_search[LATEST_CONSENT_POLICY_VERSION];
const deletionPolicy = th.consent.policies.face_deletion[LATEST_CONSENT_POLICY_VERSION];

function scanShare(fake: FakeApi, extra: Partial<PublicShareFixture> = {}) {
  const share = fake.addPublicShare({ faceSearchAvailable: true, itemCount: 5, ...extra });
  const [a, b] = share.items;
  share.faceMatches = { strong: [a?.id ?? ''], maybe: [b?.id ?? ''] };
  return share;
}

/** The camera starts by itself in the round frame (ADR 0011); one tap takes the photo. */
async function takeLiveSelfie() {
  const button = await screen.findByRole('button', { name: th.capture.takePhoto });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
}

describe('limits come from share meta, not web env', () => {
  it('uses meta maxSelfies, selfie long edge and JPEG quality', async () => {
    const fake = new FakeApi({
      faceSearch: true,
      maxSelfies: 1,
      selfieLongEdge: 640,
      selfieJpegQuality: 70,
    });
    const share = scanShare(fake, { consented: true });
    const { rendered, toJpeg } = renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    await takeLiveSelfie();
    await screen.findByRole('region', { name: th.results.strong });
    // A 1280x960 camera frame, fitted to a 640 px long edge, encoded at quality 70.
    expect(rendered).toEqual([{ width: 640, height: 480 }]);
    expect(toJpeg).toHaveBeenCalledWith(0.7);
  });
});

describe('ขอลบใบหน้าของฉัน', () => {
  it('works on an expired share with face search off: face_deletion consent, selfie, count', async () => {
    const fake = new FakeApi({ faceSearch: false });
    const share = fake.addPublicShare({
      expiredReason: 'revoked',
      faceSearchAvailable: false,
      deletionMatches: 4,
    });
    renderFaceDeletionPage(fake, share.token);

    // The deletion text, not the face-search one.
    expect(await screen.findByRole('heading', { name: deletionPolicy.title })).toBeInTheDocument();
    expect(screen.queryByText(searchPolicy.title)).not.toBeInTheDocument();
    expect(screen.getByText(deletionPolicy.points.processor)).toBeInTheDocument();
    expect(
      screen.getByText(th.consent.policies.face_deletion['2026-11-12'].points.transfer),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: deletionPolicy.checkbox }));
    await userEvent.click(screen.getByRole('button', { name: th.consent.acceptDeletion }));
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.giveConsent)[0]).toMatchObject({
      prefix: '/api',
      body: {
        purpose: 'face_deletion',
        policyVersion: LATEST_CONSENT_POLICY_VERSION,
        accepted: true,
      },
    });

    expect(await screen.findByText(th.faceDeletion.intro)).toBeInTheDocument();
    // Camera only: no gallery pick for deletion.
    expect(screen.queryByLabelText(th.capture.chooseFromGallery)).not.toBeInTheDocument();
    await takeLiveSelfie();
    await userEvent.click(await screen.findByRole('button', { name: th.faceDeletion.submit }));
    expect(
      await screen.findByText('พบใบหน้าของคุณ 4 ใบหน้า และกำลังลบออกจากระบบค้นหา'),
    ).toBeInTheDocument();

    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.faceDeletionInfo).length).toBeGreaterThan(0);
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.faceDeletion)).toHaveLength(1);
    // Never the gated routes.
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.meta)).toHaveLength(0);
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.faceSearch)).toHaveLength(0);
    expect(fake.selfieUploads).toEqual([{ route: 'deletion', sizes: [10], types: ['image/jpeg'] }]);
  });

  it('skips the consent screen when face_deletion consent exists, and uses the info limits', async () => {
    const fake = new FakeApi({ maxSelfies: 2 });
    const share = fake.addPublicShare({
      password: 'secret',
      deletionConsented: true,
      deletionMatches: 0,
    });
    renderFaceDeletionPage(fake, share.token);
    expect(await screen.findByText(th.faceDeletion.intro)).toBeInTheDocument();
    await takeLiveSelfie();
    // Deletion can't be undone: it waits for the confirm button (one selfie, no angles).
    await userEvent.click(await screen.findByRole('button', { name: th.faceDeletion.submit }));
    expect(fake.selfieUploads[0]?.types).toEqual(['image/jpeg']);
    expect(await screen.findByText('ไม่พบใบหน้าของคุณในรูปของช่างภาพรายนี้')).toBeInTheDocument();
  });

  it('a face_search consent does not count for deletion', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true });
    renderFaceDeletionPage(fake, share.token);
    expect(await screen.findByRole('heading', { name: deletionPolicy.title })).toBeInTheDocument();
  });

  it('shows the NOT_FOUND message for an unknown token', async () => {
    const fake = new FakeApi();
    renderFaceDeletionPage(fake, 'aB3dE5fG7hJ9kL1mN3pQ5r');
    expect(await screen.findByText(new RegExp(th.faceDeletion.loadError))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(th.errors.codes.NOT_FOUND))).toBeInTheDocument();
  });
});

describe('CONSENT_VERSION_MISMATCH (consent recorded on tap, ADR 0015)', () => {
  it('posts the current version from the error details, then opens the camera', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consentMismatchOnce: true });
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    expect(await screen.findByRole('button', { name: th.capture.takePhoto })).toBeInTheDocument();
    const posts = fake.callsTo(PUBLIC_SHARE_ROUTES.giveConsent);
    expect(posts).toHaveLength(2);
    expect(posts[1]?.body).toEqual({
      purpose: 'face_search',
      policyVersion: LATEST_CONSENT_POLICY_VERSION,
      locale: 'th',
      accepted: true,
    });
    expect(share.consented).toBe(true);
    expect(screen.queryByRole('checkbox', { name: searchPolicy.checkbox })).toBeNull();
  });

  it('asks to reload when the current version is newer than this page knows', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { serverPolicyVersion: '2099-01-01' });
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    expect(await screen.findByText(th.errors.client.consentVersionUnknown)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: th.common.retry })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: th.capture.takePhoto })).toBeNull();
    expect(share.consented).toBe(false);
  });

  it('a scan answered with a mismatch records the current consent and brings the camera back', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true, searchConsentStale: true });
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    await takeLiveSelfie();
    await waitFor(() => expect(share.consented).toBe(true));
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.giveConsent)).toHaveLength(1);
    // The selfie was dropped; the camera comes back for another photo.
    expect(await screen.findByRole('button', { name: th.capture.takePhoto })).toBeInTheDocument();
  });
});
