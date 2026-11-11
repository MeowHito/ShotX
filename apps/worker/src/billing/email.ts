import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import {
  type EmailConfig,
  type EmailMessage,
  type EmailProvider,
  type EmailSender,
  type EmailTemplate,
  OffEmailProvider,
} from '@shotx/shared';
import type { Logger } from '../logger';
import { type RenderedEmail, renderEmail } from './email-templates';

/**
 * The `From` header: `"Name" <address>`, with a non-ASCII (e.g. Thai) display name as a MIME
 * encoded word, which SES requires.
 */
export function formatFromAddress(from: EmailSender): string {
  const ascii = /^[\x20-\x7e]*$/.test(from.name);
  const name = ascii
    ? `"${from.name.replace(/["\\]/g, (c) => `\\${c}`)}"`
    : `=?UTF-8?B?${Buffer.from(from.name, 'utf8').toString('base64')}?=`;
  return `${name} <${from.address}>`;
}

/** The part of SESv2Client the provider uses (tests pass a recorder). */
export interface SesV2Sender {
  send(command: SendEmailCommand): Promise<{ MessageId?: string | undefined }>;
}

/**
 * EMAIL_PROVIDER=ses: Amazon SES v2 `SendEmail` (IAM `ses:SendEmail` on the sender identity) in
 * AWS_REGION, a simple UTF-8 message with the Thai subject and plain-text body. SES has no
 * idempotency key, so "at most once" comes from the callers' notice and receipt claims.
 */
export class SesEmailProvider implements EmailProvider {
  constructor(
    private readonly client: SesV2Sender,
    private readonly from: EmailSender,
  ) {}

  async send<T extends EmailTemplate>(message: EmailMessage<T>): Promise<{ messageId: string }> {
    const rendered = renderEmail(message);
    const response = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: formatFromAddress(this.from),
        Destination: { ToAddresses: [message.to] },
        Content: {
          Simple: {
            Subject: { Data: rendered.subject, Charset: 'UTF-8' },
            Body: { Text: { Data: rendered.text, Charset: 'UTF-8' } },
          },
        },
      }),
    );
    return { messageId: response.MessageId ?? '' };
  }
}

export interface SentEmail {
  message: EmailMessage;
  rendered: RenderedEmail;
  messageId: string;
}

/**
 * EMAIL_PROVIDER=fake (refused in production by loadEmailConfig). Renders and records every
 * message; `failNext` makes the next sends throw. Like a real provider it dedupes on
 * `idempotencyKey`, but it records duplicates in `duplicates` so tests can prove the job never
 * sends one.
 */
export class FakeEmailProvider implements EmailProvider {
  readonly sent: SentEmail[] = [];
  readonly duplicates: EmailMessage[] = [];
  private failures = 0;
  private seq = 0;

  failNext(times = 1): this {
    this.failures += times;
    return this;
  }

  send<T extends EmailTemplate>(message: EmailMessage<T>): Promise<{ messageId: string }> {
    const rendered = renderEmail(message);
    if (this.failures > 0) {
      this.failures--;
      return Promise.reject(new Error('fake email send failed'));
    }
    const existing = this.sent.find((s) => s.message.idempotencyKey === message.idempotencyKey);
    if (existing !== undefined) {
      this.duplicates.push(message);
      return Promise.resolve({ messageId: existing.messageId });
    }
    const messageId = `fake-email-${++this.seq}`;
    this.sent.push({ message, rendered, messageId });
    return Promise.resolve({ messageId });
  }

  /** The messages sent with `template`. */
  of<T extends EmailTemplate>(template: T): Array<SentEmail & { message: EmailMessage<T> }> {
    return this.sent.filter(
      (s): s is SentEmail & { message: EmailMessage<T> } => s.message.template === template,
    );
  }
}

/**
 * EMAIL_PROVIDER: `ses` needs the SESv2 client of the worker's region (and endpoint, for
 * LocalStack); `off` drops every message and logs only droppedEmailLogEntry (event, provider,
 * template) on `log`, never the recipient, parameters or body.
 */
export function createEmailProvider(
  config: EmailConfig,
  sesClient: () => SesV2Sender,
  log: Logger,
): EmailProvider {
  switch (config.provider) {
    case 'ses':
      return new SesEmailProvider(sesClient(), config.from);
    case 'fake':
      return new FakeEmailProvider();
    case 'off':
      return new OffEmailProvider((entry) =>
        log.info('email dropped (EMAIL_PROVIDER=off)', { ...entry }),
      );
  }
}
