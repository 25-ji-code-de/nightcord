export type RepeatEntry = { actor: string; content: string; timestamp: number };
export class MessagePolicy {
  static WINDOW_MS: number;
  static PERSONAL_LIMIT: number;
  static GROUP_MESSAGES: number;
  static GROUP_SENDERS: number;
  static body(text: string): string;
  static analyze(text: string): { length: number; emojis: number; lines: number; reason: string | null };
  static fingerprint(text: string): string;
  static similar(a: string, b: string): boolean;
  static decide(recent: RepeatEntry[], actor: string, content: string, now: number): { allowed: boolean; retryAfter: number; repeated: boolean };
}
