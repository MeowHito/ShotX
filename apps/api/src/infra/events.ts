/**
 * Structured operational events (alerts infra turns into CloudWatch metric filters and alarms),
 * written as one JSON line each with a top-level `event` field, e.g.
 * `{"level":"warn","event":"face_deletion.alert","shareId":"…","count":20,…}`. Fields are ids,
 * codes and counts only: never request bodies, selfies, emails, card data or addresses.
 */
export type EventFields = Readonly<Record<string, string | number | boolean | null>>;

export interface EventLog {
  warn(event: string, fields: EventFields): void;
}

export interface LoggedEvent {
  level: 'warn';
  event: string;
  timestamp: string;
  [field: string]: string | number | boolean | null;
}

function line(event: string, fields: EventFields, now: Date): LoggedEvent {
  // `level`, `event` and `timestamp` always win over a field of the same name.
  return { ...fields, level: 'warn', event, timestamp: now.toISOString() };
}

/** Production: one JSON line on stdout (the awslogs driver ships it to CloudWatch as is). */
export class StdoutEventLog implements EventLog {
  constructor(private readonly now: () => Date = () => new Date()) {}

  warn(event: string, fields: EventFields): void {
    process.stdout.write(`${JSON.stringify(line(event, fields, this.now()))}\n`);
  }
}

/** Tests: keeps the events in memory. */
export class MemoryEventLog implements EventLog {
  readonly entries: LoggedEvent[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  warn(event: string, fields: EventFields): void {
    this.entries.push(line(event, fields, this.now()));
  }

  of(event: string): LoggedEvent[] {
    return this.entries.filter((e) => e.event === event);
  }
}
