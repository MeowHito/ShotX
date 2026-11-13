import { describe, expect, it } from 'vitest';
import {
  type MetricsSource,
  parseMeminfo,
  parseProcStat,
  readServerMetrics,
} from './server-metrics';

const STAT_A = 'cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3 4\n';
// +300 busy (user 200, system 100), +100 idle: 75% busy.
const STAT_B = 'cpu  300 0 200 800 100 0 0 0 0 0\ncpu0 1 2 3 4\n';
const MEMINFO = 'MemTotal:       32000000 kB\nMemFree:  1000 kB\nMemAvailable:   24000000 kB\n';

function source(files: Record<string, string | string[]>, overrides: Partial<MetricsSource> = {}) {
  let statReads = 0;
  const base: MetricsSource = {
    readFile: async (path) => {
      if (path === '/proc/stat') return statReads++ === 0 ? STAT_A : STAT_B;
      const value = files[path];
      if (typeof value !== 'string') throw new Error(`ENOENT ${path}`);
      return value;
    },
    readdir: async (path) => {
      const value = files[path];
      if (!Array.isArray(value)) throw new Error(`ENOENT ${path}`);
      return value;
    },
    statfs: async () => ({ blocks: 1000, bfree: 250, bsize: 4096 }),
    sleep: async () => undefined,
    hostname: () => 'vps',
    cpuCount: () => 8,
    loadavg: () => [1.234, 0.5, 0.25],
    uptime: () => 3600.4,
    totalmem: () => 1,
    freemem: () => 1,
  };
  return { ...base, ...overrides };
}

describe('server metrics (ADR 0016)', () => {
  it('parses /proc/stat and /proc/meminfo', () => {
    expect(parseProcStat(STAT_A)).toEqual({ busy: 200, total: 1000 });
    expect(parseProcStat('nothing')).toBeNull();
    expect(parseMeminfo(MEMINFO)).toEqual({
      totalBytes: 32_000_000 * 1024,
      availableBytes: 24_000_000 * 1024,
    });
    expect(parseMeminfo('MemTotal: 1 kB')).toBeNull();
  });

  it('reads CPU over a sample, memory, disk, load, uptime and the hottest sensor', async () => {
    const metrics = await readServerMetrics(
      { diskPath: '/' },
      source({
        '/proc/meminfo': MEMINFO,
        '/sys/class/thermal': ['thermal_zone0', 'cooling_device0'],
        '/sys/class/thermal/thermal_zone0/temp': '41000\n',
        '/sys/class/hwmon': ['hwmon0'],
        '/sys/class/hwmon/hwmon0': ['temp1_input', 'name'],
        '/sys/class/hwmon/hwmon0/temp1_input': '57500',
      }),
    );
    expect(metrics).toEqual({
      hostname: 'vps',
      cpuCount: 8,
      cpuPercent: 75,
      loadAverage: [1.23, 0.5, 0.25],
      memory: { totalBytes: 32_000_000 * 1024, usedBytes: 8_000_000 * 1024 },
      disk: { path: '/', totalBytes: 4_096_000, usedBytes: 3_072_000 },
      uptimeSeconds: 3600,
      temperatureC: 57.5,
    });
  });

  it('says null for what a virtual machine or another OS does not have', async () => {
    const metrics = await readServerMetrics(
      { diskPath: '/missing' },
      source(
        {},
        {
          readFile: async () => {
            throw new Error('ENOENT');
          },
          statfs: async () => {
            throw new Error('ENOENT');
          },
          totalmem: () => 1000,
          freemem: () => 400,
        },
      ),
    );
    expect(metrics.cpuPercent).toBeNull();
    expect(metrics.temperatureC).toBeNull();
    expect(metrics.disk).toBeNull();
    // Without /proc/meminfo: the OS's own numbers.
    expect(metrics.memory).toEqual({ totalBytes: 1000, usedBytes: 600 });
  });
});
