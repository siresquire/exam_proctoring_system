import type { SmsProvider, SmsSendResult } from "@/lib/sms/provider";

export interface HubtelConfig {
  clientId: string;
  clientSecret: string;
  sender: string;
}

const HUBTEL_SEND_URL = "https://smsc.hubtel.com/v1/messages/send";

/**
 * Real Hubtel SMS send (Ghana SMS aggregator). Only ever constructed by
 * getSmsProvider() when HUBTEL_CLIENT_ID/HUBTEL_CLIENT_SECRET/HUBTEL_SENDER
 * are all set — live sending is deferred until USTED provisions a Hubtel
 * account (see apps/web/.env.example and README.md's Phase 3a section).
 * Not exercised by the smoke test or the browser check in this phase
 * (no credentials in the local dev environment); the LogSmsProvider covers
 * that instead.
 */
export class HubtelSmsProvider implements SmsProvider {
  constructor(private readonly config: HubtelConfig) {}

  async send(to: string, message: string): Promise<SmsSendResult> {
    const params = new URLSearchParams({
      clientid: this.config.clientId,
      clientsecret: this.config.clientSecret,
      from: this.config.sender,
      to,
      content: message,
    });

    try {
      const res = await fetch(`${HUBTEL_SEND_URL}?${params.toString()}`, { method: "GET" });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const errorMessage =
          body && typeof body === "object" && "message" in body
            ? String((body as { message: unknown }).message)
            : `Hubtel returned HTTP ${res.status}`;
        return { ok: false, error: errorMessage };
      }
      const messageId =
        body && typeof body === "object" && "messageId" in body
          ? String((body as { messageId: unknown }).messageId)
          : undefined;
      return { ok: true, id: messageId };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Hubtel request failed." };
    }
  }
}
