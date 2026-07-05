import type { SmsProvider, SmsSendResult } from "@/lib/sms/provider";

/**
 * Default SMS provider: does NOT send anything. Records what would have
 * been sent (server console log) and returns a synthetic success result so
 * the lecturer-facing "send login details via SMS" flow can be demoed and
 * previewed end-to-end before a real Hubtel account exists. Selected
 * automatically by getSmsProvider() whenever HUBTEL_* env vars are absent.
 */
export class LogSmsProvider implements SmsProvider {
  async send(to: string, message: string): Promise<SmsSendResult> {
    const id = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // This console.log IS the "send" for the log provider, standing in for a real SMS gateway call.
    console.log(`[LogSmsProvider] would send to ${to}: ${message}`);
    return { ok: true, id };
  }
}
