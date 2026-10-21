export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');

export interface PushMessage {
  title: string;
  body: string;
  /** String values only (FCM data payload). `route` deep-links in the mobile app. */
  data?: Record<string, string>;
}

export interface PushResult {
  token: string;
  ok: boolean;
  /** The token is permanently dead (app uninstalled, token rotated) and should be deleted. */
  invalidToken: boolean;
  error?: string;
}

/** Adapter boundary (PRD 5.19): the domain never sees vendor-specific types. */
export interface PushProvider {
  readonly name: string;
  send(tokens: string[], message: PushMessage): Promise<PushResult[]>;
}
