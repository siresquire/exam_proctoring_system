"use client";

import { useState } from "react";
import { ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";

interface ConsentScreenProps {
  /** Called once consent is affirmed. The identity step (camera + attestation) follows next. */
  onConsent: () => void;
}

/**
 * Ghana DPA (Act 843) + DESIGN.md §3 "Proctoring-specific accessibility"
 * consent flow: states purpose, exactly what is collected, retention, and
 * who can view, before any capture happens; requires an explicit
 * affirmative action (an unchecked checkbox, never pre-checked); is fully
 * keyboard/screen-reader navigable. The camera check itself now lives in
 * the identity-verification step (IdentityCheck) that follows this screen —
 * Phase 1.5 moved it there so the camera is only ever opened once, for the
 * identity portrait, rather than twice (a bare "check" here, then again to
 * capture the portrait).
 */
export function ConsentScreen({ onConsent }: ConsentScreenProps) {
  const [agreed, setAgreed] = useState(false);

  async function handleContinue() {
    if (!agreed) {
      await notify.warning(
        "Consent required",
        "You must agree to monitoring before starting a proctored session.",
      );
      return;
    }
    onConsent();
  }

  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <ShieldCheck className="text-primary" aria-hidden="true" />
          Consent to monitoring
        </CardTitle>
        <CardDescription>
          Read this before starting. You must actively agree — nothing is recorded until you do.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section aria-labelledby="purpose-heading" className="space-y-1">
          <h2 id="purpose-heading" className="font-medium">
            Purpose
          </h2>
          <p className="text-muted-foreground text-sm">
            This session demonstrates USTED&apos;s exam-integrity monitoring. In a real exam, the
            same signals help a human reviewer judge whether the exam conditions were fair — flags
            are evidence for review, never an automatic penalty.
          </p>
        </section>

        <section aria-labelledby="collected-heading" className="space-y-1">
          <h2 id="collected-heading" className="font-medium">
            What is collected
          </h2>
          <ul className="text-muted-foreground list-inside list-disc space-y-1 text-sm">
            <li>
              Browser events: tab switches, window focus loss, fullscreen exits, copy/paste,
              right-click, and connection drops.
            </li>
            <li>
              Periodic webcam snapshots (still JPEG images, not continuous video) while the session
              is active.
            </li>
            <li>
              One identity portrait and your entered index number, captured just after this screen.
            </li>
            <li>
              Timestamps for every event and snapshot, and your browser&apos;s user-agent string.
            </li>
          </ul>
        </section>

        <section aria-labelledby="retention-heading" className="space-y-1">
          <h2 id="retention-heading" className="font-medium">
            Retention
          </h2>
          <p className="text-muted-foreground text-sm">
            Demo sessions are retained only for this training exercise and are purged periodically.
            In a real exam, data is retained only as long as needed to cover the grading and appeal
            window, per USTED&apos;s published retention policy.
          </p>
        </section>

        <section aria-labelledby="viewers-heading" className="space-y-1">
          <h2 id="viewers-heading" className="font-medium">
            Who can view this
          </h2>
          <p className="text-muted-foreground text-sm">
            You can always see your own session. Lecturers and administrators can review sessions
            for exams they are responsible for. Every flag routes to human review before any
            consequence — automated flags are never treated as proof on their own.
          </p>
        </section>

        <div className="flex items-start gap-3 border-t pt-4">
          <Checkbox
            id="consent-checkbox"
            checked={agreed}
            onCheckedChange={(checked) => setAgreed(checked === true)}
          />
          <Label htmlFor="consent-checkbox" className="text-sm font-normal leading-normal">
            I understand what is collected and how it will be used, and I consent to being monitored
            for the duration of this session.
          </Label>
        </div>

        <Button type="button" className="w-full" onClick={handleContinue} disabled={!agreed}>
          Continue to identity verification
        </Button>
      </CardContent>
    </Card>
  );
}
