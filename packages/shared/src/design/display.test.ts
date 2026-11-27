import { describe, expect, it } from 'vitest';
import { DESIGN_MAX_ELEMENTS_MIN } from '../config/design';
import { SUPPORTED_LOCALES } from '../locale';
import { type DesignDoc, designDocSchema, designKind, isDisplayDesign } from './doc';
import {
  autoDisplayDoc,
  blankDesignDoc,
  DESIGN_DISPLAY_TEMPLATE_IDS,
  designDisplayTemplateDoc,
} from './templates';

const issues = (doc: unknown) => {
  const r = designDocSchema.safeParse(doc);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('display designs (ADR 0033)', () => {
  it('every display template validates, in every language, with one latest-photos box and a QR', () => {
    for (const id of DESIGN_DISPLAY_TEMPLATE_IDS) {
      for (const locale of SUPPORTED_LOCALES) {
        const doc = designDisplayTemplateDoc(id, locale);
        expect(issues(doc), `${id} ${locale}`).toEqual([]);
        expect(isDisplayDesign(doc)).toBe(true);
        expect(doc.elements.filter((e) => e.type === 'latestPhotos')).toHaveLength(1);
        expect(doc.elements.some((e) => e.type === 'qrCode')).toBe(true);
        expect(doc.elements.length).toBeLessThanOrEqual(DESIGN_MAX_ELEMENTS_MIN);
      }
    }
  });

  it('a document without kind is a share page', () => {
    expect(designKind(blankDesignDoc())).toBe('share');
    expect(isDisplayDesign(blankDesignDoc())).toBe(false);
  });

  it('a display has exactly one latest-photos box and no scan elements', () => {
    const display = designDisplayTemplateDoc('display-spotlight');
    const photos = display.elements.find((e) => e.type === 'latestPhotos');
    expect(
      issues({ ...display, elements: display.elements.filter((e) => e !== photos) }),
    ).toContain('must have exactly one latestPhotos element (has 0)');
    const scan = blankDesignDoc().elements.find((e) => e.type === 'scanButtons');
    expect(issues({ ...display, elements: [...display.elements, scan] })).toContain(
      "a display design can't have scanButtons elements (has 1)",
    );
    // The latest photos can't be hidden either (the screen's purpose).
    const hidden = display.elements.map((e) => (e === photos ? { ...e, hidden: true } : e));
    expect(issues({ ...display, elements: hidden })).toContain("latestPhotos can't be hidden");
  });

  it('a share page may have a QR code but no latest-photos box', () => {
    const share = blankDesignDoc();
    const display = designDisplayTemplateDoc('display-clean');
    const qr = display.elements.find((e) => e.type === 'qrCode');
    const photos = display.elements.find((e) => e.type === 'latestPhotos');
    expect(issues({ ...share, elements: [...share.elements, qr] })).toEqual([]);
    expect(issues({ ...share, elements: [...share.elements, photos] })).toContain(
      "a share design can't have latestPhotos elements (has 1)",
    );
  });

  it('checks latest-photos ranges', () => {
    const display = designDisplayTemplateDoc('display-spotlight');
    const withPhotos = (patch: object): DesignDoc => ({
      ...display,
      elements: display.elements.map((e) => (e.type === 'latestPhotos' ? { ...e, ...patch } : e)),
    });
    expect(issues(withPhotos({ count: 0 }))).not.toEqual([]);
    expect(issues(withPhotos({ count: 21 }))).not.toEqual([]);
    expect(issues(withPhotos({ count: 2.5 }))).not.toEqual([]);
    expect(issues(withPhotos({ intervalSec: 1 }))).not.toEqual([]);
    expect(issues(withPhotos({ count: 20, intervalSec: 60 }))).toEqual([]);
  });

  it('autoDisplayDoc puts the event name on the share page background', () => {
    const share = designDisplayTemplateDoc('display-clean');
    const doc = autoDisplayDoc('Chiangmai Thailand by UTMB', share.background, 'en');
    expect(issues(doc)).toEqual([]);
    expect(doc.background).toEqual(share.background);
    expect(doc.elements.find((e) => e.id === 'title')).toMatchObject({
      text: 'Chiangmai Thailand by UTMB',
    });
    expect(issues(autoDisplayDoc('', null))).toEqual([]);
    expect(issues(autoDisplayDoc('x'.repeat(600), null))).toEqual([]);
  });
});
