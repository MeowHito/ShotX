'use client';

import {
  DESIGN_ARTBOARD,
  type DesignBackground,
  type DesignDoc,
  type DesignElement,
  type DesignElementOf,
  type ShareMode,
} from '@shotx/shared';
import { cn } from '@shotx/ui';
import { CameraIcon, CircleHelpIcon, ImageIcon, ImagesIcon, LoaderCircleIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type ReactNode,
  type Ref,
} from 'react';
import { encodeQr, qrSvgPath } from '@/lib/billing/qr';
import { designFontFamily } from '@/lib/design/fonts';
import { GALLERY_PHOTO_ACCEPT } from '@/lib/face/selfie';
import { FaceGlyph } from './face-glyph';

/**
 * The one renderer of a share page design (ADR 0013), used by the share page, the editor and the
 * mini previews so they all look the same. The document is laid out on the 390 x 844 artboard in
 * design units; one design unit is the CSS length `--u`:
 * - `fill` (share page): the background fills the element, the artboard is centred and as wide as
 *   the element up to `maxWidth` (container query units, so it is right in the SSR HTML too);
 * - `artboard` (editor, previews): the element is the artboard, `unit` px per design unit.
 *
 * Text is rendered as text nodes only (React escapes it; never HTML). Colours, numbers and enums
 * come from a document validated by designDocSchema; image URLs come from the API's asset map.
 * Labels of the buttons come from i18n (share.design), in the viewer's language.
 */

/** Widest the artboard is drawn on the share page (desktops show a phone-sized card). */
export const DESIGN_CANVAS_MAX_WIDTH = 480;

/** assetId -> signed CDN URL (null: not ready yet, draw nothing). */
export type DesignCanvasAssets = Readonly<Record<string, string | null>>;

export interface DesignCanvasActions {
  onCamera: () => void;
  /**
   * "Use a photo": the button opens the phone's photo picker itself (in the tap, as a file input
   * needs) and hands over the picked image, so there is no second picker to tap.
   */
  onChoosePhoto: (photo: File) => void;
  onHelp: () => void;
}

/** ADR 0033: one of the newest photos a display's latest-photos box shows. */
export interface DesignCanvasPhoto {
  id: string;
  /** Signed CDN URL (preview.webp, or a video's poster). */
  url: string;
}

/** What the editor and the previews encode in a QR element (a stand-in for the link). */
export const DESIGN_QR_SAMPLE_URL = 'https://snap.action.in.th/your-event';

export type DesignCanvasLayout =
  { kind: 'fill'; maxWidth?: number } | { kind: 'artboard'; unit: number };

export interface DesignCanvasProps {
  doc: DesignDoc;
  assets: DesignCanvasAssets;
  /**
   * The share's mode. Both scan buttons show in every mode (owner, 2026-11-16, ADR 0028: a
   * scan-only page offers "use a photo" too); kept for callers and future use.
   */
  mode: ShareMode;
  layout: DesignCanvasLayout;
  /** The share page's handlers; without them the buttons are inert (editor, previews). */
  actions?: DesignCanvasActions | null;
  /** False: no scan buttons at all (face search unavailable for this share). */
  scanAvailable?: boolean;
  /** The scan buttons' element (the share page watches whether it is on screen). */
  scanButtonsRef?: Ref<HTMLDivElement>;
  /** Editor: a text element being edited in place (drawn invisible under its text field). */
  editingId?: string | null;
  /** Editor: image assets still processing (a spinner instead of nothing). */
  pendingAssets?: ReadonlySet<string>;
  /**
   * ADR 0033: the newest photos for a latest-photos box, newest first (the display screen).
   * Undefined (editor, previews): a placeholder; empty: the box's colour alone.
   */
  photos?: readonly DesignCanvasPhoto[];
  /**
   * ADR 0033: the link a QR element encodes. Undefined (editor, previews): a sample link; null:
   * not known yet (an empty square, never a wrong code).
   */
  qrUrl?: string | null;
  /** Mini previews: hidden from assistive technology. */
  decorative?: boolean;
  /** Accessible name of the design (share page). */
  label?: string;
  className?: string;
  style?: CSSProperties;
}

/** A length of `n` design units. */
export const du = (n: number) => `calc(var(--u) * ${n})`;

/** The CSS `--u` of a layout. */
function unitCss(layout: DesignCanvasLayout): string {
  return layout.kind === 'artboard'
    ? `${layout.unit}px`
    : // `--design-cap` (optional, set by the page) can lower the cap, e.g. to fit the height.
      `calc(min(100cqw, var(--design-cap, ${layout.maxWidth ?? DESIGN_CANVAS_MAX_WIDTH}px)) / ${DESIGN_ARTBOARD.width})`;
}

/** The CSS background of a colour or gradient background (an image background: its colour). */
export function backgroundCss(bg: DesignBackground): string {
  switch (bg.type) {
    case 'color':
    case 'image':
      return bg.color;
    case 'gradient':
      // CSS angle semantics (0deg: bottom to top, 90deg: left to right), as the document's.
      return `linear-gradient(${bg.angle}deg, ${bg.stops
        .map((s) => `${s.color} ${Math.round(s.at * 1000) / 10}%`)
        .join(', ')})`;
  }
}

/** Extra blur of the screen-filling copy of an image background around the artboard (CSS px). */
const BACKDROP_BLUR_PX = 24;

/**
 * How far in (design units) the artboard's own image background fades into the blurred copy
 * around it on the share page, so the card shows no hard rectangular edge (owner, 2026-11-14).
 */
const FEATHER_DU = 28;
const featherGradient = (to: string) =>
  `linear-gradient(to ${to}, transparent, #000 ${du(FEATHER_DU)}, #000 calc(100% - ${du(FEATHER_DU)}), transparent)`;
/** Both directions intersected: all four edges fade, the corners most. */
const FEATHER_MASK: CSSProperties = {
  maskImage: `${featherGradient('right')}, ${featherGradient('bottom')}`,
  maskComposite: 'intersect',
  WebkitMaskImage: `${featherGradient('right')}, ${featherGradient('bottom')}`,
  WebkitMaskComposite: 'source-in',
};

function Background({
  bg,
  assets,
  backdrop = false,
  feather = false,
}: {
  bg: DesignBackground;
  assets: DesignCanvasAssets;
  /** The artboard's copy on the share page: its edges fade into the backdrop. */
  feather?: boolean;
  /**
   * The copy that fills the screen around the artboard (`fill` layout): blurred, so the
   * artboard's own copy, which shows the whole image as designed, stands out.
   */
  backdrop?: boolean;
}) {
  if (bg.type !== 'image') return null;
  const url = assets[bg.assetId] ?? null;
  const blur = backdrop
    ? `calc(${du(bg.blur)} + ${BACKDROP_BLUR_PX}px)`
    : bg.blur > 0
      ? du(bg.blur)
      : null;
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={feather ? FEATHER_MASK : undefined}
      data-testid={feather ? 'design-background-feathered' : undefined}
      aria-hidden
    >
      {url !== null ? (
        // Signed CDN URL of the design image (web.webp); blur and dim are display only.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          draggable={false}
          data-testid={backdrop ? 'design-background-backdrop' : 'design-background-image'}
          className="absolute inset-0 size-full object-cover"
          style={{
            filter: blur !== null ? `blur(${blur})` : undefined,
            // Blur bleeds transparent edges in; scale slightly so they stay outside.
            transform: blur !== null ? 'scale(1.08)' : undefined,
          }}
        />
      ) : null}
      {bg.dim > 0 ? (
        <div className="absolute inset-0" style={{ background: `rgba(0, 0, 0, ${bg.dim})` }} />
      ) : null}
    </div>
  );
}

function boxStyle(e: DesignElement): CSSProperties {
  return {
    position: 'absolute',
    left: du(e.x),
    top: du(e.y),
    width: du(e.w),
    height: du(e.h),
    transform: e.rotation !== 0 ? `rotate(${e.rotation}deg)` : undefined,
    opacity: e.opacity,
  };
}

export function textStyle(e: DesignElementOf<'text'>): CSSProperties {
  return {
    fontFamily: designFontFamily(e.font),
    fontSize: du(e.size),
    fontWeight: e.weight,
    fontStyle: e.italic ? 'italic' : 'normal',
    color: e.color,
    textAlign: e.align,
    lineHeight: e.lineHeight,
    letterSpacing: du(e.letterSpacing),
    textTransform: e.uppercase ? 'uppercase' : 'none',
    textShadow:
      e.shadow === null
        ? undefined
        : `${du(e.shadow.x)} ${du(e.shadow.y)} ${du(e.shadow.blur)} ${e.shadow.color}`,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  };
}

function TextElement({ e, editing }: { e: DesignElementOf<'text'>; editing: boolean }) {
  return (
    <div
      data-element-type="text"
      style={{ ...textStyle(e), width: '100%', visibility: editing ? 'hidden' : undefined }}
    >
      {/* A text node: whatever was typed shows as typed, never as markup. */}
      {e.text}
    </div>
  );
}

function ShapeElement({ e }: { e: DesignElementOf<'shape'> }) {
  if (e.shape === 'line') {
    return e.stroke === null ? null : (
      <div
        data-element-type="shape"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: '50%',
          height: du(Math.max(e.strokeWidth, 0.5)),
          transform: 'translateY(-50%)',
          background: e.stroke,
        }}
      />
    );
  }
  const blur = e.glass > 0 ? `blur(${du(e.glass)})` : undefined;
  return (
    <div
      data-element-type="shape"
      data-glass={e.glass > 0 ? 'true' : undefined}
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        background: e.fill ?? 'transparent',
        border:
          e.stroke !== null && e.strokeWidth > 0
            ? `${du(e.strokeWidth)} solid ${e.stroke}`
            : undefined,
        borderRadius: e.shape === 'ellipse' ? '50%' : du(e.radius),
        backdropFilter: blur,
        WebkitBackdropFilter: blur,
      }}
    />
  );
}

function ImageElement({
  e,
  url,
  pending,
}: {
  e: DesignElementOf<'image'>;
  url: string | null;
  pending: boolean;
}) {
  if (url === null) {
    return pending ? (
      <div className="flex size-full items-center justify-center rounded bg-black/5" role="status">
        <LoaderCircleIcon
          className="size-1/4 max-h-8 max-w-8 animate-spin text-black/40"
          aria-hidden
        />
      </div>
    ) : null;
  }
  return (
    // Signed CDN URL of a design image (web.webp).
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt=""
      draggable={false}
      data-element-type="image"
      style={{
        width: '100%',
        height: '100%',
        objectFit: e.fit,
        borderRadius: du(e.radius),
        transform: e.flipX ? 'scaleX(-1)' : undefined,
        display: 'block',
      }}
    />
  );
}

/** A button of the design; a real button only when it has a handler. */
function DesignButton({
  onClick,
  style,
  children,
}: {
  onClick?: () => void;
  style: CSSProperties;
  children: ReactNode;
}) {
  const common = {
    style: {
      ...style,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: du(8),
      fontFamily: 'var(--font-noto-thai), sans-serif',
      fontWeight: 600,
      lineHeight: 1.2,
      boxSizing: 'border-box' as const,
      whiteSpace: 'nowrap' as const,
      overflow: 'hidden',
    },
  };
  return onClick !== undefined ? (
    <button
      type="button"
      onClick={onClick}
      className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      {...common}
    >
      {children}
    </button>
  ) : (
    <div {...common}>{children}</div>
  );
}

function ScanButtons({
  e,
  actions,
  buttonsRef,
}: {
  e: DesignElementOf<'scanButtons'>;
  actions: DesignCanvasActions | null;
  buttonsRef?: Ref<HTMLDivElement>;
}) {
  const t = useTranslations('share.design');
  const photoInput = useRef<HTMLInputElement>(null);
  // The contract's box rule: each button `height` tall, as wide as the box (column) or half the
  // box minus the gap (row), centred vertically in the box.
  const width = e.layout === 'column' ? '100%' : `calc(50% - ${du(e.gap / 2)})`;
  const font = du(Math.min(17, e.height * 0.34));
  const icon = {
    width: du(Math.min(20, e.height * 0.4)),
    height: du(Math.min(20, e.height * 0.4)),
  };
  const base: CSSProperties = {
    width,
    height: du(e.height),
    borderRadius: du(e.radius),
    fontSize: font,
    flexShrink: 0,
  };
  return (
    <div
      ref={buttonsRef}
      data-element-type="scanButtons"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: e.layout === 'row' ? 'row' : 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: du(e.gap),
      }}
    >
      <DesignButton
        onClick={actions?.onCamera}
        style={{ ...base, background: e.primary.bg, color: e.primary.fg }}
      >
        <CameraIcon style={icon} aria-hidden />
        {t('camera')}
      </DesignButton>
      <DesignButton
        onClick={actions === null ? undefined : () => photoInput.current?.click()}
        style={{
          ...base,
          background: e.secondary.bg,
          color: e.secondary.fg,
          border:
            e.secondary.border !== null ? `${du(1.5)} solid ${e.secondary.border}` : undefined,
        }}
      >
        <ImageIcon style={icon} aria-hidden />
        {t('choosePhoto')}
      </DesignButton>
      {actions !== null ? (
        <input
          ref={photoInput}
          type="file"
          accept={GALLERY_PHOTO_ACCEPT}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          data-testid="design-photo-input"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            const file = event.target.files?.[0];
            // Cleared so the same photo can be picked again; no reference lingers here.
            event.target.value = '';
            if (file !== undefined) actions.onChoosePhoto(file);
          }}
        />
      ) : null}
    </div>
  );
}

function HelpButton({
  e,
  actions,
}: {
  e: DesignElementOf<'helpButton'>;
  actions: DesignCanvasActions | null;
}) {
  const t = useTranslations('share.design');
  const icon = { width: du(Math.min(18, e.h * 0.45)), height: du(Math.min(18, e.h * 0.45)) };
  return (
    <DesignButton
      onClick={actions?.onHelp}
      style={{
        width: '100%',
        height: '100%',
        background: e.bg,
        color: e.fg,
        borderRadius: du(e.radius),
        fontSize: du(Math.min(15, e.h * 0.42)),
        fontWeight: 500,
      }}
    >
      <CircleHelpIcon style={icon} aria-hidden />
      {t('help')}
    </DesignButton>
  );
}

/** Quiet zone of a QR element, in modules (the standard four). */
const QR_QUIET_ZONE = 4;

function QrCodeElement({ e, url }: { e: DesignElementOf<'qrCode'>; url: string | null }) {
  const t = useTranslations('share.design');
  const matrix = useMemo(() => (url === null ? null : encodeQr(url)), [url]);
  const side = du(Math.min(e.w, e.h));
  const size = matrix === null ? 1 : matrix.size + QR_QUIET_ZONE * 2;
  return (
    <div
      data-element-type="qrCode"
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: side,
          height: side,
          background: e.bg,
          borderRadius: du(e.radius),
          overflow: 'hidden',
        }}
      >
        {matrix !== null ? (
          <svg
            role="img"
            aria-label={t('qr')}
            viewBox={`0 0 ${size} ${size}`}
            shapeRendering="crispEdges"
            style={{ width: '100%', height: '100%', display: 'block' }}
          >
            <path d={qrSvgPath(matrix, QR_QUIET_ZONE)} fill={e.fg} />
          </svg>
        ) : null}
      </div>
    </div>
  );
}

/**
 * ADR 0033: the newest photos. One photo: always the newest. More: cycles through the newest
 * `count`, `intervalSec` each, cross-fading; a new photo resets to it at once.
 */
function LatestPhotosElement({
  e,
  photos,
}: {
  e: DesignElementOf<'latestPhotos'>;
  photos: readonly DesignCanvasPhoto[] | undefined;
}) {
  const t = useTranslations('share.design');
  const shown = useMemo(() => (photos ?? []).slice(0, e.count), [photos, e.count]);
  const newest = shown[0]?.id ?? null;
  const [index, setIndex] = useState(0);
  // A new photo (or a new set) starts over from the newest.
  const [seen, setSeen] = useState(newest);
  if (seen !== newest) {
    setSeen(newest);
    setIndex(0);
  }
  const total = shown.length;
  useEffect(() => {
    if (total <= 1) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % total), e.intervalSec * 1000);
    return () => window.clearInterval(timer);
  }, [total, e.intervalSec, newest]);
  const box: CSSProperties = {
    position: 'relative',
    width: '100%',
    height: '100%',
    background: e.bg,
    borderRadius: du(e.radius),
    overflow: 'hidden',
  };
  if (photos === undefined) {
    // Editor and previews: a stand-in that says what goes here.
    return (
      <div data-element-type="latestPhotos" style={box}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: du(8),
            color: '#ffffffcc',
            background: 'linear-gradient(135deg, #64748b99, #33415599)',
            fontFamily: 'var(--font-noto-thai), sans-serif',
            fontSize: du(Math.min(18, e.w / 12)),
            fontWeight: 600,
          }}
        >
          <ImagesIcon
            style={{ width: du(Math.min(56, e.w / 4)), height: du(Math.min(56, e.w / 4)) }}
            aria-hidden
          />
          {t('latestPhotos')}
        </div>
      </div>
    );
  }
  return (
    <div data-element-type="latestPhotos" style={box}>
      {shown.map((photo, i) => (
        // Signed CDN URLs of the share's newest photos (preview.webp or a video's poster).
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={photo.id}
          src={photo.url}
          alt=""
          draggable={false}
          data-testid="latest-photo"
          data-current={i === index ? 'true' : undefined}
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: e.fit,
            opacity: i === index ? 1 : 0,
            transition: 'opacity 900ms ease',
          }}
        />
      ))}
    </div>
  );
}

function ElementView({ e, props }: { e: DesignElement; props: DesignCanvasProps }) {
  const actions = props.actions ?? null;
  let content: ReactNode;
  switch (e.type) {
    case 'text':
      content = <TextElement e={e} editing={props.editingId === e.id} />;
      break;
    case 'shape':
      content = <ShapeElement e={e} />;
      break;
    case 'image':
      content = (
        <ImageElement
          e={e}
          url={props.assets[e.assetId] ?? null}
          pending={props.pendingAssets?.has(e.assetId) ?? false}
        />
      );
      break;
    case 'faceIcon':
      content = (
        <FaceGlyph color={e.color} strokeWidth={e.strokeWidth} boxSize={Math.min(e.w, e.h)} />
      );
      break;
    case 'scanButtons':
      if (props.scanAvailable === false) return null;
      content = <ScanButtons e={e} actions={actions} buttonsRef={props.scanButtonsRef} />;
      break;
    case 'helpButton':
      content = <HelpButton e={e} actions={actions} />;
      break;
    case 'latestPhotos':
      content = <LatestPhotosElement e={e} photos={props.photos} />;
      break;
    case 'qrCode':
      content = (
        <QrCodeElement e={e} url={props.qrUrl === undefined ? DESIGN_QR_SAMPLE_URL : props.qrUrl} />
      );
      break;
  }
  return (
    <div style={boxStyle(e)} data-element-id={e.id}>
      {content}
    </div>
  );
}

export function DesignCanvas(props: DesignCanvasProps) {
  const { doc, layout } = props;
  const unit = unitCss(layout);
  const artboard = (
    <div
      className="relative shrink-0"
      data-testid="design-artboard"
      style={
        {
          '--u': unit,
          width: du(DESIGN_ARTBOARD.width),
          height: du(DESIGN_ARTBOARD.height),
        } as CSSProperties
      }
    >
      {/* fill: the image background covers the artboard exactly as in the designer, so a screen
          of another shape never crops it (a logo in the image stays whole); the screen around
          it gets a blurred copy, into which the artboard's edges fade. */}
      {layout.kind === 'fill' ? (
        <Background bg={doc.background} assets={props.assets} feather />
      ) : null}
      {doc.elements.map((e) => (e.hidden ? null : <ElementView key={e.id} e={e} props={props} />))}
    </div>
  );
  const background = backgroundCss(doc.background);
  return (
    <div
      className={cn(
        'relative overflow-hidden',
        layout.kind === 'fill' && 'flex items-center justify-center',
        props.className,
      )}
      data-testid="design-canvas"
      aria-hidden={props.decorative ? true : undefined}
      role={props.label !== undefined ? 'region' : undefined}
      aria-label={props.label}
      style={{
        background,
        ...(layout.kind === 'fill'
          ? { containerType: 'inline-size' }
          : {
              '--u': unit,
              width: du(DESIGN_ARTBOARD.width),
              height: du(DESIGN_ARTBOARD.height),
            }),
        ...props.style,
      }}
    >
      <div className="absolute inset-0" style={{ '--u': unit } as CSSProperties} aria-hidden>
        <Background bg={doc.background} assets={props.assets} backdrop={layout.kind === 'fill'} />
      </div>
      {artboard}
    </div>
  );
}
