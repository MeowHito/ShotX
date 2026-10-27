import { TURNSTILE_SCRIPT_URL } from '@shotx/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { createTurnstileLoader, type TurnstileApi } from './turnstile';

const scripts = () =>
  [...document.head.querySelectorAll('script')].filter((s) => s.src === TURNSTILE_SCRIPT_URL);

afterEach(() => {
  for (const s of scripts()) s.remove();
  delete window.turnstile;
});

describe('Turnstile loader', () => {
  it('adds the explicit-render script once, on first use, and resolves window.turnstile', async () => {
    const load = createTurnstileLoader(TURNSTILE_SCRIPT_URL);
    expect(scripts()).toHaveLength(0);
    const first = load();
    const second = load();
    expect(scripts()).toHaveLength(1);
    expect(scripts()[0]?.src).toContain('render=explicit');
    const api = { render: () => 'w', remove: () => undefined } as TurnstileApi;
    window.turnstile = api;
    scripts()[0]?.dispatchEvent(new Event('load'));
    await expect(first).resolves.toBe(api);
    await expect(second).resolves.toBe(api);
    await expect(load()).resolves.toBe(api);
    expect(scripts()).toHaveLength(1);
  });

  it('can be retried after the script fails to load', async () => {
    const load = createTurnstileLoader(TURNSTILE_SCRIPT_URL);
    const failed = load();
    scripts()[0]?.dispatchEvent(new Event('error'));
    await expect(failed).rejects.toThrow('failed to load');
    expect(scripts()).toHaveLength(0);
    void load().catch(() => undefined);
    expect(scripts()).toHaveLength(1);
  });
});
