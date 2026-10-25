import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertNotCommittable,
  DATA_DIR,
  gitIgnoreStatus,
  PACKAGE_DIR,
  REPORTS_DIR,
  RUNS_DIR,
} from './paths';

describe('gitIgnoreStatus', () => {
  it('treats data/ and runs/ as ignored, even before they exist', () => {
    expect(gitIgnoreStatus(join(DATA_DIR, 'real-event-that-does-not-exist'))).toBe('ignored');
    expect(gitIgnoreStatus(RUNS_DIR)).toBe('ignored');
  });

  it('flags folders git would commit', () => {
    expect(gitIgnoreStatus(join(PACKAGE_DIR, 'src'))).toBe('tracked-path');
    expect(gitIgnoreStatus(REPORTS_DIR)).toBe('tracked-path');
    expect(() => assertNotCommittable(REPORTS_DIR, 'Dataset')).toThrow(/not git-ignored/);
  });

  it('accepts folders outside the repository', () => {
    expect(gitIgnoreStatus(join(tmpdir(), 'face-eval-outside'))).toBe('outside-repo');
    expect(() => assertNotCommittable(join(tmpdir(), 'x'), 'Dataset')).not.toThrow();
  });
});
