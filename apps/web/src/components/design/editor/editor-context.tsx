'use client';

import type { DesignAssetView, DesignColor, DesignLimits } from '@shotx/shared';
import { createContext, type Dispatch, useContext } from 'react';
import type { EditorAction, EditorState } from '@/lib/design/editor-state';

/** What the designer's panels share: the state, its dispatch, the images, the limits. */
export interface EditorContextValue {
  state: EditorState;
  dispatch: Dispatch<EditorAction>;
  /** Every design image the editor knows (the design's, uploads, the uploads list), by id. */
  assets: Readonly<Record<string, DesignAssetView>>;
  /** Adds or updates images (an upload finished, a poll answered). */
  putAssets: (assets: readonly DesignAssetView[]) => void;
  limits: DesignLimits;
  /** Colours used in the document (swatches). */
  swatches: readonly DesignColor[];
  /** Starts a text edit in place (the Text panel adds a text and edits it). */
  editText: (id: string | null) => void;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);
  if (value === null) throw new Error('useEditor outside the design editor');
  return value;
}
