import { Logger } from '@nestjs/common';

export const SMS_PROVIDER = Symbol('SMS_PROVIDER');

export interface SmsProvider {
  readonly name: string;
  send(to: string, text: string): Promise<void>;
}

/**
 * Placeholder until an Ethiopian SMS gateway is chosen (PRD §17 open decision).
 * A real provider implements SmsProvider and is selected in app.module.ts.
 */
export class LogSmsProvider implements SmsProvider {
  readonly name = 'log';
  private readonly logger = new Logger('LogSmsProvider');

  async send(to: string) {
    this.logger.log(`SMS to ${to.slice(0, 5)}****`);
  }
}
