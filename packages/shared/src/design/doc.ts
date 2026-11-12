import { z } from 'zod';
import { DESIGN_DOC_MAX_BYTES_LIMIT, DESIGN_MAX_ELEMENTS_LIMIT } from '../config/design';
import { utf8ByteLength } from '../s3-keys';

/**
 * The share page design document (ADR 0013), `version: 1`. Stored in `share_designs.doc` and
 * validated with {@link designDocSchema} on every write; rendered by one renderer (`DesignCanvas`
 * in apps/web) in the editor and on the share page.
 *
 * Safety: a document holds only enums, finite numbers, `#rrggbb`/`#rrggbbaa` colours, plain text
 * and asset ids (uuids of the owner's `design_assets`). No URLs, HTML, CSS strings or font files,
 * and every object is strict (an unknown key fails validation), so a document can't inject
 * anything. Text is plain text: the renderer must output it as a text node (never as HTML), so a
 * URL or markup typed into a text element is shown as the characters typed. Button and help
 * labels are not in the document: they come from i18n (th/en/zh).
 *
 * Coordinates are design units on the portrait artboard {@link DESIGN_ARTBOARD} (390 x 844, a
 * phone); the renderer scales it to the viewport. `x`, `y` are the top-left corner of an
 * element's box before rotation, `rotation` turns the box about its centre, in degrees clockwise.
 * Elements are drawn bottom to top (array order).
 */

/** The artboard every document is laid out on, in design units. */
export const DESIGN_ARTBOARD = { width: 390, height: 844 } as const;

export const DESIGN_DOC_VERSION = 1;

/**
 * Fonts a text element may use. Self-hosted by web with next/font (OFL licensed); never font
 * files or URLs in a document.
 */
export const DESIGN_FONTS = [
  'noto-sans-thai',
  'kanit',
  'prompt',
  'sarabun',
  'mitr',
  'chakra-petch',
  'ibm-plex-sans-thai',
  'bai-jamjuree',
  'noto-serif-thai',
  'playfair-display',
  'bebas-neue',
] as const;
export type DesignFont = (typeof DESIGN_FONTS)[number];

export interface DesignFontInfo {
  /** The family name (Google Fonts / next/font). */
  family: string;
  /** Has Thai glyphs. Without them Thai text falls back to DESIGN_THAI_FALLBACK_FONT. */
  thai: boolean;
  /** Weights of the face within the document's 300..900 range; load these. */
  weights: readonly number[];
  /** Has a true italic (otherwise the browser slants the upright face). */
  italic: boolean;
}

/** What web loads for each font. */
export const DESIGN_FONT_INFO = {
  'noto-sans-thai': {
    family: 'Noto Sans Thai',
    thai: true,
    weights: [300, 400, 500, 600, 700, 800, 900],
    italic: false,
  },
  kanit: {
    family: 'Kanit',
    thai: true,
    weights: [300, 400, 500, 600, 700, 800, 900],
    italic: true,
  },
  prompt: {
    family: 'Prompt',
    thai: true,
    weights: [300, 400, 500, 600, 700, 800, 900],
    italic: true,
  },
  sarabun: {
    family: 'Sarabun',
    thai: true,
    weights: [300, 400, 500, 600, 700, 800],
    italic: true,
  },
  mitr: { family: 'Mitr', thai: true, weights: [300, 400, 500, 600, 700], italic: false },
  'chakra-petch': {
    family: 'Chakra Petch',
    thai: true,
    weights: [300, 400, 500, 600, 700],
    italic: true,
  },
  'ibm-plex-sans-thai': {
    family: 'IBM Plex Sans Thai',
    thai: true,
    weights: [300, 400, 500, 600, 700],
    italic: false,
  },
  'bai-jamjuree': {
    family: 'Bai Jamjuree',
    thai: true,
    weights: [300, 400, 500, 600, 700],
    italic: true,
  },
  'noto-serif-thai': {
    family: 'Noto Serif Thai',
    thai: true,
    weights: [300, 400, 500, 600, 700, 800, 900],
    italic: false,
  },
  'playfair-display': {
    family: 'Playfair Display',
    thai: false,
    weights: [400, 500, 600, 700, 800, 900],
    italic: true,
  },
  'bebas-neue': { family: 'Bebas Neue', thai: false, weights: [400], italic: false },
} as const satisfies Record<DesignFont, DesignFontInfo>;

/** Thai text in a Latin-only font (Playfair Display, Bebas Neue) falls back to this one. */
export const DESIGN_THAI_FALLBACK_FONT: DesignFont = 'noto-sans-thai';

// --- Values -----------------------------------------------------------------------------------

/** `#rrggbb` or `#rrggbbaa` (hex digits in either case). Nothing else: no names, rgb() or CSS. */
export const DESIGN_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const designColorSchema = z
  .string()
  .regex(DESIGN_COLOR_PATTERN, { error: 'must be #rrggbb or #rrggbbaa' });
export type DesignColor = z.output<typeof designColorSchema>;

/** Element ids: the editor's own ids, unique within a document. */
export const DESIGN_ELEMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Longest text of a text element, in characters (code points). */
export const DESIGN_TEXT_MAX_LENGTH = 500;

/**
 * Where an element's box may be: up to one artboard height beyond each edge (elements may bleed
 * off the artboard; the renderer clips to the viewport). Sizes are 1 to two artboard heights.
 */
export const DESIGN_COORDINATE_RANGE = {
  min: -DESIGN_ARTBOARD.height,
  max: 2 * DESIGN_ARTBOARD.height,
} as const;
export const DESIGN_SIZE_RANGE = { min: 1, max: 2 * DESIGN_ARTBOARD.height } as const;

/** Text shadow offsets, in design units. */
export const DESIGN_SHADOW_OFFSET_RANGE = { min: -50, max: 50 } as const;

const num = (min: number, max: number) => z.number().min(min).max(max);
const coordinate = num(DESIGN_COORDINATE_RANGE.min, DESIGN_COORDINATE_RANGE.max);
const size = num(DESIGN_SIZE_RANGE.min, DESIGN_SIZE_RANGE.max);
/** An asset id: a uuid of the owner's `design_assets` row (checked by the api on write). */
const assetId = z.uuid();

/**
 * No control characters other than line feed and tab, and no lone surrogates (PostgreSQL can't
 * store them). Format characters (zero-width space, ZWJ, ...) are allowed: Thai text uses U+200B
 * for line breaks.
 */
function isPlainText(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const control = (c < 0x20 && c !== 0x0a && c !== 0x09) || (c >= 0x7f && c <= 0x9f);
    if (control || (c >= 0xd800 && c <= 0xdfff)) return false;
  }
  return true;
}

/** Plain text of a text element: up to 500 characters, line breaks allowed, may be empty. */
export const designTextSchema = z
  .string()
  .refine(isPlainText, {
    error: 'must be plain text without control characters',
  })
  .refine((text) => [...text].length <= DESIGN_TEXT_MAX_LENGTH, {
    error: `must be at most ${DESIGN_TEXT_MAX_LENGTH} characters`,
  });

// --- Background -------------------------------------------------------------------------------

export const DESIGN_GRADIENT_STOPS = { min: 2, max: 5 } as const;

export const designGradientStopSchema = z.strictObject({
  color: designColorSchema,
  /** Position along the gradient, 0 (start) to 1 (end). */
  at: num(0, 1),
});

export const designBackgroundSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('color'), color: designColorSchema }),
  z.strictObject({
    type: z.literal('gradient'),
    /** CSS linear-gradient angle in degrees (0: bottom to top, 90: left to right). */
    angle: num(0, 360),
    /** In order of `at` (non-decreasing). */
    stops: z
      .array(designGradientStopSchema)
      .min(DESIGN_GRADIENT_STOPS.min)
      .max(DESIGN_GRADIENT_STOPS.max)
      .refine((stops) => stops.every((s, i) => i === 0 || (stops[i - 1]?.at ?? 0) <= s.at), {
        error: 'stops must be in order of `at`',
      }),
  }),
  z.strictObject({
    type: z.literal('image'),
    /** Covers the viewport (object-fit: cover). A missing or not-ready asset shows `color`. */
    assetId,
    /** Gaussian blur radius, design units. */
    blur: num(0, 40),
    /** Black overlay opacity. */
    dim: num(0, 0.8),
    /** Shown while the image loads, and instead of it when it isn't available. */
    color: designColorSchema,
  }),
]);
export type DesignBackground = z.output<typeof designBackgroundSchema>;

// --- Elements ---------------------------------------------------------------------------------

/** Fields every element has. */
const elementBase = {
  id: z.string().regex(DESIGN_ELEMENT_ID_PATTERN, { error: 'must be 1-64 of [A-Za-z0-9_-]' }),
  x: coordinate,
  y: coordinate,
  w: size,
  h: size,
  /** Degrees clockwise about the box centre. */
  rotation: num(-180, 180),
  opacity: num(0, 1),
  /** Editor only: can't be selected on the artboard (still in Layers). */
  locked: z.boolean(),
  /** Not drawn (editor and share page); still in Layers. */
  hidden: z.boolean(),
};

export const DESIGN_TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export type DesignTextAlign = (typeof DESIGN_TEXT_ALIGNS)[number];

export const designTextShadowSchema = z.strictObject({
  color: designColorSchema,
  blur: num(0, 40),
  x: num(DESIGN_SHADOW_OFFSET_RANGE.min, DESIGN_SHADOW_OFFSET_RANGE.max),
  y: num(DESIGN_SHADOW_OFFSET_RANGE.min, DESIGN_SHADOW_OFFSET_RANGE.max),
});

export const designTextElementSchema = z.strictObject({
  ...elementBase,
  type: z.literal('text'),
  /** Plain text; `\n` breaks lines; wraps inside the box width. */
  text: designTextSchema,
  font: z.enum(DESIGN_FONTS),
  /** Font size, design units. */
  size: num(8, 200),
  /** CSS font weight, a multiple of 100 (the nearest weight the font has is used). */
  weight: z.number().int().min(300).max(900).multipleOf(100),
  color: designColorSchema,
  align: z.enum(DESIGN_TEXT_ALIGNS),
  /** Multiple of the font size. */
  lineHeight: num(0.8, 3),
  /** Design units. */
  letterSpacing: num(-5, 50),
  italic: z.boolean(),
  uppercase: z.boolean(),
  shadow: designTextShadowSchema.nullable(),
});

export const DESIGN_IMAGE_FITS = ['cover', 'contain'] as const;

export const designImageElementSchema = z.strictObject({
  ...elementBase,
  type: z.literal('image'),
  /** Logos and pictures. A missing or not-ready asset draws nothing (the editor: a spinner). */
  assetId,
  fit: z.enum(DESIGN_IMAGE_FITS),
  /** Corner radius, design units. */
  radius: num(0, 200),
  /** Mirror horizontally. */
  flipX: z.boolean(),
});

export const DESIGN_SHAPES = ['rect', 'ellipse', 'line'] as const;

export const designShapeElementSchema = z.strictObject({
  ...elementBase,
  type: z.literal('shape'),
  /** `line`: a horizontal line through the box's vertical centre, the box's width long. */
  shape: z.enum(DESIGN_SHAPES),
  /** null: no fill (a line ignores it). */
  fill: designColorSchema.nullable(),
  /** null: no stroke. A line is drawn with `stroke` (null: nothing) and `strokeWidth`. */
  stroke: designColorSchema.nullable(),
  strokeWidth: num(0, 40),
  /** Corner radius of a rect, design units. */
  radius: num(0, 200),
  /** Backdrop blur behind the shape (a frosted card), design units; 0: none. */
  glass: num(0, 40),
});

export const designFaceIconElementSchema = z.strictObject({
  ...elementBase,
  type: z.literal('faceIcon'),
  /** The rounded-corner face glyph (web's own SVG), drawn to fit the box. */
  color: designColorSchema,
  strokeWidth: num(1, 12),
});

export const DESIGN_BUTTON_LAYOUTS = ['row', 'column'] as const;

export const designButtonColorsSchema = z.strictObject({
  bg: designColorSchema,
  fg: designColorSchema,
});

/**
 * The scan buttons: primary "ถ่ายภาพใบหน้า" (camera) and secondary "ใช้ภาพใบหน้า" (choose a
 * photo; `gallery` shares only, ADR 0011, so a `face_only` share shows the primary alone). Each
 * button is `height` tall and as wide as the box (`column`) or half the box minus `gap` (`row`),
 * centred vertically in the box. Editors keep the box height at `height` (row) or
 * `2 * height + gap` (column) when they resize. Labels come from i18n.
 */
export const designScanButtonsElementSchema = z.strictObject({
  ...elementBase,
  type: z.literal('scanButtons'),
  layout: z.enum(DESIGN_BUTTON_LAYOUTS),
  /** Space between the two buttons, design units. */
  gap: num(0, 40),
  /** Height of each button, design units. */
  height: num(36, 80),
  radius: num(0, 40),
  primary: designButtonColorsSchema,
  secondary: z.strictObject({
    bg: designColorSchema,
    fg: designColorSchema,
    /** null: no border. */
    border: designColorSchema.nullable(),
  }),
});

/** "วิธีการค้นหา": opens the how-to sheet. Fills its box; the label comes from i18n. */
export const designHelpButtonElementSchema = z.strictObject({
  ...elementBase,
  type: z.literal('helpButton'),
  bg: designColorSchema,
  fg: designColorSchema,
  radius: num(0, 40),
});

export const designElementSchema = z.discriminatedUnion('type', [
  designTextElementSchema,
  designImageElementSchema,
  designShapeElementSchema,
  designFaceIconElementSchema,
  designScanButtonsElementSchema,
  designHelpButtonElementSchema,
]);
export type DesignElement = z.output<typeof designElementSchema>;
export type DesignElementType = DesignElement['type'];
export type DesignElementOf<T extends DesignElementType> = Extract<DesignElement, { type: T }>;

export const DESIGN_ELEMENT_TYPES = [
  'text',
  'image',
  'shape',
  'faceIcon',
  'scanButtons',
  'helpButton',
] as const satisfies readonly DesignElementType[];

/** How many of each element type a document has: exactly one, at most one, or any number. */
export const DESIGN_ELEMENT_CARDINALITY = {
  text: 'any',
  image: 'any',
  shape: 'any',
  faceIcon: 'one',
  scanButtons: 'one',
  helpButton: 'optional',
} as const satisfies Record<DesignElementType, 'any' | 'one' | 'optional'>;

/** Element types the editor can move and restyle but never delete. */
export const DESIGN_UNDELETABLE_ELEMENT_TYPES = (
  Object.keys(DESIGN_ELEMENT_CARDINALITY) as DesignElementType[]
).filter((t) => DESIGN_ELEMENT_CARDINALITY[t] === 'one');

// --- Document ---------------------------------------------------------------------------------

/** The lowest opacity of the face icon and the scan buttons (they must stay visible). */
export const DESIGN_REQUIRED_ELEMENT_MIN_OPACITY = 0.3;

/** UTF-8 bytes of a document as JSON (JSON.stringify): what DESIGN_DOC_MAX_BYTES limits. */
export function designDocByteLength(doc: unknown): number {
  return utf8ByteLength(JSON.stringify(doc));
}

/**
 * A design document. Besides the shapes above: exactly one `faceIcon`, exactly one
 * `scanButtons`, at most one `helpButton`, unique element ids, at most DESIGN_MAX_ELEMENTS_LIMIT
 * elements and DESIGN_DOC_MAX_BYTES_LIMIT bytes (the hard ceilings; the configured
 * DESIGN_MAX_ELEMENTS and DESIGN_DOC_MAX_BYTES are checked with {@link checkDesignDocLimits}).
 * No transforms: the parsed document is the input, so it is stored as sent.
 */
export const designDocSchema = z
  .strictObject({
    version: z.literal(DESIGN_DOC_VERSION),
    background: designBackgroundSchema,
    /** Bottom to top. */
    elements: z.array(designElementSchema).max(DESIGN_MAX_ELEMENTS_LIMIT),
  })
  .superRefine((doc, ctx) => {
    const counts = new Map<DesignElementType, number>();
    const seen = new Set<string>();
    doc.elements.forEach((element, i) => {
      counts.set(element.type, (counts.get(element.type) ?? 0) + 1);
      if (seen.has(element.id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'element ids must be unique',
          path: ['elements', i, 'id'],
        });
      }
      seen.add(element.id);
      // The face icon and the scan buttons are the page's purpose: they can't be deleted, so they
      // can't be hidden or made (nearly) invisible either.
      if (DESIGN_ELEMENT_CARDINALITY[element.type] === 'one') {
        if (element.hidden) {
          ctx.addIssue({
            code: 'custom',
            message: `${element.type} can't be hidden`,
            path: ['elements', i, 'hidden'],
          });
        }
        if (element.opacity < DESIGN_REQUIRED_ELEMENT_MIN_OPACITY) {
          ctx.addIssue({
            code: 'custom',
            message: `${element.type} opacity must be at least ${DESIGN_REQUIRED_ELEMENT_MIN_OPACITY}`,
            path: ['elements', i, 'opacity'],
          });
        }
      }
    });
    for (const type of DESIGN_ELEMENT_TYPES) {
      const count = counts.get(type) ?? 0;
      const rule = DESIGN_ELEMENT_CARDINALITY[type];
      if (rule === 'one' && count !== 1) {
        ctx.addIssue({
          code: 'custom',
          message: `must have exactly one ${type} element (has ${count})`,
          path: ['elements'],
        });
      }
      if (rule === 'optional' && count > 1) {
        ctx.addIssue({
          code: 'custom',
          message: `must have at most one ${type} element (has ${count})`,
          path: ['elements'],
        });
      }
    }
    const bytes = designDocByteLength(doc);
    if (bytes > DESIGN_DOC_MAX_BYTES_LIMIT) {
      ctx.addIssue({
        code: 'custom',
        message: `must be at most ${DESIGN_DOC_MAX_BYTES_LIMIT} bytes as JSON (is ${bytes})`,
        path: [],
      });
    }
  });
export type DesignDoc = z.output<typeof designDocSchema>;

/** Which configured limit a document breaks (DESIGN_DOC_TOO_LARGE details). */
export const DESIGN_DOC_LIMIT_REASONS = ['elements', 'bytes'] as const;
export type DesignDocLimitReason = (typeof DESIGN_DOC_LIMIT_REASONS)[number];

export interface DesignDocLimitViolation {
  reason: DesignDocLimitReason;
  /** The configured limit (DESIGN_MAX_ELEMENTS or DESIGN_DOC_MAX_BYTES). */
  max: number;
  /** The document's element count or byte length. */
  actual: number;
}

export interface DesignDocLimits {
  /** DESIGN_MAX_ELEMENTS. */
  maxElements: number;
  /** DESIGN_DOC_MAX_BYTES. */
  docMaxBytes: number;
}

/**
 * The first configured limit a (schema-valid) document breaks, elements first, or null. The api
 * answers DESIGN_DOC_TOO_LARGE with it; the editor uses it to warn before saving.
 */
export function checkDesignDocLimits(
  doc: DesignDoc,
  limits: DesignDocLimits,
): DesignDocLimitViolation | null {
  if (doc.elements.length > limits.maxElements) {
    return { reason: 'elements', max: limits.maxElements, actual: doc.elements.length };
  }
  const bytes = designDocByteLength(doc);
  if (bytes > limits.docMaxBytes)
    return { reason: 'bytes', max: limits.docMaxBytes, actual: bytes };
  return null;
}

/**
 * Every asset id a document references (background image and image elements), each once, in
 * document order. The api checks them against the owner's `design_assets` on write
 * (DESIGN_ASSET_NOT_FOUND) and signs their URLs; the orphan purge keeps assets any design of
 * the owner references.
 */
export function designDocAssetIds(doc: DesignDoc): string[] {
  const ids = new Set<string>();
  if (doc.background.type === 'image') ids.add(doc.background.assetId);
  for (const element of doc.elements) {
    if (element.type === 'image') ids.add(element.assetId);
  }
  return [...ids];
}
