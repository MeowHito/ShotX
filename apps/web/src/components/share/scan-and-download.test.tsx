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

function scanShare(fake: FakeApi, extra: Partial<PublicShareFixture> = {}) {
  const share = fake.addPublicShare({ faceSearchAvailable: true, itemCount: 5, ...extra });
  const [a, b, c] = share.items;
  share.faceMatches = { strong: [a?.id ?? '', b?.id ?? ''], maybe: [c?.id ?? ''] };
  return share;
}

/** Tapping the scan button records the consent and opens the camera (ADR 0015). */
async function acceptConsent() {
  await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
}

/** The camera starts by itself in the round frame (ADR 0011); one tap takes the photo. */
async function takeLiveSelfie() {
  const button = await screen.findByRole('button', { name: th.capture.takePhoto });
  await waitFor(() => expect(button).toBeEnabled());
  await userEvent.click(button);
}

describe('consent', () => {
  it('records the consent of the current version on tap and opens the camera, no text (ADR 0015)', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake);
    renderSharePage(fake, share.token);
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.giveConsent)).toHaveLength(0);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    const policy = th.consent.policies.face_search[LATEST_CONSENT_POLICY_VERSION];
    // Straight to the camera, in its round frame with the face outline, without tips.
    expect(await screen.findByRole('button', { name: th.capture.takePhoto })).toBeInTheDocument();
    expect(screen.getByTestId('face-guide')).toBeInTheDocument();
    expect(screen.getByLabelText(th.capture.preview).parentElement).toHaveClass('rounded-full');
    expect(screen.queryByRole('heading', { name: policy.title })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: policy.checkbox })).toBeNull();
    expect(screen.queryByText(th.capture.notStored)).toBeNull();
    // The consent row is still written, once, before any scan.
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.giveConsent)).toHaveLength(1);
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.giveConsent)[0]).toMatchObject({
      prefix: '/api',
      credentials: 'include',
      body: {
        purpose: 'face_search',
        policyVersion: LATEST_CONSENT_POLICY_VERSION,
        locale: 'th',
        accepted: true,
      },
    });
    expect(share.consented).toBe(true);
  });

  it('does not post consent again once given, and has no withdraw link (ADR 0015)', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true });
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    await takeLiveSelfie();
    expect(await screen.findByRole('region', { name: th.results.strong })).toBeInTheDocument();
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.giveConsent)).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /ถอนความยินยอม/ })).toBeNull();
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

    const strong = await screen.findByRole('region', { name: th.results.strong });
    const maybe = screen.getByRole('region', { name: th.results.maybe });
    expect(within(strong).getAllByRole('button', { name: /^เปิด/ })).toHaveLength(2);
    expect(within(maybe).getAllByRole('button', { name: /^เปิด/ })).toHaveLength(1);
    // ADR 0012: no "not me" button.
    expect(screen.queryByRole('button', { name: /ไม่ใช่ฉัน/ })).not.toBeInTheDocument();

    const search = fake.callsTo(PUBLIC_SHARE_ROUTES.faceSearch);
    expect(search).toHaveLength(1);
    expect(search[0]).toMatchObject({ prefix: '/api', credentials: 'include' });
    expect(fake.selfieUploads).toEqual([{ route: 'search', sizes: [10], types: ['image/jpeg'] }]);
    // The results say how many photos were found. The selfie was never shown, persisted or logged.
    expect(screen.getByRole('heading', { name: 'พบรูปของคุณ 3 รูป' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: /เซลฟี/ })).not.toBeInTheDocument();
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

  it('starts the search as soon as the photo passes, with a progress bar and one selfie', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true });
    let release = () => undefined as void;
    fake.hold = { pathSuffix: '/face-search', release: new Promise<void>((r) => (release = r)) };
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    // No tips before the photo, no "add another angle", no second search button.
    expect(screen.queryByText(/หันหน้าตรง/)).not.toBeInTheDocument();
    await takeLiveSelfie();
    // The digging cat while it searches (owner, 2026-11-13).
    expect(await screen.findByRole('status', { name: th.capture.searching })).toBeInTheDocument();
    // Three frames taking turns (opacity keeps moving on iOS while the page is busy).
    const frames = screen.getByTestId('search-cat').children;
    expect(frames).toHaveLength(3);
    for (const frame of frames) expect(frame).toHaveClass('animate-snap-dig');
    expect(screen.queryByRole('button', { name: /มุม/ })).not.toBeInTheDocument();
    release();
    await screen.findByRole('region', { name: th.results.strong });
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.faceSearch)).toHaveLength(1);
    expect(fake.selfieUploads[0]?.types).toEqual(['image/jpeg']);
    expect(screen.queryByTestId('search-cat')).not.toBeInTheDocument();
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
    // The camera tries to start by itself; refused, the camera-app input takes over.
    expect(await screen.findByText(th.capture.cameraBlocked)).toBeInTheDocument();
    expect(screen.getByLabelText(th.capture.useCameraApp)).toHaveAttribute('capture', 'user');
  });

  it('shows the server NO_FACE_DETECTED message', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true, noFace: true });
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    await takeLiveSelfie();
    expect(await screen.findByText(/ไม่พบใบหน้าในรูปที่ส่ง \(1 รูป\)/)).toBeInTheDocument();
  });

  it('a scan that finds nothing shows the page from the very top', async () => {
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true });
    share.faceMatches = { strong: [], maybe: [] };
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    await takeLiveSelfie();
    expect(await screen.findByText(th.results.none)).toBeInTheDocument();
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith({ top: 0 }));
  });

  it('after a scan the event title is gone; the found photos come first', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true });
    renderSharePage(fake, share.token);
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    await takeLiveSelfie();
    await screen.findByRole('region', { name: th.results.strong });
    expect(screen.queryByRole('heading', { level: 1 })).not.toBeInTheDocument();
  });

  it('nothing found: a plain message, no selfie tips, and "ลองใหม่" back to the camera', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = fake.addPublicShare({ faceSearchAvailable: true, consented: true });
    renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    await takeLiveSelfie();
    expect(await screen.findByText(th.results.none)).toBeInTheDocument();
    expect(th.results.none).toBe('ไม่พบรูปของคุณ');
    // Owner feedback 2026-11-12: no advice on how to take the selfie.
    const status = screen.getByRole('status', { name: th.results.title });
    expect(status).toHaveTextContent(`${th.results.none}${th.results.retry}`);
    expect(screen.queryByText(/หันหน้า|ที่สว่าง|แว่น|แมสก์/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: th.results.retry }));
    // Consent is already given: straight back to the camera.
    expect(await screen.findByRole('button', { name: th.capture.takePhoto })).toBeInTheDocument();
    await takeLiveSelfie();
    await waitFor(() => expect(fake.callsTo(PUBLIC_SHARE_ROUTES.faceSearch)).toHaveLength(2));
  });

  it('"เลือกทั้งหมด" selects only the found photos; no "download all"; each downloads alone', async () => {
    const fake = new FakeApi({ faceSearch: true });
    const share = scanShare(fake, { consented: true });
    const { startDownload } = renderSharePage(fake, share.token);
    await userEvent.click(await screen.findByRole('button', { name: th.share.scan }));
    await takeLiveSelfie();
    await screen.findByRole('region', { name: th.results.strong });

    // ADR 0012: "select all" only; saving goes through the selection bar.
    expect(screen.queryByRole('button', { name: /ดาวน์โหลดทั้งหมด/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: th.results.selectAll }));
    const found = [...share.faceMatches.strong, ...share.faceMatches.maybe];
    expect(screen.getByText('เลือกแล้ว 3 รูป')).toBeInTheDocument();
    // Round dots: only the found photos are checked, in the results and in the gallery.
    for (const item of share.items) {
      const dots = screen.getAllByRole('checkbox', { name: `เลือก ${item.name}` });
      for (const dot of dots) {
        if (found.includes(item.id)) expect(dot).toBeChecked();
        else expect(dot).not.toBeChecked();
      }
    }
    // Tapping a dot again unselects it.
    await userEvent.click(
      within(screen.getByRole('region', { name: th.results.maybe })).getByRole('checkbox', {
        name: `เลือก ${share.items[2]?.name}`,
      }),
    );
    expect(screen.getByText('เลือกแล้ว 2 รูป')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'ดาวน์โหลด 2 รูป' }));
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(2));
    // One signed file each, never a zip.
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.downloads).map((c) => c.body)).toEqual(
      share.faceMatches.strong.map((id) => ({ fileIds: [id] })),
    );
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.zipJob)).toHaveLength(0);
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

  it('several photos download one by one as separate files: no zip on share pages', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    const { startDownload } = renderSharePage(fake, share.token);
    await select(['IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0003.jpg']);
    expect(screen.getAllByRole('button', { name: /ดาวน์โหลด|บันทึก/ })).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'ดาวน์โหลด 3 รูป' }));
    await waitFor(() => expect(startDownload).toHaveBeenCalledTimes(3));
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.downloads).map((c) => c.body)).toEqual(
      share.items.slice(0, 3).map((i) => ({ fileIds: [i.id] })),
    );
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.zipJob)).toHaveLength(0);
    // Owner, 2026-11-13: a check and where to find them, then "done" clears the selection.
    expect(await screen.findByText('ดาวน์โหลดเสร็จแล้ว 3 รูป')).toBeInTheDocument();
    expect(screen.getByText(th.downloads.downloadedBody)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: th.downloads.savedDone }));
    expect(screen.queryByText('ดาวน์โหลดเสร็จแล้ว 3 รูป')).toBeNull();
    expect(screen.queryByText(/เลือกแล้ว/)).toBeNull();
  });

  it('on iOS one tap saves to Photos: the selection is fetched ahead, no download button', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    const ios = fakeNavigator({ share: true });
    const { mediaFetch } = renderSharePage(fake, share.token, { nav: ios.nav });
    await select(['IMG_0001.jpg', 'IMG_0002.jpg']);
    // Fetched as soon as they are selected, before any tap.
    await waitFor(() => expect(mediaFetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: /ดาวน์โหลด/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: th.downloads.saveToPhotos }));
    expect(ios.share).toHaveBeenCalledTimes(1);
    const files = ios.share.mock.calls[0]?.[0].files ?? [];
    expect(files.map((f) => f.name)).toEqual(['IMG_0001.jpg', 'IMG_0002.jpg']);
    expect(fake.callsTo(PUBLIC_SHARE_ROUTES.zipJob)).toHaveLength(0);
    // Saved: a check and "open the Photos app".
    expect(await screen.findByText('บันทึกเรียบร้อย 2 รูป')).toBeInTheDocument();
    expect(screen.getByText(th.downloads.savedBody)).toBeInTheDocument();
  });

  it('on iOS a cancelled share sheet shows no "saved"', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    const ios = fakeNavigator({ share: true });
    ios.share.mockRejectedValueOnce(Object.assign(new Error('cancel'), { name: 'AbortError' }));
    const { mediaFetch } = renderSharePage(fake, share.token, { nav: ios.nav });
    await select(['IMG_0001.jpg']);
    await waitFor(() => expect(mediaFetch).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByRole('button', { name: th.downloads.saveToPhotos }));
    await waitFor(() => expect(ios.share).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/บันทึกเรียบร้อย/)).toBeNull();
    expect(screen.getByRole('button', { name: th.downloads.saveToPhotos })).toBeInTheDocument();
  });

  it('on iOS a deselected photo is dropped from what gets saved', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    const ios = fakeNavigator({ share: true });
    renderSharePage(fake, share.token, { nav: ios.nav });
    await select(['IMG_0001.jpg', 'IMG_0002.jpg', 'IMG_0003.jpg']);
    await select(['IMG_0002.jpg']);
    expect(screen.getByText('เลือกแล้ว 2 รูป')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: th.downloads.saveToPhotos }));
    await waitFor(() => expect(ios.share).toHaveBeenCalledTimes(1));
    const files = ios.share.mock.calls[0]?.[0].files ?? [];
    expect(files.map((f) => f.name)).toEqual(['IMG_0001.jpg', 'IMG_0003.jpg']);
  });

  it('on iOS, if Safari lets a slow tap expire, the button asks for one more tap', async () => {
    const fake = new FakeApi();
    const share = fake.addPublicShare();
    const ios = fakeNavigator({ share: true });
    ios.share.mockRejectedValueOnce(
      Object.assign(new Error('gesture'), { name: 'NotAllowedError' }),
    );
    renderSharePage(fake, share.token, { nav: ios.nav });
    await select(['IMG_0001.jpg', 'IMG_0002.jpg']);
    await userEvent.click(screen.getByRole('button', { name: th.downloads.saveToPhotos }));
    const again = await screen.findByRole('button', { name: 'พร้อมแล้ว แตะเพื่อบันทึก 2 รูป' });
    await userEvent.click(again);
    expect(ios.share).toHaveBeenCalledTimes(2);
  });
});
