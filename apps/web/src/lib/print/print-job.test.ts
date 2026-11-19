import { describe, expect, it } from 'vitest';
import { printDocument, printSheet } from './print-job';

describe('print job (ADR 0031)', () => {
  it('turns the sheet to the photo', () => {
    expect(printSheet('4r', { width: 4000, height: 6000 })).toEqual({
      widthMm: 102,
      heightMm: 152,
    });
    expect(printSheet('4r', { width: 6000, height: 4000 })).toEqual({
      widthMm: 152,
      heightMm: 102,
    });
    expect(printSheet('a4', { width: null, height: null })).toEqual({
      widthMm: 210,
      heightMm: 297,
    });
  });

  it('sets the page size and escapes the URL', () => {
    const html = printDocument('https://cdn.test/a.jpg?x=1&y="2"', { widthMm: 152, heightMm: 102 });
    expect(html).toContain('@page { size: 152mm 102mm; margin: 0; }');
    expect(html).toContain('src="https://cdn.test/a.jpg?x=1&amp;y=&quot;2&quot;"');
  });
});
