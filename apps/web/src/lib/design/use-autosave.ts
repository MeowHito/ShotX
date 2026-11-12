'use client';

import {
  checkDesignDocLimits,
  DESIGN_ROUTES,
  type Design,
  type DesignDoc,
  type DesignDocLimits,
  designDocSchema,
  designNameSchema,
  ErrorCode,
} from '@shotx/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';

/**
 * Autosave of the designer (ADR 0013): DESIGN_AUTOSAVE_DELAY_MS after the last change the
 * document and name are validated (designDocSchema, the name schema and the configured limits)
 * and saved with PUT /designs/:id and the revision the editor holds; the answer's revision is
 * used for the next save. Changes made while a save runs are saved right after it. A stale
 * revision (DESIGN_REVISION_CONFLICT) stops autosaving until the editor reloads the design.
 */

/** Wait after the last change before saving (ADR 0013: 1 s). */
export const DESIGN_AUTOSAVE_DELAY_MS = 1000;

export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'invalid' | 'conflict';

export interface AutosaveOptions {
  api: ApiClient;
  designId: string;
  doc: DesignDoc;
  name: string;
  /** Bumped on every change (EditorState.version); the loaded state is `baseVersion`. */
  version: number;
  baseVersion: number;
  /** The revision of the loaded design. */
  revision: number;
  limits: DesignDocLimits;
  delayMs?: number;
  onSaved?: (design: Design) => void;
}

export interface Autosave {
  status: SaveStatus;
  /** The last save error (status `error` or `conflict`). */
  error: unknown;
  /** Save now (⌘S, "retry"); no-op without changes. */
  saveNow: () => void;
}

export function useAutosave(options: AutosaveOptions): Autosave {
  const { delayMs = DESIGN_AUTOSAVE_DELAY_MS } = options;
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [error, setError] = useState<unknown>(null);
  const latest = useRef(options);
  const revision = useRef(options.revision);
  const savedVersion = useRef(options.baseVersion);
  const inFlight = useRef(false);
  const again = useRef(false);
  const conflict = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    latest.current = options;
  });

  const set = useCallback((next: SaveStatus) => {
    if (mounted.current) setStatus(next);
  }, []);

  /** The latest `flush`, for a save that follows another (a callback can't name itself). */
  const flushAgain = useRef<() => Promise<void>>(() => Promise.resolve());
  const flush = useCallback(async () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const current = latest.current;
    if (conflict.current || current.version === savedVersion.current) return;
    if (inFlight.current) {
      again.current = true;
      return;
    }
    const doc = designDocSchema.safeParse(current.doc);
    const name = designNameSchema.safeParse(current.name);
    if (!doc.success || !name.success || checkDesignDocLimits(doc.data, current.limits) !== null) {
      set('invalid');
      return;
    }
    inFlight.current = true;
    set('saving');
    const version = current.version;
    try {
      const saved = await current.api.call(DESIGN_ROUTES.update, {
        params: { id: current.designId },
        body: { name: name.data, doc: doc.data, revision: revision.current },
      });
      revision.current = saved.revision;
      savedVersion.current = version;
      if (mounted.current) setError(null);
      latest.current.onSaved?.(saved);
      set(latest.current.version === version ? 'saved' : 'unsaved');
    } catch (err) {
      if (mounted.current) setError(err);
      if (isApiError(err, ErrorCode.DESIGN_REVISION_CONFLICT)) {
        conflict.current = true;
        set('conflict');
      } else {
        set('error');
      }
      again.current = false;
      return;
    } finally {
      inFlight.current = false;
    }
    if (again.current || latest.current.version !== savedVersion.current) {
      again.current = false;
      void flushAgain.current();
    }
  }, [set]);

  useEffect(() => {
    flushAgain.current = flush;
  }, [flush]);

  // A change: (re)start the timer.
  useEffect(() => {
    if (options.version === savedVersion.current || conflict.current) return;
    if (!inFlight.current) setStatus('unsaved');
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delayMs);
  }, [options.version, delayMs, flush]);

  // Unsaved changes when leaving the page: save them, and warn on a reload or close.
  useEffect(() => {
    mounted.current = true;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (latest.current.version !== savedVersion.current && !conflict.current) {
        event.preventDefault();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      mounted.current = false;
      if (latest.current.version !== savedVersion.current) void flush();
    };
  }, [flush]);

  const saveNow = useCallback(() => void flush(), [flush]);
  return { status, error, saveNow };
}
