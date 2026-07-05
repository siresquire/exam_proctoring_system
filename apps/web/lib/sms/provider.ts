/**
 * Phase 3a: pluggable SMS provider seam (PLAN.md "Student onboarding
 * without a domain" — bulk SMS as a fallback/complement to email for
 * delivering login details).
 *
 * `getSmsProvider()` is the ONLY thing callers should import — it picks
 * `HubtelSmsProvider` when HUBTEL_* env vars are present, otherwise falls
 * back to `LogSmsProvider` (the default today: no Hubtel account exists
 * yet). This mirrors this repo's existing "env vars present -> real
 * integration, otherwise degrade gracefully" pattern (see
 * lib/supabase/env.ts / lib/supabase/admin.ts returning null when
 * unconfigured).
 */

export interface SmsSendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

export interface SmsProvider {
  send(to: string, message: string): Promise<SmsSendResult>;
}

import { LogSmsProvider } from "@/lib/sms/log-provider";
import { HubtelSmsProvider } from "@/lib/sms/hubtel-provider";

export function getSmsProvider(): SmsProvider {
  const clientId = process.env.HUBTEL_CLIENT_ID;
  const clientSecret = process.env.HUBTEL_CLIENT_SECRET;
  const sender = process.env.HUBTEL_SENDER;

  if (clientId && clientSecret && sender) {
    return new HubtelSmsProvider({ clientId, clientSecret, sender });
  }

  return new LogSmsProvider();
}
