import { describe, expect, it } from 'vitest';
import {
  DESIGN_DOC_MAX_BYTES_LIMIT,
  DESIGN_MAX_ELEMENTS_LIMIT,
  DESIGN_MAX_ELEMENTS_MIN,
  loadDesignConfig,
} from '../config/design';
import { SUPPORTED_LOCALES } from '../locale';
import { designAssetFileType, DESIGN_ASSET_MIME_TYPES, DESIGN_ASSET_STATUSES } from './assets';
import {
  checkDesignDocLimits,
  DESIGN_ARTBOARD,
  DESIGN_FONT_INFO,
  DESIGN_FONTS,
  DESIGN_UNDELETABLE_ELEMENT_TYPES,
  designColorSchema,
  type DesignDoc,
  designDocAssetIds,
  designDocByteLength,
  designDocSchema,
  type DesignElement,
  type DesignElementOf,
} from './doc';
import {
  blankDesignDoc,
  DESIGN_TEMPLATE_IDS,
  DESIGN_TEMPLATES,
  designTemplateDoc,
} from './templates';

const assetA = '0193a5b0-7c1e-7cc3-9b1e-2f3a4b5c6d7e';
const assetB = '0193a5b0-7c1e-7cc3-9b1e-2f3a4b5c6d7f';

const base = { rotation: 0, opacity: 1, locked: false, hidden: false };
const box = { x: 10, y: 20, w: 100, h: 50 };

const textEl = (id: string, text: string): DesignElementOf<'text'> => ({
  id,
  type: 'text',
  ...box,
  ...base,
  text,
  font: 'kanit',
  size: 24,
  weight: 700,
  color: '#111111',
  align: 'center',
  lineHeight: 1.2,
  letterSpacing: 0,
  italic: false,
  uppercase: false,
  shadow: null,
});
const imageEl = (id: string, assetId: string): DesignElement => ({
  id,
  type: 'image',
  ...box,
  ...base,
  assetId,
  fit: 'contain',
  radius: 0,
  flipX: false,
});
const faceEl = (id = 'face'): DesignElement => ({
  id,
  type: 'faceIcon',
  x: 125,
  y: 300,
  w: 140,
  h: 140,
  ...base,
  color: '#000000',
  strokeWidth: 4,
});
const buttonsEl = (id = 'buttons'): DesignElement => ({
  id,
  type: 'scanButtons',
  x: 44,
  y: 500,
  w: 302,
  h: 116,
  ...base,
  layout: 'column',
  gap: 12,
  height: 52,
  radius: 26,
  primary: { bg: '#000000', fg: '#ffffff' },
  secondary: { bg: '#ffffff', fg: '#000000', border: null },
});
const helpEl = (id = 'help'): DesignElement => ({
  id,
  type: 'helpButton',
  x: 129,
  y: 700,
  w: 132,
  h: 36,
  ...base,
  bg: '#eeeeee',
  fg: '#333333',
  radius: 18,
});

const docWith = (elements: DesignElement[], extra: Partial<DesignDoc> = {}): DesignDoc => ({
  version: 1,
  background: { type: 'color', color: '#ffffff' },
  elements,
  ...extra,
});
const minimal = () => docWith([faceEl(), buttonsEl()]);

const issues = (input: unknown) => {
  const result = designDocSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('design document', () => {
  it('is a 390 x 844 phone artboard, version 1', () => {
    expect(DESIGN_ARTBOARD).toEqual({ width: 390, height: 844 });
    expect(designDocSchema.parse(minimal())).toEqual(minimal());
    expect(designDocSchema.safeParse({ ...minimal(), version: 2 }).success).toBe(false);
  });

  it('accepts every element type and stores the document as sent', () => {
    const doc = docWith([
      { ...textEl('t', 'ชื่องาน\nบรรทัดสอง'), shadow: { color: '#00000080', blur: 4, x: 0, y: 2 } },
      imageEl('i', assetA),
      {
        id: 's',
        type: 'shape',
        ...box,
        ...base,
        shape: 'rect',
        fill: '#ffffff73',
        stroke: null,
        strokeWidth: 0,
        radius: 24,
        glass: 20,
      },
      faceEl(),
      buttonsEl(),
      helpEl(),
    ]);
    expect(designDocSchema.parse(doc)).toEqual(doc);
  });

  it('needs exactly one face icon and one set of scan buttons, and at most one help button', () => {
    expect(issues(docWith([buttonsEl()]))).toContain(
      'must have exactly one faceIcon element (has 0)',
    );
    expect(issues(docWith([faceEl('a'), faceEl('b'), buttonsEl()]))).toContain(
      'must have exactly one faceIcon element (has 2)',
    );
    expect(issues(docWith([faceEl()]))).toContain(
      'must have exactly one scanButtons element (has 0)',
    );
    expect(issues(docWith([faceEl(), buttonsEl('a'), buttonsEl('b')]))).toContain(
      'must have exactly one scanButtons element (has 2)',
    );
    expect(designDocSchema.safeParse(docWith([faceEl(), buttonsEl(), helpEl()])).success).toBe(
      true,
    );
    expect(issues(docWith([faceEl(), buttonsEl(), helpEl('a'), helpEl('b')]))).toContain(
      'must have at most one helpButton element (has 2)',
    );
    expect(DESIGN_UNDELETABLE_ELEMENT_TYPES).toEqual(['faceIcon', 'scanButtons']);
  });

  it("keeps the face icon and the scan buttons visible: they can't be hidden or faded out", () => {
    expect(issues(docWith([{ ...faceEl(), hidden: true }, buttonsEl()]))).toContain(
      "faceIcon can't be hidden",
    );
    expect(issues(docWith([faceEl(), { ...buttonsEl(), opacity: 0.1 }]))).toContain(
      'scanButtons opacity must be at least 0.3',
    );
    expect(
      designDocSchema.safeParse(docWith([faceEl(), { ...buttonsEl(), opacity: 0.3 }])).success,
    ).toBe(true);
    // Other elements may be hidden or transparent.
    expect(
      designDocSchema.safeParse(
        docWith([faceEl(), buttonsEl(), { ...helpEl(), hidden: true, opacity: 0 }]),
      ).success,
    ).toBe(true);
  });

  it('needs unique element ids of safe characters', () => {
    const result = designDocSchema.safeParse(docWith([faceEl('x'), buttonsEl('x')]));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toContainEqual(
      expect.objectContaining({
        message: 'element ids must be unique',
        path: ['elements', 1, 'id'],
      }),
    );
    for (const id of ['', 'a b', 'a/b', '<x>', 'x'.repeat(65)]) {
      expect(designDocSchema.safeParse(docWith([faceEl(id), buttonsEl()])).success, id).toBe(false);
    }
  });

  it('takes #rrggbb and #rrggbbaa colours only', () => {
    for (const good of ['#000000', '#ABCDEF', '#abcdef80', '#FfFfFf00']) {
      expect(designColorSchema.safeParse(good).success, good).toBe(true);
    }
    for (const bad of [
      'red',
      '#fff',
      '#ffff',
      '#12345',
      '#1234567',
      '#123456789',
      '#gggggg',
      'rgb(0,0,0)',
      'url(https://x.example/a.png)',
      '#000000;background:url(x)',
      ' #000000',
    ]) {
      expect(designColorSchema.safeParse(bad).success, bad).toBe(false);
      const doc = docWith([faceEl(), buttonsEl()], { background: { type: 'color', color: bad } });
      expect(designDocSchema.safeParse(doc).success, bad).toBe(false);
    }
  });

  it('keeps URLs and markup typed into a text element as plain text', () => {
    for (const value of [
      'https://evil.example/phish',
      '<script>alert(1)</script>',
      '<img src=x onerror=alert(1)>',
      'javascript:alert(1)',
      '[click](https://evil.example)',
      '',
    ]) {
      const doc = docWith([textEl('t', value), faceEl(), buttonsEl()]);
      const parsed = designDocSchema.parse(doc);
      expect(parsed.elements[0]).toEqual(doc.elements[0]);
      expect(parsed.elements[0]?.type === 'text' && parsed.elements[0].text).toBe(value);
    }
  });

  it('allows line breaks and Thai zero-width spaces, not other control characters', () => {
    const ok = ['บรรทัด\nสอง', 'ทาง​ไป', 'tab\there'];
    for (const value of ok) {
      expect(
        designDocSchema.safeParse(docWith([textEl('t', value), faceEl(), buttonsEl()])).success,
      ).toBe(true);
    }
    for (const value of ['a\u0000b', 'a\u001bb', 'a\rb', 'a\u0085b', 'a\ud800b']) {
      expect(
        designDocSchema.safeParse(docWith([textEl('t', value), faceEl(), buttonsEl()])).success,
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  it('limits text to 500 characters', () => {
    const at = (n: number) => docWith([textEl('t', 'ก'.repeat(n)), faceEl(), buttonsEl()]);
    expect(designDocSchema.safeParse(at(500)).success).toBe(true);
    expect(designDocSchema.safeParse(at(501)).success).toBe(false);
    // Characters, not UTF-16 units: 500 emoji fit.
    const emoji = docWith([textEl('t', '🙂'.repeat(500)), faceEl(), buttonsEl()]);
    expect(designDocSchema.safeParse(emoji).success).toBe(true);
  });

  it('rejects unknown keys anywhere, so nothing can be smuggled in', () => {
    const withExtra = (patch: (doc: Record<string, unknown>) => void) => {
      const doc = structuredClone(
        docWith([textEl('t', 'x'), imageEl('i', assetA), faceEl(), buttonsEl()]),
      ) as unknown as Record<string, unknown>;
      patch(doc);
      return designDocSchema.safeParse(doc).success;
    };
    expect(withExtra(() => undefined)).toBe(true);
    expect(withExtra((d) => (d.css = 'body{}'))).toBe(false);
    expect(
      withExtra((d) => ((d.background as Record<string, unknown>).url = 'https://x.example')),
    ).toBe(false);
    expect(
      withExtra((d) => (((d.elements as Record<string, unknown>[])[0] ?? {}).href = 'https://x')),
    ).toBe(false);
    expect(
      withExtra((d) => (((d.elements as Record<string, unknown>[])[0] ?? {}).html = '<b>x</b>')),
    ).toBe(false);
    expect(
      withExtra((d) => (((d.elements as Record<string, unknown>[])[0] ?? {}).fontUrl = 'x.woff2')),
    ).toBe(false);
    // An image is an asset id, never a URL.
    expect(
      withExtra(
        (d) =>
          (((d.elements as Record<string, unknown>[])[1] ?? {}).assetId =
            'https://x.example/a.png'),
      ),
    ).toBe(false);
    expect(
      withExtra((d) => (d.elements as unknown[]).push({ ...faceEl('z'), type: 'iframe' })),
    ).toBe(false);
  });

  it('checks the ranges of every number', () => {
    const t = textEl('t', 'x');
    const bad: Partial<Record<string, unknown>>[] = [
      { rotation: 181 },
      { rotation: -181 },
      { opacity: 1.01 },
      { opacity: -0.1 },
      { w: 0 },
      { h: 2 * 844 + 1 },
      { x: -845 },
      { y: Number.POSITIVE_INFINITY },
      { x: Number.NaN },
      { size: 7 },
      { size: 201 },
      { weight: 350 },
      { weight: 200 },
      { weight: 1000 },
      { lineHeight: 0.7 },
      { lineHeight: 3.1 },
      { letterSpacing: -6 },
      { letterSpacing: 51 },
      { font: 'Comic Sans' },
      { align: 'justify' },
      { shadow: { color: '#000000', blur: 41, x: 0, y: 0 } },
      { locked: 'yes' },
    ];
    for (const patch of bad) {
      const doc = docWith([{ ...t, ...patch }, faceEl(), buttonsEl()]);
      expect(designDocSchema.safeParse(doc).success, JSON.stringify(patch)).toBe(false);
    }
    const f = faceEl();
    for (const strokeWidth of [0, 13]) {
      expect(
        designDocSchema.safeParse(docWith([{ ...f, strokeWidth } as DesignElement, buttonsEl()]))
          .success,
      ).toBe(false);
    }
    const b = buttonsEl();
    for (const patch of [
      { height: 35 },
      { height: 81 },
      { radius: 41 },
      { gap: 41 },
      { layout: 'grid' },
    ]) {
      expect(
        designDocSchema.safeParse(docWith([faceEl(), { ...b, ...patch } as DesignElement])).success,
        JSON.stringify(patch),
      ).toBe(false);
    }
  });

  it('checks backgrounds: gradient stops in order, 2 to 5; image by asset id with blur and dim', () => {
    const stops = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ color: '#000000', at: n === 1 ? 0 : i / (n - 1) }));
    const gradient = (s: unknown) =>
      designDocSchema.safeParse({
        ...minimal(),
        background: { type: 'gradient', angle: 90, stops: s },
      }).success;
    expect(gradient(stops(2))).toBe(true);
    expect(gradient(stops(5))).toBe(true);
    expect(gradient(stops(1))).toBe(false);
    expect(gradient(stops(6))).toBe(false);
    expect(
      gradient([
        { color: '#000000', at: 0.6 },
        { color: '#ffffff', at: 0.4 },
      ]),
    ).toBe(false);
    expect(
      gradient([
        { color: '#000000', at: 0 },
        { color: '#ffffff', at: 1.5 },
      ]),
    ).toBe(false);
    const image = (patch: Record<string, unknown>) =>
      designDocSchema.safeParse({
        ...minimal(),
        background: {
          type: 'image',
          assetId: assetA,
          blur: 8,
          dim: 0.3,
          color: '#101010',
          ...patch,
        },
      }).success;
    expect(image({})).toBe(true);
    expect(image({ dim: 0.81 })).toBe(false);
    expect(image({ blur: 41 })).toBe(false);
    expect(image({ color: undefined })).toBe(false);
    expect(image({ assetId: 'https://x.example/bg.jpg' })).toBe(false);
  });

  it('caps elements and bytes at the hard ceilings; the configured limits are checked separately', () => {
    const many = (n: number) =>
      docWith([
        faceEl(),
        buttonsEl(),
        ...Array.from({ length: n - 2 }, (_, i) => textEl(`t${i}`, 'x')),
      ]);
    expect(designDocSchema.safeParse(many(DESIGN_MAX_ELEMENTS_LIMIT)).success).toBe(true);
    expect(designDocSchema.safeParse(many(DESIGN_MAX_ELEMENTS_LIMIT + 1)).success).toBe(false);

    const limits = { maxElements: 60, docMaxBytes: 65_536 };
    expect(checkDesignDocLimits(many(60), limits)).toBeNull();
    expect(checkDesignDocLimits(many(61), limits)).toEqual({
      reason: 'elements',
      max: 60,
      actual: 61,
    });

    // 50 Thai texts of 500 characters: about 75 KB as JSON, over the default 64 KiB.
    const big = docWith([
      faceEl(),
      buttonsEl(),
      ...Array.from({ length: 50 }, (_, i) => textEl(`t${i}`, 'ก'.repeat(500))),
    ]);
    const bytes = designDocByteLength(big);
    expect(bytes).toBeGreaterThan(65_536);
    expect(designDocSchema.safeParse(big).success).toBe(true);
    expect(checkDesignDocLimits(designDocSchema.parse(big), limits)).toEqual({
      reason: 'bytes',
      max: 65_536,
      actual: bytes,
    });

    // Over the ceiling the schema itself refuses (text near the per-element limit, many elements).
    const huge = docWith([
      faceEl(),
      buttonsEl(),
      ...Array.from({ length: DESIGN_MAX_ELEMENTS_LIMIT - 2 }, (_, i) =>
        textEl(`t${i}`, '🙂'.repeat(500)),
      ),
    ]);
    expect(designDocByteLength(huge)).toBeGreaterThan(DESIGN_DOC_MAX_BYTES_LIMIT);
    expect(issues(huge).some((m) => m.startsWith('must be at most 262144 bytes'))).toBe(true);
  });

  it('measures documents in UTF-8 bytes of JSON', () => {
    expect(designDocByteLength({ a: 'ก' })).toBe('{"a":""}'.length + 3);
    expect(designDocByteLength(minimal())).toBe(
      new TextEncoder().encode(JSON.stringify(minimal())).length,
    );
  });

  it('lists the asset ids a document references, once each', () => {
    const doc = docWith(
      [imageEl('a', assetB), imageEl('b', assetA), imageEl('c', assetB), faceEl(), buttonsEl()],
      { background: { type: 'image', assetId: assetA, blur: 0, dim: 0, color: '#000000' } },
    );
    expect(designDocAssetIds(doc)).toEqual([assetA, assetB]);
    expect(designDocAssetIds(minimal())).toEqual([]);
  });

  it('knows how to load every font', () => {
    expect(Object.keys(DESIGN_FONT_INFO).sort()).toEqual([...DESIGN_FONTS].sort());
    expect(DESIGN_FONTS).toHaveLength(11);
    for (const font of DESIGN_FONTS) {
      const info = DESIGN_FONT_INFO[font];
      expect(info.weights.length, font).toBeGreaterThan(0);
      for (const w of info.weights) expect(w >= 300 && w <= 900 && w % 100 === 0, font).toBe(true);
    }
    expect(DESIGN_FONTS.filter((f) => !DESIGN_FONT_INFO[f].thai)).toEqual([
      'playfair-display',
      'bebas-neue',
    ]);
  });
});

describe('design templates', () => {
  it('has the five generic templates in picker order', () => {
    expect(DESIGN_TEMPLATES.map((t) => t.id)).toEqual([
      'clean-white-card',
      'pastel-glow',
      'night-gala',
      'tech-blue-glass',
      'bold-poster',
    ]);
    expect(DESIGN_TEMPLATE_IDS).toEqual(DESIGN_TEMPLATES.map((t) => t.id));
  });

  const all = [
    ...DESIGN_TEMPLATE_IDS.flatMap((id) =>
      SUPPORTED_LOCALES.map(
        (locale) => [`${id} ${locale}`, designTemplateDoc(id, locale)] as const,
      ),
    ),
    ['blank', blankDesignDoc()] as const,
  ];

  it.each(all)('%s is a valid document within the default limits, without assets', (_, doc) => {
    expect(designDocSchema.parse(doc)).toEqual(doc);
    const defaults = loadDesignConfig({});
    expect(checkDesignDocLimits(doc, defaults)).toBeNull();
    expect(doc.elements.length).toBeLessThanOrEqual(DESIGN_MAX_ELEMENTS_MIN);
    expect(designDocAssetIds(doc)).toEqual([]);
    expect(doc.background.type).not.toBe('image');
  });

  it.each(all)('%s centres the face icon and has the buttons on the artboard', (_, doc) => {
    const face = doc.elements.find((e) => e.type === 'faceIcon');
    expect(face).toBeDefined();
    if (face === undefined) return;
    expect(face.x + face.w / 2).toBe(DESIGN_ARTBOARD.width / 2);
    expect(face.rotation).toBe(0);
    for (const type of ['scanButtons', 'helpButton'] as const) {
      const el = doc.elements.find((e) => e.type === type);
      expect(el, type).toBeDefined();
      if (el === undefined) continue;
      expect(el.x).toBeGreaterThanOrEqual(0);
      expect(el.x + el.w).toBeLessThanOrEqual(DESIGN_ARTBOARD.width);
      expect(el.y + el.h).toBeLessThanOrEqual(DESIGN_ARTBOARD.height);
      expect(el.x + el.w / 2).toBe(DESIGN_ARTBOARD.width / 2);
    }
    const buttons = doc.elements.find((e) => e.type === 'scanButtons');
    if (buttons?.type === 'scanButtons') {
      expect(buttons.h).toBe(
        buttons.layout === 'row' ? buttons.height : 2 * buttons.height + buttons.gap,
      );
    }
  });

  it('writes the placeholder text in the requested language, Thai by default', () => {
    const title = (doc: DesignDoc) =>
      doc.elements.find((e) => e.id === 'title' && e.type === 'text');
    expect(title(designTemplateDoc('clean-white-card'))).toMatchObject({ text: 'ชื่องานของคุณ' });
    expect(title(designTemplateDoc('clean-white-card', 'en'))).toMatchObject({
      text: 'Your Event Name',
    });
    expect(title(designTemplateDoc('clean-white-card', 'zh'))).toMatchObject({ text: '活动名称' });
    expect(DESIGN_TEMPLATES[0]?.doc).toEqual(designTemplateDoc('clean-white-card'));
  });

  it('keeps the shared templates frozen and hands out fresh copies', () => {
    const shared = DESIGN_TEMPLATES[0]?.doc;
    expect(Object.isFrozen(shared)).toBe(true);
    expect(Object.isFrozen(shared?.elements[0])).toBe(true);
    const copy = designTemplateDoc('clean-white-card');
    copy.elements.pop();
    expect(designTemplateDoc('clean-white-card').elements).toHaveLength(copy.elements.length + 1);
    expect(() => designTemplateDoc('neon' as never)).toThrow(RangeError);
  });

  it('uses no brand names or URLs', () => {
    const json = JSON.stringify(DESIGN_TEMPLATE_IDS.map((id) => designTemplateDoc(id, 'en')));
    expect(json).not.toMatch(/https?:|www\.|\.com|apple|canva|google/i);
  });
});

describe('design images', () => {
  it('accepts JPEG, PNG and WebP with a matching extension only', () => {
    expect(DESIGN_ASSET_MIME_TYPES).toEqual(['image/jpeg', 'image/png', 'image/webp']);
    expect(DESIGN_ASSET_STATUSES).toEqual(['uploading', 'processing', 'ready', 'failed']);
    expect(designAssetFileType('logo.PNG', 'image/png')?.mime).toBe('image/png');
    expect(designAssetFileType('bg.jpeg', 'IMAGE/JPEG; q=1')?.mime).toBe('image/jpeg');
    expect(designAssetFileType('a.webp', 'image/webp')?.mime).toBe('image/webp');
    for (const [name, mime] of [
      ['logo.svg', 'image/svg+xml'],
      ['a.png', 'image/jpeg'],
      ['clip.mp4', 'video/mp4'],
      ['a.heic', 'image/heic'],
      ['png', 'image/png'],
    ] as const) {
      expect(designAssetFileType(name, mime), name).toBeNull();
    }
  });
});

describe('loadDesignConfig', () => {
  it('has the ADR 0013 defaults', () => {
    expect(loadDesignConfig({})).toEqual({
      maxPerOwner: 50,
      maxElements: 60,
      docMaxBytes: 65_536,
      bodyMaxBytes: 96 * 1024,
      asset: {
        maxBytes: 15 * 1024 * 1024,
        longEdge: 2560,
        webpQuality: 85,
        orphanDays: 30,
        uploadTtlSeconds: 3600,
        pageSize: 60,
      },
    });
  });

  it('reads overrides within the ceilings', () => {
    const c = loadDesignConfig({
      DESIGN_MAX_PER_OWNER: '10',
      DESIGN_MAX_ELEMENTS: '100',
      DESIGN_DOC_MAX_BYTES: '131072',
      DESIGN_BODY_MAX_BYTES: '140000',
      DESIGN_ASSET_MAX_BYTES: '5242880',
      DESIGN_ASSET_LONG_EDGE: '2048',
      DESIGN_ASSET_ORPHAN_DAYS: '7',
      DESIGN_ASSET_PAGE_SIZE: '',
    });
    expect(c).toMatchObject({ maxPerOwner: 10, maxElements: 100, docMaxBytes: 131_072 });
    expect(c.asset).toMatchObject({
      maxBytes: 5_242_880,
      longEdge: 2048,
      orphanDays: 7,
      pageSize: 60,
    });
  });

  it('rejects values past the ceilings and a body limit that cannot carry a document', () => {
    for (const env of [
      { DESIGN_MAX_ELEMENTS: String(DESIGN_MAX_ELEMENTS_LIMIT + 1) },
      { DESIGN_MAX_ELEMENTS: String(DESIGN_MAX_ELEMENTS_MIN - 1) },
      { DESIGN_DOC_MAX_BYTES: String(DESIGN_DOC_MAX_BYTES_LIMIT + 1) },
      // Above half the database ceiling (jsonb's text form is longer than JSON.stringify).
      {
        DESIGN_DOC_MAX_BYTES: String(DESIGN_DOC_MAX_BYTES_LIMIT / 2 + 1),
        DESIGN_BODY_MAX_BYTES: String(DESIGN_DOC_MAX_BYTES_LIMIT),
      },
      { DESIGN_MAX_PER_OWNER: '0' },
      { DESIGN_ASSET_ORPHAN_DAYS: '0' },
      { DESIGN_DOC_MAX_BYTES: '98304' },
    ]) {
      expect(() => loadDesignConfig(env), JSON.stringify(env)).toThrow(
        /Invalid design configuration/,
      );
    }
  });
});
