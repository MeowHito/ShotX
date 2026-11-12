'use client';

import { DESIGN_ARTBOARD, type DesignDoc, type ShareMode } from '@shotx/shared';
import { cn } from '@shotx/ui';
import { DesignCanvas, type DesignCanvasAssets } from './design-canvas';

/**
 * A live mini preview of a design: the renderer at a fixed width (the list, the template picker,
 * the share form's picker). Decorative: the name next to it says what it is.
 */
export function DesignPreview({
  doc,
  assets,
  width,
  mode = 'gallery',
  className,
}: {
  doc: DesignDoc;
  assets: DesignCanvasAssets;
  /** CSS pixels. */
  width: number;
  mode?: ShareMode;
  className?: string;
}) {
  const unit = width / DESIGN_ARTBOARD.width;
  return (
    <div
      className={cn('pointer-events-none overflow-hidden', className)}
      style={{ width, height: unit * DESIGN_ARTBOARD.height }}
      inert
    >
      <DesignCanvas
        doc={doc}
        assets={assets}
        mode={mode}
        layout={{ kind: 'artboard', unit }}
        decorative
      />
    </div>
  );
}
