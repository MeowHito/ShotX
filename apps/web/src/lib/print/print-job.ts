import { PRINT_PAPER_SIZES, type PrintPaperSize } from '@shotx/shared';

/** How long a print waits for the image before giving up. */
const IMAGE_TIMEOUT_MS = 60_000;

/**
 * The page sheet for a photo: the paper size turned to the photo's orientation (a landscape photo
 * prints on a landscape sheet), in millimetres.
 */
export function printSheet(
  paperSize: PrintPaperSize,
  photo: { width: number | null; height: number | null },
): { widthMm: number; heightMm: number } {
  const paper = PRINT_PAPER_SIZES[paperSize];
  const landscape = photo.width !== null && photo.height !== null && photo.width > photo.height;
  return landscape
    ? { widthMm: paper.heightMm, heightMm: paper.widthMm }
    : { widthMm: paper.widthMm, heightMm: paper.heightMm };
}

/**
 * The document printed for one photo: one borderless sheet of the chosen size, the photo
 * filling it (cropped at the edges when its ratio differs from the paper's).
 */
export function printDocument(
  imageUrl: string,
  sheet: { widthMm: number; heightMm: number },
): string {
  const url = imageUrl.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const w = `${sheet.widthMm}mm`;
  const h = `${sheet.heightMm}mm`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>print</title><style>
@page { size: ${w} ${h}; margin: 0; }
html, body { margin: 0; padding: 0; background: #fff; }
.sheet { width: ${w}; height: ${h}; overflow: hidden; break-after: avoid; }
img { display: block; width: 100%; height: 100%; object-fit: cover; image-orientation: from-image; }
</style></head><body><div class="sheet"><img src="${url}" alt=""></div></body></html>`;
}

/**
 * Prints one photo from a hidden iframe: waits for the image, opens the browser's print (silent
 * when Chrome runs with --kiosk-printing), and resolves once printing is done or cancelled.
 */
export function printPhoto(
  imageUrl: string,
  paperSize: PrintPaperSize,
  photo: { width: number | null; height: number | null },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(frame);
    const cleanup = () => {
      window.setTimeout(() => frame.remove(), 1_000);
    };
    const win = frame.contentWindow;
    const doc = frame.contentDocument;
    if (win === null || doc === null) {
      frame.remove();
      reject(new Error('print frame unavailable'));
      return;
    }
    doc.open();
    doc.write(printDocument(imageUrl, printSheet(paperSize, photo)));
    doc.close();
    const img = doc.querySelector('img');
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('print image timed out'));
    }, IMAGE_TIMEOUT_MS);
    const go = () => {
      window.clearTimeout(timer);
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      };
      win.addEventListener('afterprint', finish, { once: true });
      win.focus();
      // print() blocks until the dialog closes in most browsers; afterprint covers the others.
      win.print();
      window.setTimeout(finish, 500);
    };
    if (img === null) {
      window.clearTimeout(timer);
      cleanup();
      reject(new Error('print image missing'));
    } else if (img.complete && img.naturalWidth > 0) {
      go();
    } else {
      img.addEventListener('load', go, { once: true });
      img.addEventListener(
        'error',
        () => {
          window.clearTimeout(timer);
          cleanup();
          reject(new Error('print image failed to load'));
        },
        { once: true },
      );
    }
  });
}
