import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
  html?: string;
};

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly config: ConfigService) {}

  async send(message: EmailMessage) {
    const webhookUrl = this.config.get<string>('EMAIL_WEBHOOK_URL');
    const from = this.config.get<string>('EMAIL_FROM') ?? 'ShotX <no-reply@shotx.app>';

    if (!webhookUrl) {
      this.logger.log(`email_skipped:${message.to}:${message.subject}`);
      return { skipped: true };
    }

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, ...message }),
    });

    if (!response.ok) {
      this.logger.warn(`email_failed:${response.status}:${message.to}`);
      return { skipped: false, sent: false, status: response.status };
    }

    return { skipped: false, sent: true };
  }

  sendWelcome(to: string, name: string) {
    return this.send({
      to,
      subject: 'ยินดีต้อนรับสู่ ShotX',
      text: `สวัสดี ${name}, ยินดีต้อนรับสู่ ShotX ระบบแจกภาพพร้อม AI Face Search`,
      html: `<p>สวัสดี ${name},</p><p>ยินดีต้อนรับสู่ ShotX ระบบแจกภาพพร้อม AI Face Search</p>`,
    });
  }
}
