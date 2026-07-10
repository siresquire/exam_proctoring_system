"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, KeyRound, ShieldAlert } from "lucide-react";

import { rotateFormsExamSecret } from "@/app/dashboard/lecturer/forms-exams/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { notify } from "@/lib/notify";

/**
 * Phase 2b lecturer panel: generate/rotate the per-exam submission_secret
 * and show the ready-to-paste Apps Script config. Lives on the forms-exam
 * results page, next to the submissions/sessions tables.
 *
 * The secret itself is shown ONLY right after a successful
 * generate/rotate call, in this component's own state — never re-fetched
 * from the server and displayed by default (same "shown once" posture as an
 * API key). If the lecturer navigates away without copying it, they rotate
 * again; the old secret is invalidated at that point, which is the correct,
 * disclosed trade-off (documented in apps-script/README.md).
 */
export function FormsBypassDetectionPanel({
  formsExamId,
  webhookOrigin,
  hasSecret,
}: {
  formsExamId: string;
  /** Origin (protocol+host) to build the absolute WEBHOOK_URL for the Apps Script config — computed server-side from the request so it works in any deployment without an env var. */
  webhookOrigin: string;
  /** Whether a secret has ALREADY been generated (server knows this without seeing the value) — only changes the button label/copy, never reveals the value. */
  hasSecret: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const webhookUrl = `${webhookOrigin}/api/forms/submission`;

  async function handleGenerate() {
    const confirmed = hasSecret
      ? await notify.confirm({
          title: "Rotate the submission secret?",
          text: "The current secret will stop working immediately. Any Apps Script still using it will need the new value.",
          confirmButtonText: "Rotate secret",
          destructive: true,
        })
      : true;
    if (!confirmed) return;

    setBusy(true);
    try {
      const result = await rotateFormsExamSecret(formsExamId);
      if (result.error || !result.secret) {
        await notify.error("Could not generate a secret", result.error);
        return;
      }
      setRevealedSecret(result.secret);
      await notify.success(
        "Secret generated",
        "Copy it now — it will not be shown again. Rotate to get a new one if you lose it.",
      );
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function copyValue(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      await notify.toast({ title: `${label} copied` });
    } catch {
      await notify.info(label, value);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert aria-hidden className="size-4" />
          Bypass detection (Apps Script)
        </CardTitle>
        <CardDescription>
          Detects students who open the raw Google Form link instead of the proctored wrapper.
          Install a small Apps Script on your form that reports every submission back here for
          cross-checking — generate a secret below, then paste the values into the script using
          the field names shown.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={handleGenerate} disabled={busy} variant={hasSecret ? "outline" : "default"}>
          <KeyRound aria-hidden />
          {hasSecret ? "Rotate secret" : "Generate secret"}
        </Button>

        {revealedSecret ? (
          <div className="space-y-3 rounded-lg border p-4">
            <p className="text-sm font-medium">
              Paste these into <code>forms-proctor-crosscheck.gs</code>
            </p>
            <ConfigField
              label="WEBHOOK_URL"
              value={webhookUrl}
              onCopy={() => copyValue("WEBHOOK_URL", webhookUrl)}
            />
            <ConfigField
              label="FORMS_EXAM_ID"
              value={formsExamId}
              onCopy={() => copyValue("FORMS_EXAM_ID", formsExamId)}
            />
            <ConfigField
              label="SUBMISSION_SECRET"
              value={revealedSecret}
              onCopy={() => copyValue("SUBMISSION_SECRET", revealedSecret)}
            />
            <p className="text-muted-foreground text-xs">
              This secret is shown only once. If you navigate away without copying it, rotate
              again to get a new one.
            </p>
          </div>
        ) : hasSecret ? (
          <p className="text-muted-foreground text-sm">
            A secret has already been generated for this quiz. Rotate to see a new one (this
            invalidates the old one).
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            No secret yet — generate one to set up the Apps Script cross-check.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ConfigField({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="truncate font-mono text-xs" title={value}>
          {value}
        </p>
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onCopy} aria-label={`Copy ${label}`}>
        <Copy aria-hidden />
      </Button>
    </div>
  );
}
