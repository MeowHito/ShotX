import { readdir, readFile, statfs } from 'node:fs/promises';
import os from 'node:os';
import type { AdminSystemResponse } from '@shotx/shared';

type ServerMetrics = AdminSystemResponse['server'];

/** What the metrics read, so tests can feed fixed kernel files. */
export interface MetricsSource {
  readFile(path: string): Promise<string>;
  readdir(path: string): Promise<string[]>;
  statfs(path: string): Promise<{ blocks: number; bfree: number; bsize: number }>;
  sleep(ms: number): Promise<void>;
  hostname(): string;
  cpuCount(): number;
  loadavg(): [number, number, number];
  uptime(): number;
  totalmem(): number;
  freemem(): number;
}

export const nodeMetricsSource: MetricsSource = {
  readFile: (path) => readFile(path, 'utf8'),
  readdir: (path) => readdir(path),
  statfs: async (path) => {
    const s = await statfs(path);
    return { blocks: Number(s.blocks), bfree: Number(s.bfree), bsize: Number(s.bsize) };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  hostname: () => os.hostname(),
  cpuCount: () => Math.max(1, os.cpus().length),
  loadavg: () => os.loadavg() as [number, number, number],
  uptime: () => os.uptime(),
  totalmem: () => os.totalmem(),
  freemem: () => os.freemem(),
};

/** Busy and total jiffies of the first `cpu` line of /proc/stat (all CPUs together). */
export function parseProcStat(text: string): { busy: number; total: number } | null {
  const line = text.split('\n').find((l) => l.startsWith('cpu '));
  if (line === undefined) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  if (values.length < 4 || values.some((v) => !Number.isFinite(v))) return null;
  // user nice system idle iowait irq softirq steal (guest time is already in user).
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    values;
  const idleAll = idle + iowait;
  const total = user + nice + system + idleAll + irq + softirq + steal;
  return { busy: total - idleAll, total };
}

/** MemTotal and MemAvailable of /proc/meminfo, in bytes. */
export function parseMeminfo(text: string): { totalBytes: number; availableBytes: number } | null {
  const kib = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text);
    return m === null ? null : Number(m[1]) * 1024;
  };
  const total = kib('MemTotal');
  const available = kib('MemAvailable');
  return total === null || available === null
    ? null
    : { totalBytes: total, availableBytes: available };
}

async function cpuPercent(source: MetricsSource, sampleMs: number): Promise<number | null> {
  try {
    const a = parseProcStat(await source.readFile('/proc/stat'));
    await source.sleep(sampleMs);
    const b = parseProcStat(await source.readFile('/proc/stat'));
    if (a === null || b === null || b.total <= a.total) return null;
    const percent = ((b.busy - a.busy) / (b.total - a.total)) * 100;
    return Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10;
  } catch {
    return null; // Not Linux (development on macOS): no /proc.
  }
}

/** The hottest reading of the kernel's thermal zones and hwmon sensors, °C; null without any. */
async function temperature(source: MetricsSource): Promise<number | null> {
  const readings: number[] = [];
  const read = async (path: string) => {
    try {
      const milli = Number((await source.readFile(path)).trim());
      // Sensors report millidegrees; drop absurd values from broken drivers.
      if (Number.isFinite(milli) && milli > 0 && milli < 150_000) readings.push(milli / 1000);
    } catch {
      // Unreadable sensor.
    }
  };
  try {
    for (const zone of await source.readdir('/sys/class/thermal')) {
      if (zone.startsWith('thermal_zone')) await read(`/sys/class/thermal/${zone}/temp`);
    }
  } catch {
    // No thermal class (most virtual machines).
  }
  try {
    for (const hw of await source.readdir('/sys/class/hwmon')) {
      const dir = `/sys/class/hwmon/${hw}`;
      for (const file of await source.readdir(dir)) {
        if (/^temp\d+_input$/.test(file)) await read(`${dir}/${file}`);
      }
    }
  } catch {
    // No hwmon.
  }
  return readings.length === 0 ? null : Math.round(Math.max(...readings) * 10) / 10;
}

/**
 * The server the api runs on (ADR 0016). In the api container /proc/stat, /proc/meminfo, the load
 * averages and uptime are the host's (no lxcfs), and statfs of a path on the container's overlay
 * reports the host disk. Every part that can't be read is null rather than a guess.
 */
export async function readServerMetrics(
  options: { diskPath: string; cpuSampleMs?: number },
  source: MetricsSource = nodeMetricsSource,
): Promise<ServerMetrics> {
  const [cpu, meminfo, disk, temperatureC] = await Promise.all([
    cpuPercent(source, options.cpuSampleMs ?? 250),
    source
      .readFile('/proc/meminfo')
      .then(parseMeminfo)
      .catch(() => null),
    source.statfs(options.diskPath).then(
      (s) => ({
        path: options.diskPath,
        totalBytes: s.blocks * s.bsize,
        usedBytes: (s.blocks - s.bfree) * s.bsize,
      }),
      () => null,
    ),
    temperature(source),
  ]);
  const memory =
    meminfo === null
      ? { totalBytes: source.totalmem(), usedBytes: source.totalmem() - source.freemem() }
      : { totalBytes: meminfo.totalBytes, usedBytes: meminfo.totalBytes - meminfo.availableBytes };
  const round = (n: number) => Math.round(n * 100) / 100;
  const [l1, l5, l15] = source.loadavg();
  return {
    hostname: source.hostname(),
    cpuCount: source.cpuCount(),
    cpuPercent: cpu,
    loadAverage: [round(l1), round(l5), round(l15)],
    memory,
    disk,
    uptimeSeconds: Math.round(source.uptime()),
    temperatureC,
  };
}
