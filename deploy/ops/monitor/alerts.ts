import type { Finding } from './checks';

// Turns each round's findings into notifications: a new finding (or a severity change) fires, a
// firing one is repeated every `repeatSeconds` with its latest numbers, and one that disappears is
// resolved.

export interface Notification {
  status: 'firing' | 'resolved';
  finding: Finding;
}

interface Tracked {
  finding: Finding;
  lastSentAt: number;
}

export class AlertTracker {
  private readonly firing = new Map<string, Tracked>();

  constructor(private readonly repeatSeconds: number) {}

  update(findings: readonly Finding[], now: Date): Notification[] {
    const t = now.getTime();
    const out: Notification[] = [];
    const seen = new Set<string>();
    for (const finding of findings) {
      seen.add(finding.id);
      const prev = this.firing.get(finding.id);
      // Only a severity change re-fires at once: summaries carry live numbers (ages, counts).
      const changed = prev === undefined || prev.finding.severity !== finding.severity;
      const due =
        prev !== undefined &&
        this.repeatSeconds > 0 &&
        t - prev.lastSentAt >= this.repeatSeconds * 1000;
      if (prev === undefined || changed || due) {
        out.push({ status: 'firing', finding });
        this.firing.set(finding.id, { finding, lastSentAt: t });
      } else {
        this.firing.set(finding.id, { finding, lastSentAt: prev.lastSentAt });
      }
    }
    for (const [id, tracked] of this.firing) {
      if (!seen.has(id)) {
        out.push({ status: 'resolved', finding: tracked.finding });
        this.firing.delete(id);
      }
    }
    return out;
  }
}

/**
 * A generic JSON webhook body: `text` (Slack, Mattermost, Google Chat, Teams workflows) and
 * `content` (Discord) for chat tools, plus the structured `alerts` for anything else.
 */
export function webhookPayload(stage: string, notifications: readonly Notification[]) {
  const line = (n: Notification) =>
    `${n.status === 'resolved' ? 'RESOLVED' : n.finding.severity.toUpperCase()} [${n.finding.id}] ${n.finding.summary}`;
  const text = [`shotx ${stage}:`, ...notifications.map(line)].join('\n').slice(0, 1900);
  return {
    source: 'shotx-monitor',
    stage,
    text,
    content: text,
    alerts: notifications.map((n) => ({
      status: n.status,
      id: n.finding.id,
      severity: n.finding.severity,
      summary: n.finding.summary,
      details: n.finding.details ?? {},
    })),
  };
}
