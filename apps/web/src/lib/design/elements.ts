import {
  DESIGN_ARTBOARD,
  DESIGN_COORDINATE_RANGE,
  DESIGN_ELEMENT_CARDINALITY_BY_KIND,
  DESIGN_LATEST_PHOTOS_INTERVAL_RANGE,
  DESIGN_LATEST_PHOTOS_MAX,
  DESIGN_SHADOW_OFFSET_RANGE,
  DESIGN_SIZE_RANGE,
  DESIGN_REQUIRED_ELEMENT_MIN_OPACITY,
  DESIGN_UNDELETABLE_ELEMENT_TYPES,
  type DesignColor,
  type DesignDoc,
  type DesignElement,
  type DesignElementOf,
  type DesignElementType,
  designKind,
} from '@shotx/shared';

/**
 * Building and normalising design elements in the editor (ADR 0013). Every number the editor
 * writes is clamped to the ranges of designDocSchema and rounded, so a document the editor makes
 * always validates and stays small.
 */

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
/** Two decimals: enough for sub-pixel placement at any zoom, short JSON. */
export const round = (v: number) => Math.round(v * 100) / 100;
const fit = (v: number, min: number, max: number) =>
  round(clamp(Number.isFinite(v) ? v : min, min, max));

let counter = 0;

/** A new element id (DESIGN_ELEMENT_ID_PATTERN), unique within any document the editor makes. */
export function newElementId(type: DesignElementType | 'el' = 'el'): string {
  counter = (counter + 1) % 1_000_000;
  const random = Math.random().toString(36).slice(2, 8);
  return `${type}-${Date.now().toString(36)}${counter.toString(36)}${random}`;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A box of `w` x `h` centred on the artboard (or around `center`). */
export function centredBox(w: number, h: number, center?: { x: number; y: number }): Box {
  const cx = center?.x ?? DESIGN_ARTBOARD.width / 2;
  const cy = center?.y ?? DESIGN_ARTBOARD.height / 2;
  return { x: round(cx - w / 2), y: round(cy - h / 2), w, h };
}

const base = (type: DesignElementType, box: Box) => ({
  id: newElementId(type),
  ...box,
  rotation: 0,
  opacity: 1,
  locked: false,
  hidden: false,
});

export type TextPreset = 'heading' | 'subheading' | 'body';

const TEXT_PRESETS: Record<
  TextPreset,
  { size: number; weight: number; h: number; font: DesignElementOf<'text'>['font'] }
> = {
  heading: { size: 34, weight: 700, h: 48, font: 'kanit' },
  subheading: { size: 22, weight: 600, h: 32, font: 'kanit' },
  body: { size: 16, weight: 400, h: 24, font: 'sarabun' },
};

export function makeText(preset: TextPreset, text: string, color: DesignColor = '#111827') {
  const p = TEXT_PRESETS[preset];
  const element: DesignElementOf<'text'> = {
    ...base('text', centredBox(300, p.h)),
    type: 'text',
    text,
    font: p.font,
    size: p.size,
    weight: p.weight,
    color,
    align: 'center',
    lineHeight: 1.3,
    letterSpacing: 0,
    italic: false,
    uppercase: false,
    shadow: null,
  };
  return element;
}

export type ShapePreset = 'rect' | 'ellipse' | 'line' | 'glass';

export function makeShape(preset: ShapePreset): DesignElementOf<'shape'> {
  switch (preset) {
    case 'rect':
      return {
        ...base('shape', centredBox(200, 140)),
        type: 'shape',
        shape: 'rect',
        fill: '#e5e7eb',
        stroke: null,
        strokeWidth: 0,
        radius: 12,
        glass: 0,
      };
    case 'ellipse':
      return {
        ...base('shape', centredBox(160, 160)),
        type: 'shape',
        shape: 'ellipse',
        fill: '#c7d2fe',
        stroke: null,
        strokeWidth: 0,
        radius: 0,
        glass: 0,
      };
    case 'line':
      return {
        ...base('shape', centredBox(200, 8)),
        type: 'shape',
        shape: 'line',
        fill: null,
        stroke: '#111827',
        strokeWidth: 2,
        radius: 0,
        glass: 0,
      };
    case 'glass':
      return {
        ...base('shape', centredBox(320, 420)),
        type: 'shape',
        shape: 'rect',
        fill: '#ffffff40',
        stroke: '#ffffff80',
        strokeWidth: 1,
        radius: 28,
        glass: 24,
      };
  }
}

/** An image element for an asset of `width` x `height`, `maxW` wide at most, centred. */
export function makeImage(
  assetId: string,
  size: { width: number | null; height: number | null },
  maxW = 240,
): DesignElementOf<'image'> {
  const ratio = size.width && size.height ? size.height / size.width : 1;
  const w = maxW;
  const h = round(Math.max(DESIGN_SIZE_RANGE.min, w * ratio));
  return {
    ...base('image', centredBox(w, h)),
    type: 'image',
    assetId,
    fit: 'contain',
    radius: 0,
    flipX: false,
  };
}

export function makeHelpButton(): DesignElementOf<'helpButton'> {
  return {
    ...base('helpButton', centredBox(132, 36, { x: DESIGN_ARTBOARD.width / 2, y: 720 })),
    type: 'helpButton',
    bg: '#f3f4f6',
    fg: '#374151',
    radius: 18,
  };
}

/** ADR 0033: a QR code of the link, black on white, centred low on the artboard. */
export function makeQrCode(): DesignElementOf<'qrCode'> {
  return {
    ...base('qrCode', centredBox(120, 120, { x: DESIGN_ARTBOARD.width / 2, y: 700 })),
    type: 'qrCode',
    fg: '#000000',
    bg: '#ffffff',
    radius: 10,
  };
}

/** The scan buttons' box height their layout needs (designScanButtonsElementSchema). */
export function scanButtonsBoxHeight(
  e: Pick<DesignElementOf<'scanButtons'>, 'layout' | 'height' | 'gap'>,
) {
  return e.layout === 'row' ? e.height : 2 * e.height + e.gap;
}

/**
 * The element with every number in its schema range, rounded, and the scan buttons' box height
 * kept to their layout (the contract's box rule).
 */
export function normalizeElement(e: DesignElement): DesignElement {
  const coord = (v: number) => fit(v, DESIGN_COORDINATE_RANGE.min, DESIGN_COORDINATE_RANGE.max);
  const size = (v: number) => fit(v, DESIGN_SIZE_RANGE.min, DESIGN_SIZE_RANGE.max);
  let rotation = Number.isFinite(e.rotation) ? e.rotation : 0;
  while (rotation > 180) rotation -= 360;
  while (rotation < -180) rotation += 360;
  const common = {
    x: coord(e.x),
    y: coord(e.y),
    w: size(e.w),
    h: size(e.h),
    rotation: round(rotation),
    // The face icon and the scan buttons must stay visible (designDocSchema).
    opacity: fit(e.opacity, isDeletable(e) ? 0 : DESIGN_REQUIRED_ELEMENT_MIN_OPACITY, 1),
  };
  switch (e.type) {
    case 'text':
      return {
        ...e,
        ...common,
        size: fit(e.size, 8, 200),
        weight: clamp(Math.round(e.weight / 100) * 100, 300, 900),
        lineHeight: fit(e.lineHeight, 0.8, 3),
        letterSpacing: fit(e.letterSpacing, -5, 50),
        shadow:
          e.shadow === null
            ? null
            : {
                ...e.shadow,
                blur: fit(e.shadow.blur, 0, 40),
                x: fit(e.shadow.x, DESIGN_SHADOW_OFFSET_RANGE.min, DESIGN_SHADOW_OFFSET_RANGE.max),
                y: fit(e.shadow.y, DESIGN_SHADOW_OFFSET_RANGE.min, DESIGN_SHADOW_OFFSET_RANGE.max),
              },
      };
    case 'image':
      return { ...e, ...common, radius: fit(e.radius, 0, 200) };
    case 'shape':
      return {
        ...e,
        ...common,
        strokeWidth: fit(e.strokeWidth, 0, 40),
        radius: fit(e.radius, 0, 200),
        glass: fit(e.glass, 0, 40),
      };
    case 'faceIcon':
      return { ...e, ...common, strokeWidth: fit(e.strokeWidth, 1, 12) };
    case 'scanButtons': {
      const buttons = {
        ...e,
        ...common,
        gap: fit(e.gap, 0, 40),
        height: fit(e.height, 36, 80),
        radius: fit(e.radius, 0, 40),
      };
      return { ...buttons, h: size(scanButtonsBoxHeight(buttons)) };
    }
    case 'helpButton':
      return { ...e, ...common, radius: fit(e.radius, 0, 40) };
    case 'latestPhotos':
      return {
        ...e,
        ...common,
        count: clamp(
          Math.round(Number.isFinite(e.count) ? e.count : 1),
          1,
          DESIGN_LATEST_PHOTOS_MAX,
        ),
        intervalSec: fit(
          e.intervalSec,
          DESIGN_LATEST_PHOTOS_INTERVAL_RANGE.min,
          DESIGN_LATEST_PHOTOS_INTERVAL_RANGE.max,
        ),
        radius: fit(e.radius, 0, 200),
      };
    case 'qrCode':
      return { ...e, ...common, radius: fit(e.radius, 0, 40) };
  }
}

/**
 * Whether an element may be deleted (DESIGN_UNDELETABLE_ELEMENT_TYPES: face icon, scan buttons,
 * a display's latest photos).
 */
export function isDeletable(e: Pick<DesignElement, 'type'>): boolean {
  return !(DESIGN_UNDELETABLE_ELEMENT_TYPES as readonly string[]).includes(e.type);
}

/** Whether one more element of this type fits the document's cardinality rule. */
export function canAddType(
  doc: Pick<DesignDoc, 'elements' | 'kind'>,
  type: DesignElementType,
  adding = 1,
): boolean {
  const rule: string = DESIGN_ELEMENT_CARDINALITY_BY_KIND[designKind(doc)][type];
  if (rule === 'any') return true;
  if (rule === 'none') return false;
  const count = doc.elements.filter((e) => e.type === type).length;
  return count + adding <= 1;
}

/** Every distinct colour used in a document (for the colour swatches), in document order. */
export function docColors(doc: DesignDoc): DesignColor[] {
  const colors = new Set<string>();
  const add = (c: string | null | undefined) => {
    if (c !== null && c !== undefined) colors.add(c.toLowerCase());
  };
  const bg = doc.background;
  if (bg.type === 'color') add(bg.color);
  if (bg.type === 'gradient') bg.stops.forEach((s) => add(s.color));
  if (bg.type === 'image') add(bg.color);
  for (const e of doc.elements) {
    switch (e.type) {
      case 'text':
        add(e.color);
        break;
      case 'shape':
        add(e.fill);
        add(e.stroke);
        break;
      case 'faceIcon':
        add(e.color);
        break;
      case 'scanButtons':
        add(e.primary.bg);
        add(e.primary.fg);
        add(e.secondary.bg);
        add(e.secondary.fg);
        add(e.secondary.border);
        break;
      case 'helpButton':
      case 'qrCode':
        add(e.bg);
        add(e.fg);
        break;
      case 'latestPhotos':
        add(e.bg);
        break;
      case 'image':
        break;
    }
  }
  return [...colors];
}
