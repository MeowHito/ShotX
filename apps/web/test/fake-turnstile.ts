import { act } from '@testing-library/react';
import type { TurnstileApi, TurnstileLoader } from '@/lib/captcha/turnstile';

type RenderOptions = Parameters<TurnstileApi['render']>[1];

/**
 * Stand-in for Cloudflare Turnstile (no network, no script): records loads and widgets, and lets
 * a test solve or fail the newest widget.
 */
export class FakeTurnstile {
  loads = 0;
  /** The script fails to load. */
  failLoad = false;
  readonly widgets: {
    id: string;
    container: HTMLElement;
    options: RenderOptions;
    removed: boolean;
  }[] = [];

  readonly api: TurnstileApi = {
    render: (container, options) => {
      const id = `widget-${this.widgets.length + 1}`;
      this.widgets.push({ id, container, options, removed: false });
      return id;
    },
    remove: (id) => {
      const widget = this.widgets.find((w) => w.id === id);
      if (widget !== undefined) widget.removed = true;
    },
  };

  readonly loader: TurnstileLoader = () => {
    this.loads++;
    return this.failLoad ? Promise.reject(new Error('blocked')) : Promise.resolve(this.api);
  };

  /** Widgets still on the page. */
  live() {
    return this.widgets.filter((w) => !w.removed);
  }

  private latest() {
    const widget = this.live().at(-1);
    if (widget === undefined) throw new Error('no Turnstile widget on the page');
    return widget;
  }

  solve(token: string) {
    const widget = this.latest();
    act(() => widget.options.callback(token));
  }

  fail(kind: 'error' | 'timeout') {
    const widget = this.latest();
    act(() => widget.options[kind === 'error' ? 'error-callback' : 'timeout-callback']());
  }
}
