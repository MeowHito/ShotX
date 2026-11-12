import {
  blankDesignDoc,
  DESIGN_FONT_INFO,
  DESIGN_FONTS,
  type DesignDoc,
  type DesignElementOf,
  designTemplateDoc,
} from '@shotx/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fontCalls } from '../../../test/next-font-google';
import { type Locale, MESSAGES, TIME_ZONE } from '@/i18n/config';
import { designFontFamily } from '@/lib/design/fonts';
import { en } from '@/messages/en';
import { th } from '@/messages/th';
import { zh } from '@/messages/zh';
import { backgroundCss, DesignCanvas } from './design-canvas';

function renderIn(ui: ReactElement, locale: Locale = 'th') {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone={TIME_ZONE}>
      {ui}
    </NextIntlClientProvider>,
  );
}

function text(id: string, value: string, extra: Partial<DesignElementOf<'text'>> = {}) {
  return {
    id,
    type: 'text' as const,
    x: 20,
    y: 40,
    w: 300,
    h: 40,
    rotation: 0,
    opacity: 1,
    locked: false,
    hidden: false,
    text: value,
    font: 'kanit' as const,
    size: 24,
    weight: 700,
    color: '#111827',
    align: 'center' as const,
    lineHeight: 1.2,
    letterSpacing: 0,
    italic: false,
    uppercase: false,
    shadow: null,
    ...extra,
  };
}

function withElements(...elements: DesignDoc['elements']): DesignDoc {
  const doc = blankDesignDoc();
  return { ...doc, elements: [...doc.elements, ...elements] };
}

describe('DesignCanvas: the one renderer (ADR 0013)', () => {
  it('renders text as text nodes only, never as HTML', () => {
    const doc = withElements(
      text('t1', '<img src=x onerror=alert(1)><b>bold</b> https://evil.example'),
      text('t2', 'สองบรรทัด\nบรรทัดที่สอง'),
    );
    const { container } = renderIn(
      <DesignCanvas doc={doc} assets={{}} mode="gallery" layout={{ kind: 'artboard', unit: 1 }} />,
    );
    const node = container.querySelector('[data-element-id="t1"] [data-element-type="text"]');
    expect(node?.textContent).toBe('<img src=x onerror=alert(1)><b>bold</b> https://evil.example');
    expect(node?.children).toHaveLength(0);
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('a')).toBeNull();
    // Line breaks stay (pre-wrap), still one text node.
    const two = container.querySelector('[data-element-id="t2"] [data-element-type="text"]');
    expect(two?.textContent).toBe('สองบรรทัด\nบรรทัดที่สอง');
    expect((two as HTMLElement).style.whiteSpace).toBe('pre-wrap');
  });

  it('uses the chosen self-hosted font; Latin-only faces fall back to Noto Sans Thai for Thai', () => {
    const doc = withElements(
      text('kanit', 'คณิต', { font: 'kanit' }),
      text('bebas', 'BIG ไทย', { font: 'bebas-neue', italic: true, uppercase: true }),
    );
    const { container } = renderIn(
      <DesignCanvas doc={doc} assets={{}} mode="gallery" layout={{ kind: 'artboard', unit: 1 }} />,
    );
    const style = (id: string) =>
      (
        container.querySelector(
          `[data-element-id="${id}"] [data-element-type="text"]`,
        ) as HTMLElement
      ).style;
    expect(style('kanit').fontFamily).toContain('Kanit');
    expect(style('kanit').fontFamily).not.toContain('Noto Sans Thai');
    expect(style('bebas').fontFamily).toMatch(/Bebas Neue.*Noto Sans Thai/);
    expect(style('bebas').fontStyle).toBe('italic');
    expect(style('bebas').textTransform).toBe('uppercase');
    expect(style('kanit').fontWeight).toBe('700');
  });

  it('loads every design font with next/font, weights and italics from DESIGN_FONT_INFO', () => {
    for (const font of DESIGN_FONTS) {
      const info = DESIGN_FONT_INFO[font];
      const options = fontCalls.get(info.family) as {
        weight: string[];
        style?: string[];
        subsets: string[];
        preload: boolean;
      };
      expect(options, font).toBeDefined();
      expect(options.weight.map(Number), font).toEqual([...info.weights]);
      expect(options.style?.includes('italic') ?? false, font).toBe(info.italic);
      expect(options.subsets.includes('thai'), font).toBe(info.thai);
      // Only the faces a design uses are downloaded.
      expect(options.preload, font).toBe(false);
      expect(designFontFamily(font)).toContain(info.family);
    }
  });

  it('draws gradients with CSS angle semantics, and image backgrounds with blur and dim', () => {
    expect(
      backgroundCss({
        type: 'gradient',
        angle: 90,
        stops: [
          { color: '#ff0000', at: 0 },
          { color: '#0000ff80', at: 0.555 },
          { color: '#00ff00', at: 1 },
        ],
      }),
    ).toBe('linear-gradient(90deg, #ff0000 0%, #0000ff80 55.5%, #00ff00 100%)');
    expect(backgroundCss({ type: 'color', color: '#123456' })).toBe('#123456');

    const assetId = crypto.randomUUID();
    const doc: DesignDoc = {
      ...blankDesignDoc(),
      background: { type: 'image', assetId, blur: 12, dim: 0.4, color: '#222222' },
    };
    const { container, rerender } = renderIn(
      <DesignCanvas
        doc={doc}
        assets={{ [assetId]: 'https://cdn.example.com/designs/a/web.webp?sig=1' }}
        mode="gallery"
        layout={{ kind: 'fill' }}
      />,
    );
    const img = screen.getByTestId('design-background-image');
    expect(img).toHaveAttribute('src', 'https://cdn.example.com/designs/a/web.webp?sig=1');
    expect(img.style.filter).toContain('blur(');
    expect(container.querySelector('[style*="rgba(0, 0, 0, 0.4)"]')).not.toBeNull();
    // Not ready: the colour only.
    rerender(
      <NextIntlClientProvider locale="th" messages={MESSAGES.th} timeZone={TIME_ZONE}>
        <DesignCanvas doc={doc} assets={{}} mode="gallery" layout={{ kind: 'fill' }} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByTestId('design-background-image')).toBeNull();
    expect(screen.getByTestId('design-canvas').style.background).toContain('34, 34, 34');
  });

  it('gallery shows both scan buttons and the help button; face_only the camera button alone', async () => {
    const onCamera = vi.fn();
    const onChoosePhoto = vi.fn();
    const onHelp = vi.fn();
    const doc = designTemplateDoc('clean-white-card');
    const actions = { onCamera, onChoosePhoto, onHelp };
    const { rerender } = renderIn(
      <DesignCanvas
        doc={doc}
        assets={{}}
        mode="gallery"
        layout={{ kind: 'fill' }}
        actions={actions}
        label="card"
      />,
    );
    const card = screen.getByRole('region', { name: 'card' });
    await userEvent.click(within(card).getByRole('button', { name: th.share.design.camera }));
    await userEvent.click(within(card).getByRole('button', { name: th.share.design.choosePhoto }));
    await userEvent.click(within(card).getByRole('button', { name: th.share.design.help }));
    expect(onCamera).toHaveBeenCalledOnce();
    expect(onChoosePhoto).toHaveBeenCalledOnce();
    expect(onHelp).toHaveBeenCalledOnce();
    expect(screen.getByTestId('face-glyph')).toBeInTheDocument();

    rerender(
      <NextIntlClientProvider locale="th" messages={MESSAGES.th} timeZone={TIME_ZONE}>
        <DesignCanvas
          doc={doc}
          assets={{}}
          mode="face_only"
          layout={{ kind: 'fill' }}
          actions={actions}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole('button', { name: th.share.design.camera })).toBeInTheDocument();
    expect(screen.queryByText(th.share.design.choosePhoto)).toBeNull();
  });

  it('in the editor and previews the buttons are inert; labels follow the UI language', () => {
    const doc = designTemplateDoc('tech-blue-glass', 'en');
    renderIn(
      <DesignCanvas
        doc={doc}
        assets={{}}
        mode="gallery"
        layout={{ kind: 'artboard', unit: 0.5 }}
      />,
      'en',
    );
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(screen.getByText(en.share.design.camera)).toBeInTheDocument();
    expect(screen.getByText(en.share.design.choosePhoto)).toBeInTheDocument();
    expect(screen.getByText(en.share.design.help)).toBeInTheDocument();
    expect(screen.getByText('Your Event Name')).toBeInTheDocument();
  });

  it('Chinese labels; hidden elements and an unavailable scan draw nothing', () => {
    const base = designTemplateDoc('night-gala', 'zh');
    const doc: DesignDoc = {
      ...base,
      elements: base.elements.map((e) => (e.type === 'helpButton' ? { ...e, hidden: true } : e)),
    };
    renderIn(
      <DesignCanvas
        doc={doc}
        assets={{}}
        mode="gallery"
        layout={{ kind: 'fill' }}
        scanAvailable={false}
      />,
      'zh',
    );
    expect(screen.queryByText(zh.share.design.help)).toBeNull();
    expect(screen.queryByText(zh.share.design.camera)).toBeNull();
    expect(screen.getByText('活动名称')).toBeInTheDocument();
  });

  it('draws shapes with fill, stroke, radius and frosted glass; images from the asset URLs', () => {
    const assetId = crypto.randomUUID();
    const doc = withElements(
      {
        id: 'glass',
        type: 'shape',
        x: 10,
        y: 10,
        w: 200,
        h: 100,
        rotation: 15,
        opacity: 0.5,
        locked: false,
        hidden: false,
        shape: 'rect',
        fill: '#ffffff40',
        stroke: '#ffffff',
        strokeWidth: 2,
        radius: 20,
        glass: 24,
      },
      {
        id: 'logo',
        type: 'image',
        x: 10,
        y: 200,
        w: 100,
        h: 50,
        rotation: 0,
        opacity: 1,
        locked: false,
        hidden: false,
        assetId,
        fit: 'contain',
        radius: 0,
        flipX: true,
      },
    );
    const { container } = renderIn(
      <DesignCanvas
        doc={doc}
        assets={{ [assetId]: 'https://cdn.example.com/logo.webp' }}
        mode="gallery"
        layout={{ kind: 'artboard', unit: 1 }}
      />,
    );
    const glass = container.querySelector('[data-element-id="glass"]') as HTMLElement;
    expect(glass.style.transform).toBe('rotate(15deg)');
    expect(glass.style.opacity).toBe('0.5');
    expect(glass.querySelector('[data-glass="true"]')).not.toBeNull();
    const img = container.querySelector('[data-element-id="logo"] img') as HTMLImageElement;
    expect(img.src).toBe('https://cdn.example.com/logo.webp');
    expect(img.style.objectFit).toBe('contain');
    expect(img.style.transform).toBe('scaleX(-1)');
  });
});
