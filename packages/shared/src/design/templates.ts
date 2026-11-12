import { DEFAULT_LOCALE, type SupportedLocale } from '../locale';
import {
  DESIGN_ARTBOARD,
  DESIGN_DOC_VERSION,
  type DesignBackground,
  type DesignColor,
  type DesignDoc,
  type DesignElement,
  type DesignElementOf,
  type DesignFont,
} from './doc';

/**
 * Built-in design templates (ADR 0013): generic documents without assets or brands. A new design
 * starts from one of them or from {@link blankDesignDoc}. Display names are web i18n (keyed by
 * id); the placeholder text inside a document comes in each UI language
 * ({@link designTemplateDoc}), and the photographer edits it.
 *
 * Every template has the face icon centred horizontally on the artboard, the scan buttons and a
 * help button, and at most DESIGN_MAX_ELEMENTS_MIN elements.
 */
export const DESIGN_TEMPLATE_IDS = [
  'clean-white-card',
  'pastel-glow',
  'night-gala',
  'tech-blue-glass',
  'bold-poster',
] as const;
export type DesignTemplateId = (typeof DESIGN_TEMPLATE_IDS)[number];

/** Placeholder text of the templates, per UI language. */
interface TemplateCopy {
  title: string;
  subtitle: string;
  /** Date and venue line. */
  details: string;
  /** Logo placeholder. */
  logo: string;
}

const COPY = {
  th: {
    title: 'ชื่องานของคุณ',
    subtitle: 'ค้นหารูปของคุณด้วยใบหน้า',
    details: 'วันที่ · สถานที่จัดงาน',
    logo: 'โลโก้',
  },
  en: {
    title: 'Your Event Name',
    subtitle: 'Find your photos with a selfie',
    details: 'Date · Venue',
    logo: 'LOGO',
  },
  zh: {
    title: '活动名称',
    subtitle: '刷脸查找你的照片',
    details: '日期 · 地点',
    logo: '标志',
  },
} as const satisfies Record<SupportedLocale, TemplateCopy>;

// --- Element builders (internal) --------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const common = (id: string, box: Box) => ({
  id,
  ...box,
  rotation: 0,
  opacity: 1,
  locked: false,
  hidden: false,
});

/** A box of width `w` centred horizontally on the artboard. */
const centred = (y: number, w: number, h: number): Box => ({
  x: (DESIGN_ARTBOARD.width - w) / 2,
  y,
  w,
  h,
});

type TextStyle = Partial<
  Omit<DesignElementOf<'text'>, 'id' | 'type' | 'text' | 'x' | 'y' | 'w' | 'h'>
> & { font: DesignFont; size: number; color: DesignColor };

const text = (id: string, box: Box, value: string, style: TextStyle): DesignElementOf<'text'> => ({
  ...common(id, box),
  type: 'text',
  text: value,
  weight: 400,
  align: 'center',
  lineHeight: 1.25,
  letterSpacing: 0,
  italic: false,
  uppercase: false,
  shadow: null,
  ...style,
});

type ShapeStyle = Partial<Omit<DesignElementOf<'shape'>, 'id' | 'type' | 'x' | 'y' | 'w' | 'h'>> & {
  shape: DesignElementOf<'shape'>['shape'];
};

const shape = (id: string, box: Box, style: ShapeStyle): DesignElementOf<'shape'> => ({
  ...common(id, box),
  type: 'shape',
  fill: null,
  stroke: null,
  strokeWidth: 0,
  radius: 0,
  glass: 0,
  ...style,
});

/** The face icon, 140 units square, centred horizontally with its top at `y`. */
const faceIcon = (
  y: number,
  color: DesignColor,
  strokeWidth: number,
): DesignElementOf<'faceIcon'> => ({
  ...common('face-icon', centred(y, 140, 140)),
  type: 'faceIcon',
  color,
  strokeWidth,
});

type ButtonsStyle = Omit<
  DesignElementOf<'scanButtons'>,
  'id' | 'type' | 'x' | 'y' | 'w' | 'h' | 'rotation' | 'opacity' | 'locked' | 'hidden'
>;

/** The scan buttons, `w` wide and centred, with the box height their layout needs. */
const scanButtons = (y: number, w: number, style: ButtonsStyle): DesignElementOf<'scanButtons'> => {
  const h = style.layout === 'row' ? style.height : 2 * style.height + style.gap;
  return { ...common('scan-buttons', centred(y, w, h)), type: 'scanButtons', ...style };
};

const helpButton = (
  y: number,
  style: Pick<DesignElementOf<'helpButton'>, 'bg' | 'fg' | 'radius'>,
  w = 132,
  h = 36,
): DesignElementOf<'helpButton'> => ({
  ...common('help-button', centred(y, w, h)),
  type: 'helpButton',
  ...style,
});

const doc = (background: DesignBackground, elements: DesignElement[]): DesignDoc => ({
  version: DESIGN_DOC_VERSION,
  background,
  elements,
});

// --- Templates --------------------------------------------------------------------------------

/** White card on a soft grey backdrop, a logo slot, dark type and buttons. */
function cleanWhiteCard(c: TemplateCopy): DesignDoc {
  return doc(
    {
      type: 'gradient',
      angle: 180,
      stops: [
        { color: '#f5f6f8', at: 0 },
        { color: '#e6e9ef', at: 1 },
      ],
    },
    [
      shape(
        'card',
        { x: 20, y: 56, w: 350, h: 732 },
        { shape: 'rect', fill: '#ffffff', radius: 28 },
      ),
      shape('logo-frame', centred(96, 124, 48), {
        shape: 'rect',
        stroke: '#d5d9e0',
        strokeWidth: 1.5,
        radius: 14,
      }),
      text('logo', centred(108, 124, 24), c.logo, {
        font: 'kanit',
        size: 15,
        weight: 600,
        color: '#9aa1ad',
        letterSpacing: 3,
        lineHeight: 1.6,
        uppercase: true,
      }),
      text('title', centred(176, 310, 84), c.title, {
        font: 'kanit',
        size: 32,
        weight: 700,
        color: '#111827',
        lineHeight: 1.2,
      }),
      text('subtitle', centred(264, 310, 26), c.subtitle, {
        font: 'sarabun',
        size: 17,
        color: '#6b7280',
      }),
      faceIcon(330, '#111827', 5),
      text('details', centred(492, 310, 22), c.details, {
        font: 'sarabun',
        size: 14,
        color: '#9ca3af',
      }),
      scanButtons(556, 302, {
        layout: 'column',
        gap: 12,
        height: 52,
        radius: 26,
        primary: { bg: '#111827', fg: '#ffffff' },
        secondary: { bg: '#ffffff', fg: '#111827', border: '#d1d5db' },
      }),
      helpButton(708, { bg: '#f3f4f6', fg: '#374151', radius: 18 }),
    ],
  );
}

/** Pastel gradient with soft colour blobs behind a frosted glass card. */
function pastelGlow(c: TemplateCopy): DesignDoc {
  return doc(
    {
      type: 'gradient',
      angle: 160,
      stops: [
        { color: '#fde2f3', at: 0 },
        { color: '#e0e7ff', at: 0.55 },
        { color: '#d1fae5', at: 1 },
      ],
    },
    [
      {
        ...shape(
          'glow-pink',
          { x: -70, y: 70, w: 280, h: 280 },
          { shape: 'ellipse', fill: '#f9a8d4' },
        ),
        opacity: 0.55,
      },
      {
        ...shape(
          'glow-violet',
          { x: 190, y: 380, w: 290, h: 290 },
          { shape: 'ellipse', fill: '#a5b4fc' },
        ),
        opacity: 0.5,
      },
      {
        ...shape(
          'glow-mint',
          { x: 20, y: 610, w: 240, h: 240 },
          { shape: 'ellipse', fill: '#6ee7b7' },
        ),
        opacity: 0.45,
      },
      shape(
        'glass-card',
        { x: 24, y: 92, w: 342, h: 664 },
        {
          shape: 'rect',
          fill: '#ffffff73',
          stroke: '#ffffffb3',
          strokeWidth: 1,
          radius: 32,
          glass: 28,
        },
      ),
      text('title', centred(140, 300, 84), c.title, {
        font: 'prompt',
        size: 30,
        weight: 600,
        color: '#4c1d95',
        lineHeight: 1.25,
      }),
      text('subtitle', centred(228, 300, 26), c.subtitle, {
        font: 'prompt',
        size: 16,
        color: '#6d28d9cc',
      }),
      faceIcon(300, '#7c3aed', 5),
      text('details', centred(462, 300, 22), c.details, {
        font: 'prompt',
        size: 14,
        color: '#7c3aedb3',
      }),
      scanButtons(530, 290, {
        layout: 'column',
        gap: 12,
        height: 52,
        radius: 26,
        primary: { bg: '#7c3aed', fg: '#ffffff' },
        secondary: { bg: '#ffffffcc', fg: '#6d28d9', border: '#c4b5fd' },
      }),
      helpButton(680, { bg: '#ffffff99', fg: '#6d28d9', radius: 18 }),
    ],
  );
}

/** Deep night gradient with gold rules, a serif title and a gold face icon. */
function nightGala(c: TemplateCopy): DesignDoc {
  return doc(
    {
      type: 'gradient',
      angle: 180,
      stops: [
        { color: '#0b0b1a', at: 0 },
        { color: '#1c1530', at: 0.6 },
        { color: '#2a1b3d', at: 1 },
      ],
    },
    [
      {
        ...shape('halo', centred(330, 240, 240), { shape: 'ellipse', fill: '#d4af37' }),
        opacity: 0.12,
      },
      text('eyebrow', centred(108, 300, 22), 'GALA NIGHT', {
        font: 'playfair-display',
        size: 14,
        color: '#d4af37',
        letterSpacing: 6,
        uppercase: true,
      }),
      shape('rule-top', centred(146, 180, 2), { shape: 'line', stroke: '#d4af37', strokeWidth: 1 }),
      text('title', centred(164, 320, 92), c.title, {
        font: 'noto-serif-thai',
        size: 34,
        weight: 600,
        color: '#f3e3b0',
        lineHeight: 1.25,
        shadow: { color: '#00000080', blur: 12, x: 0, y: 2 },
      }),
      text('subtitle', centred(260, 320, 24), c.subtitle, {
        font: 'noto-serif-thai',
        size: 16,
        color: '#e8dcc0cc',
      }),
      shape('rule-bottom', centred(304, 180, 2), {
        shape: 'line',
        stroke: '#d4af37',
        strokeWidth: 1,
      }),
      faceIcon(380, '#d4af37', 4),
      text('details', centred(546, 320, 22), c.details, {
        font: 'noto-serif-thai',
        size: 14,
        color: '#d4af37cc',
        letterSpacing: 1,
      }),
      scanButtons(604, 290, {
        layout: 'column',
        gap: 12,
        height: 50,
        radius: 8,
        primary: { bg: '#d4af37', fg: '#1a1426' },
        secondary: { bg: '#ffffff00', fg: '#f3e3b0', border: '#d4af37' },
      }),
      helpButton(752, { bg: '#ffffff14', fg: '#f3e3b0', radius: 18 }),
    ],
  );
}

/** Blue-to-cyan tech gradient, outline rings and a frosted glass panel with row buttons. */
function techBlueGlass(c: TemplateCopy): DesignDoc {
  return doc(
    {
      type: 'gradient',
      angle: 135,
      stops: [
        { color: '#0a1f44', at: 0 },
        { color: '#0e4db3', at: 0.55 },
        { color: '#22d3ee', at: 1 },
      ],
    },
    [
      shape(
        'ring',
        { x: -130, y: -90, w: 360, h: 360 },
        {
          shape: 'ellipse',
          stroke: '#7dd3fc66',
          strokeWidth: 1.5,
        },
      ),
      {
        ...shape('orb', { x: 200, y: 600, w: 300, h: 300 }, { shape: 'ellipse', fill: '#22d3ee' }),
        opacity: 0.35,
      },
      text('title', centred(78, 330, 84), c.title, {
        font: 'chakra-petch',
        size: 32,
        weight: 700,
        color: '#ffffff',
        lineHeight: 1.2,
      }),
      text('subtitle', centred(164, 330, 24), c.subtitle, {
        font: 'ibm-plex-sans-thai',
        size: 16,
        color: '#cfe8ff',
      }),
      shape(
        'glass-panel',
        { x: 24, y: 214, w: 342, h: 420 },
        {
          shape: 'rect',
          fill: '#ffffff1f',
          stroke: '#ffffff4d',
          strokeWidth: 1,
          radius: 24,
          glass: 20,
        },
      ),
      faceIcon(262, '#e0f2fe', 4),
      text('details', centred(426, 300, 22), c.details, {
        font: 'ibm-plex-sans-thai',
        size: 14,
        color: '#bae6fd',
        letterSpacing: 0.5,
      }),
      scanButtons(500, 302, {
        layout: 'row',
        gap: 10,
        height: 52,
        radius: 12,
        primary: { bg: '#22d3ee', fg: '#0a1f44' },
        secondary: { bg: '#ffffff1a', fg: '#ffffff', border: '#ffffff66' },
      }),
      helpButton(674, { bg: '#ffffff1a', fg: '#e0f2fe', radius: 18 }),
    ],
  );
}

/** Black poster with a red block and band, heavy uppercase type, square buttons. */
function boldPoster(c: TemplateCopy): DesignDoc {
  return doc({ type: 'color', color: '#0a0a0a' }, [
    shape(
      'red-block',
      { x: 0, y: 0, w: DESIGN_ARTBOARD.width, h: 360 },
      {
        shape: 'rect',
        fill: '#e11d2e',
      },
    ),
    {
      ...shape('red-band', { x: -40, y: 318, w: 470, h: 84 }, { shape: 'rect', fill: '#e11d2e' }),
      rotation: -6,
    },
    text('eyebrow', { x: 24, y: 56, w: 342, h: 30 }, 'EVENT PHOTOS', {
      font: 'bebas-neue',
      size: 28,
      color: '#0a0a0a',
      align: 'left',
      letterSpacing: 2,
      lineHeight: 1,
      uppercase: true,
    }),
    text('title', { x: 24, y: 96, w: 342, h: 150 }, c.title, {
      font: 'kanit',
      size: 54,
      weight: 800,
      color: '#ffffff',
      align: 'left',
      lineHeight: 1.05,
      uppercase: true,
    }),
    text('details', { x: 24, y: 262, w: 342, h: 22 }, c.details, {
      font: 'kanit',
      size: 16,
      weight: 500,
      color: '#0a0a0a',
      align: 'left',
    }),
    faceIcon(450, '#ffffff', 6),
    text('subtitle', centred(610, 342, 26), c.subtitle, {
      font: 'kanit',
      size: 18,
      color: '#f5f5f5',
    }),
    scanButtons(660, 326, {
      layout: 'column',
      gap: 10,
      height: 50,
      radius: 0,
      primary: { bg: '#e11d2e', fg: '#ffffff' },
      secondary: { bg: '#ffffff', fg: '#0a0a0a', border: null },
    }),
    helpButton(790, { bg: '#1f1f1f', fg: '#ffffff', radius: 0 }, 132, 32),
  ]);
}

const BUILDERS = {
  'clean-white-card': cleanWhiteCard,
  'pastel-glow': pastelGlow,
  'night-gala': nightGala,
  'tech-blue-glass': techBlueGlass,
  'bold-poster': boldPoster,
} as const satisfies Record<DesignTemplateId, (copy: TemplateCopy) => DesignDoc>;

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface DesignTemplate {
  id: DesignTemplateId;
  /** The document with Thai placeholder text (frozen; use designTemplateDoc for a copy). */
  doc: DesignDoc;
}

/** The templates in picker order, with Thai placeholder text. Frozen. */
export const DESIGN_TEMPLATES: readonly DesignTemplate[] = deepFreeze(
  DESIGN_TEMPLATE_IDS.map((id) => ({ id, doc: BUILDERS[id](COPY[DEFAULT_LOCALE]) })),
);

/**
 * A fresh, mutable copy of a template's document with placeholder text in `locale` (default
 * Thai). `POST /designs` with `templateId` stores this with the request's `locale`.
 */
export function designTemplateDoc(
  id: DesignTemplateId,
  locale: SupportedLocale = DEFAULT_LOCALE,
): DesignDoc {
  const build = BUILDERS[id] as ((copy: TemplateCopy) => DesignDoc) | undefined;
  if (build === undefined) throw new RangeError(`Unknown design template ${JSON.stringify(id)}`);
  return build(COPY[locale]);
}

/**
 * The blank design (`POST /designs` with neither `templateId` nor `doc`): a white background, the
 * face icon centred, the scan buttons below it and the help button. No text, so it needs no
 * language.
 */
export function blankDesignDoc(): DesignDoc {
  return doc({ type: 'color', color: '#ffffff' }, [
    faceIcon(300, '#111827', 5),
    scanButtons(500, 302, {
      layout: 'column',
      gap: 12,
      height: 52,
      radius: 26,
      primary: { bg: '#111827', fg: '#ffffff' },
      secondary: { bg: '#ffffff', fg: '#111827', border: '#d1d5db' },
    }),
    helpButton(652, { bg: '#f3f4f6', fg: '#374151', radius: 18 }),
  ]);
}
