import { Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

export const EMAIL_PROVIDER = Symbol('EMAIL_PROVIDER');

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Plain text is the source of truth; the HTML part only adds line breaks and clickable links. */
export const toHtml = (text: string) =>
  `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5">${escapeHtml(text)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
    .replace(/\n/g, '<br>')}</div>`;

/** Any SMTP server: Mailpit locally, or a transactional email provider's SMTP endpoint in production. */
export class SmtpEmailProvider implements EmailProvider {
  readonly name = 'smtp';
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async send(message: EmailMessage) {
    await this.transport.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: toHtml(message.text),
    });
  }
}

export class LogEmailProvider implements EmailProvider {
  readonly name = 'log';
  private readonly logger = new Logger('LogEmailProvider');

  async send(message: EmailMessage) {
    // Subject only: bodies can hold one-time links.
    this.logger.log(`Email to ${message.to}: ${message.subject}`);
  }
}
