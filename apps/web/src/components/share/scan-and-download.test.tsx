import {
  IDEMPOTENCY_KEY_HEADER,
  PUBLIC_SHARE_ROUTES,
  LATEST_CONSENT_POLICY_VERSION,
} from '@shotx/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeApi, type PublicShareFixture } from '../../../test/fake-api';
import { fakeNavigator, goodFace, LINE_IN_APP, renderSharePage } from '../../../test/share-harness';
import { th } from '@/messages/th';

vi.mock('photoswipe', () => ({
  default: class {
    on() {}
    init() {}
    destroy() {}
  },
}));

const objectUrls = vi.hoisted(() => ({ created: [] as string[], revoked: [] as string[] }));

beforeAll(() => {
  // jsdom has no object URLs for its Blobs; the scan flow uses them for selfie thumbnails.
  URL.createObjectURL = () => {
    const url = `blob:selfie-${objectUrls.created.length + 1}`;
    objectUrls.created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url: string) => {
    objectUrls.revoked.push(url);
  };
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { get: () => 1280 });
  Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { get: () => 960 });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function scanShare(fake: FakeApi, extra: Partial<PublicShareFixture> = {}) {
  const share = fake.addPublicShare({ faceSearchAvailable: true, itemCount: 5, ...extra });
  const [a, b, c] = share.items;
  share.faceMatches = { strong: [a?.id ?? '', b?.id ?? ''], maybe: [c?.id ?? ''] };
  return share;
}

async function acceptConsent() {
  await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
  await userEvent.click(
    screen.getByRole('checkbox', {
      name: th.consent.policies.face_search[LATEST_CONSENT_POLICY_VERSION].checkbox,
    }),
  );
  await userEvent.click(screen.getByRole('button', { name: th.consent.accept }));
}

async function takeLiveSelfie() {
  await userEvent.click(await screen.findByRole('button', { name: th.capture.openCamera }));
  await userEvent.click(await screen.findByRole('button', { name: th.capture.takePhoto }));
}

describe('consent', () => {
  it('shows the versioned Thai text, requires the checkbox, posts the version', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake);
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    const policy = th.consent.policies.face_search['2026-11-11b'];
    expect(LATEST_CONSENT_POLICY_VERSION).toBe('2026-11-11b');
    expect(screen.getByRole('heading', { name: policy.title })).toBeInTheDocument();
    // The short text: exactly the four bullets, visible.
    const consent = screen.getByRole('region', { name: policy.title });
    const bullets = within(consent).getAllByRole('list')[0] as HTMLElement;
    expect(
      within(bullets)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      policy.points.purpose,
      policy.points.noStorage,
      'ผลการค้นหาเก็บไว้ให้ดาวน์โหลดได้ 24 ชั่วโมง หลังการค้นหาครั้งล่าสุด แล้วลบเอง',
      policy.points.processor,
    ]);
    for (const li of within(bullets).getAllByRole('listitem')) expect(li).toBeVisible();
    // The legal detail: collapsed until "อ่านรายละเอียด" is opened.
    const summary = within(consent).getByText(th.consent.details);
    const details = summary.closest('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    const transfer = within(details).getByText(policy.details.transfer);
    expect(transfer).not.toBeVisible();
    expect(within(details).getByText(policy.details.sensitive)).not.toBeVisible();
    await userEvent.click(summary);
    expect(details.open).toBe(true);
    expect(transfer).toBeVisible();
    expect(within(details).getByText(policy.details.backups)).toBeVisible();
    expect(within(details).getByRole('link', { name: th.consent.deleteMyFace })).toHaveAttribute(
      'href',
      `/s/${share.token}/delete-my-face`,
    );
    expect(screen.getByText(`ฉบับวันที่ ${LATEST_CONSENT_POLICY_VERSION}`)).toBeInTheDocument();

    // No consent, no scan: the camera isn't offered and nothing is posted.
    expect(screen.queryByRole('button', { name: th.capture.openCamera })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: th.consent.accept }));
    expect(screen.getByText(th.consent.mustCheck)).toBeInTheDocument();
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.giveConsent)).toHaveLength(0);

    await userEvent.click(screen.getByRole('checkbox', { name: policy.checkbox }));
    await userEvent.click(screen.getByRole('button', { name: th.consent.accept }));
    expect(await screen.findByText(th.capture.guidance)).toBeInTheDocument();
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.giveConsent)[0]).toMatchObject({
      prefix: '/api',
      credentials: 'include',
      body: { policyVersion: LATEST_CONSENT_POLICY_VERSION, accepted: true },
    });
  });

  it('withdraws consent (DELETE) and forgets the results', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true });
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    await takeLiveSelfie();
    await userEvent.click(await screen.findByRole('button', { name: th.capture.search }));
    expect(await screen.findByRole('region', { name: th.results.strong })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: th.share.withdraw }));
    expect(await screen.findByText(th.share.withdrawn)).toBeInTheDocument();
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.withdrawConsent)).toHaveLength(1);
    expect(screen.queryByRole('region', { name: th.results.strong })).not.toBeInTheDocument();
    expect(share.consented).toBe(false);
    // Scanning again asks for consent again.
    await userEvent.click(screen.getByRole('button', { name: th.share.scan }));
    expect(
      await screen.findByRole('checkbox', {
        name: th.consent.policies.face_search[LATEST_CONSENT_POLICY_VERSION].checkbox,
      }),
    ).toBeInTheDocument();
  });
});

describe('scan', () => {
  it('captures with the camera, gates with MediaPipe, uploads one JPEG and shows both groups', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const log = vi.spyOn(console, 'log');
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake);
    const camera = fakeNavigator();
    const { detect, loadDetector } = renderSharePage(fake, share.token, { nav: camera.nav });
    await acceptConsent();
    await takeLiveSelfie();

    expect(camera.getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: false,
        video: expect.objectContaining({ facingMode: 'user' }) as unknown,
      }),
    );
    expect(camera.stop).toHaveBeenCalled();
    expect(loadDetector).toHaveBeenCalled();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('img', { name: 'เซลฟีมุมที่ 1' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: th.capture.search }));
    const strong = await screen.findByRole('region', { name: th.results.strong });
    const maybe = screen.getByRole('region', { name: th.results.maybe });
    expect(within(strong).getAllByRole('button', { name: /^ไม่ใช่ฉัน:/ })).toHaveLength(2);
    expect(within(maybe).getAllByRole('button', { name: /^ไม่ใช่ฉัน:/ })).toHaveLength(1);

    const search = fake.callsTo(PUBLIC_SHARE_ROUTES.faceSearch);
    expect(search).toHaveLength(1);
    expect(search[0]).toMatchObject({ prefix: '/api', credentials: 'include' });
    expect(fake.selfieUploads).toEqual([{ route: 'search', sizes: [10], types: ['image/jpeg'] }]);
    // The selfie is gone from the page and was never persisted or logged.
    expect(screen.queryByRole('img', { name: 'เซลฟีมุมที่ 1' })).not.toBeInTheDocument();
    expect(objectUrls.revoked).toEqual(expect.arrayContaining(objectUrls.created));
    expect(setItem).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('guides the person in Thai when the gate refuses a shot, and uploads nothing', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true });
    const { scenario } = renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));

    scenario.faces = [goodFace(), { ...goodFace(), x: 0 }];
    await takeLiveSelfie();
    expect(await screen.findByText(th.capture.issues.multipleFaces)).toBeInTheDocument();

    scenario.faces = [goodFace()];
    scenario.luma = 15;
    await takeLiveSelfie();
    expect(await screen.findByText(th.capture.issues.tooDark)).toBeInTheDocument();

    scenario.faces = [];
    scenario.luma = 128;
    await takeLiveSelfie();
    expect(await screen.findByText(th.capture.issues.noFace)).toBeInTheDocument();
    expect(fake.selfieUploads).toHaveLength(0);
  });

  it('collects up to three angles and sends them in one request', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true });
    const { scenario } = renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    await takeLiveSelfie();
    // Side shots are allowed to be turned.
    scenario.faces = [
      {
        ...goodFace(),
        keypoints: [
          { x: 0.4, y: 0.4 },
          { x: 0.6, y: 0.4 },
          { x: 0.68, y: 0.5 },
        ],
      },
    ];
    await userEvent.click(screen.getByRole('button', { name: 'เพิ่มอีกมุม (หันซ้ายเล็กน้อย)' }));
    await takeLiveSelfie();
    await userEvent.click(screen.getByRole('button', { name: 'เพิ่มอีกมุม (หันขวาเล็กน้อย)' }));
    await takeLiveSelfie();
    expect(screen.queryByRole('button', { name: /^เพิ่มอีกมุม/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: th.capture.search }));
    await screen.findByRole('region', { name: th.results.strong });
    expect(fake.selfieUploads[0]?.types).toEqual(['image/jpeg', 'image/jpeg', 'image/jpeg']);
  });

  it('falls back to <input capture="user"> in the LINE in-app browser; gallery pick only in gallery mode', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true });
    const line = fakeNavigator({ userAgent: LINE_IN_APP });
    renderSharePage(fake, share.token, { nav: line.nav });
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    expect(screen.queryByRole('button', { name: th.capture.openCamera })).not.toBeInTheDocument();
    const cameraInput = screen.getByLabelText(th.capture.useCameraApp);
    expect(cameraInput).toHaveAttribute('capture', 'user');
    expect(cameraInput).toHaveAttribute('accept', 'image/*');
    expect(screen.getByLabelText(th.capture.chooseFromGallery)).not.toHaveAttribute('capture');
    expect(screen.getByText(th.capture.inAppHint)).toBeInTheDocument();

    await userEvent.upload(cameraInput, new File(['raw'], 'selfie.heic', { type: 'image/heic' }));
    await userEvent.click(await screen.findByRole('button', { name: th.capture.search }));
    await screen.findByRole('region', { name: th.results.strong });
    // The upload is the re-encoded JPEG, never the picked file.
    expect(fake.selfieUploads[0]?.types).toEqual(['image/jpeg']);
    expect(line.getUserMedia).not.toHaveBeenCalled();
  });

  it('face_only: no gallery pick; a denied camera falls back to the camera app input', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true, mode: 'face_only' });
    renderSharePage(fake, share.token, { nav: fakeNavigator({ camera: 'denied' }).nav });
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    expect(screen.queryByLabelText(th.capture.chooseFromGallery)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: th.capture.openCamera }));
    expect(await screen.findByText(th.capture.cameraBlocked)).toBeInTheDocument();
    expect(screen.getByLabelText(th.capture.useCameraApp)).toHaveAttribute('capture', 'user');
  });

  it('shows the server NO_FACE_DETECTED message', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true, noFace: true });
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    await takeLiveSelfie();
    await userEvent.click(await screen.findByRole('button', { name: th.capture.search }));
    expect(await screen.findByText(/ไม่พบใบหน้าในรูปที่ส่ง \(1 รูป\)/)).toBeInTheDocument();
  });

  it('"ไม่ใช่ฉัน" sends only the file id and removes the photo', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true });
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    await takeLiveSelfie();
    await userEvent.click(await screen.findByRole('button', { name: th.capture.search }));
    const maybe = await screen.findByRole('region', { name: th.results.maybe });
    const target = share.items[2];
    await userEvent.click(
      within(maybe).getByRole('button', { name: `ไม่ใช่ฉัน: ${target?.name}` }),
    );
    expect(await screen.findByText(th.results.notMeDone)).toBeInTheDocument();
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.feedback)[0]?.body).toEqual({ fileId: target?.id });
    expect(screen.queryByRole('region', { name: th.results.maybe })).not.toBeInTheDocument();
  });

  it('shows "no match" guidance for an empty result', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = fake.addPublicShare({ faceSearchAvailable: true, consented: true });
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    await takeLiveSelfie();
    await userEvent.click(await screen.findByRole('button', { name: th.capture.search }));
    expect(await screen.findByText(th.results.none)).toBeInTheDocument();
  });
});

describe('downloads', () => {
  async function select(names: string[]) {
    for (const name of names) {
      await userEvent.click(await screen.findByRole('checkbox', { name: `เลือก ${name}` }));
    }
  }

  it('downloads one photo with a signed URL', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    const { startDownload } = renderSharePage(fake, share.token);
    await select(['IMG_0001.jpg']);
    expect(screen.getByText(/ไฟล์ขนาดสำหรับโซเชียล/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'ดาวน์โหลด 1 รูป' }));
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(1));
    expect(startDownload.mock.calls[0]?.[0]).toContain('response-content-disposition=attachment');
    expect(
      fake.callsTo(PUBLIC_SHARE_ROUTES.downloads)[0]?.headers[IDEMPOTENCY_KEY_HEADER],
    ).toBeUndefined();
  });

  it('zips several with a fresh Idempotency-Key per click and polls until ready', async () => {
    const fake = new FakeApi({ zipPollsUntilDone: 3 });
    const share = fake.addPublicShare();
    const { startDownload } = renderSharePage(fake, share.token);
    await select(['IMG_0001.jpg', 'IMG_0002.jpg']);
    const button = screen.getByRole('button', { name: 'ดาวน์โหลด 2 รูป' });
    await userEvent.click(button);
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(1));
    expect(startDownload.mock.calls[0]?.[0]).toMatch(/\/tmp\/zips\/.+\.zip/);
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.zipJob)).toHaveLength(3);

    await userEvent.click(button);
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(2));
    const keys = fake
      .callsTo(PUBLIC_SHARE_ROUTES.downloads)
      .map((c) => c.headers[IDEMPOTENCY_KEY_HEADER]);
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toMatch(UUID);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('reports a failed zip in Thai', async () => {
    const fake = new FakeApi({ zipOutcome: 'failed' });
    const share = fake.addPublicShare();
    const { startDownload } = renderSharePage(fake, share.token);
    await select(['IMG_0001.jpg', 'IMG_0002.jpg']);
    await userEvent.click(screen.getByRole('button', { name: 'ดาวน์โหลด 2 รูป' }));
    expect(await screen.findByText(th.errors.client.zipFailed)).toBeInTheDocument();
    expect(startDownload).not.toHaveBeenCalled();
  });

  it('shows ZIP_TOO_LARGE limits (over ZIP_MAX_BYTES)', async () => {
    const fake = new FakeApi({ zipMaxBytes: 2500 });
    const share = fake.addPublicShare();
    renderSharePage(fake, share.token);
    await select(['IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0003.jpg']);
    await userEvent.click(screen.getByRole('button', { name: 'ดาวน์โหลด 3 รูป' }));
    expect(await screen.findByText(/ดาวน์โหลดพร้อมกันได้ไม่เกิน 500 รูป/)).toBeInTheDocument();
  });

  it('on iOS offers Save to Photos through navigator.share({ files })', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    const ios = fakeNavigator({ share: true });
    const { mediaFetch } = renderSharePage(fake, share.token, { nav: ios.nav });
    await select(['IMG_0001.jpg', 'IMG_0002.jpg']);
    await userEvent.click(screen.getByRole('button', { name: th.downloads.saveToPhotos }));
    const save = await screen.findByRole('button', { name: 'พร้อมแล้ว แตะเพื่อบันทึก 2 รูป' });
    expect(mediaFetch).toHaveBeenCalledTimes(2);
    await userEvent.click(save);
    expect(ios.share).toHaveBeenCalledTimes(1);
    const files = ios.share.mock.calls[0]?.[0].files ?? [];
    expect(files.map((f) => f.name)).toEqual(['IMG_0001.jpg', 'IMG_0002.jpg']);
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.zipJob)).toHaveLength(0);
  });
});
