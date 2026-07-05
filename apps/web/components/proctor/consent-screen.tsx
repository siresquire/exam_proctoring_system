"use client";

import { useId, useRef, useState } from "react";
import { isWebcamSupported, startWebcam, type WebcamHandle } from "@proctor/core";
import { AlertCircle, Camera, CheckCircle2, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";

type CameraStatus = "idle" | "checking" | "ok" | "denied" | "unsupported";

interface ConsentScreenProps {
  /** Called once consent is affirmed AND the camera check has passed. */
  onConsent: (webcam: WebcamHandle) => void;
}

/**
 * Ghana DPA (Act 843) + DESIGN.md §3 "Proctoring-specific accessibility"
 * consent flow: states purpose, exactly what is collected, retention, and
 * who can view, before any capture happens; requires an explicit
 * affirmative action (an unchecked checkbox, never pre-checked); is fully
 * keyboard/screen-reader navigable; and gives non-visual feedback for the
 * camera-check step ("Camera detected: OK") rather than relying on the
 * live video preview alone.
 */
export function ConsentScreen({ onConsent }: ConsentScreenProps) {
  const [agreed, setAgreed] = useState(false);
  const [cameraStatus, setCameraStatus] = useState<CameraStatus>("idle");
  const webcamRef = useRef<WebcamHandle | null>(null);
  const statusId = useId();

  async function handleCheckCamera() {
    if (!isWebcamSupported()) {
      setCameraStatus("unsupported");
      return;
    }
    setCameraStatus("checking");
    try {
      const handle = await startWebcam();
      webcamRef.current = handle;
      setCameraStatus("ok");
    } catch {
      setCameraStatus("denied");
    }
  }

  async function handleContinue() {
    if (!agreed) {
      await notify.warning(
        "Consent required",
        "You must agree to monitoring before starting a proctored session.",
      );
      return;
    }
    if (cameraStatus !== "ok" || !webcamRef.current) {
      await notify.warning("Camera check required", "Run the camera check before continuing.");
      return;
    }
    onConsent(webcamRef.current);
  }

  const cameraStatusText: Record<CameraStatus, string> = {
    idle: "Camera not yet checked.",
    checking: "Requesting camera access…",
    ok: "Camera detected: OK.",
    denied: "Camera access was denied or is unavailable. Grant camera permission and try again.",
    unsupported: "This browser does not support camera access. A different browser is required.",
  };

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
            <li>Browser events: tab switches, window focus loss, fullscreen exits, copy/paste, right-click, and connection drops.</li>
            <li>Periodic webcam snapshots (still JPEG images, not continuous video) while the session is active.</li>
            <li>Timestamps for every event and snapshot, and your browser&apos;s user-agent string.</li>
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

        <section aria-labelledby="camera-heading" className="space-y-3 border-t pt-4">
          <h2 id="camera-heading" className="font-medium">
            Camera check
          </h2>
          <p className="text-muted-foreground text-sm">
            Confirm your camera works before continuing. This does not start recording — it only
            verifies access.
          </p>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={handleCheckCamera}
              disabled={cameraStatus === "checking"}
            >
              <Camera aria-hidden="true" />
              {cameraStatus === "ok" ? "Re-check camera" : "Check camera"}
            </Button>
            {cameraStatus === "ok" && (
              <Badge variant="secondary">
                <CheckCircle2 aria-hidden="true" />
                Camera detected: OK
              </Badge>
            )}
            {(cameraStatus === "denied" || cameraStatus === "unsupported") && (
              <Badge variant="destructive">
                <AlertCircle aria-hidden="true" />
                Camera not available
              </Badge>
            )}
          </div>
          {/* Non-visual feedback: announced to screen readers even though the
              badge above also conveys it visually (icon + text, never color
              alone — DESIGN.md §1). polite: this isn't an emergency, no need
              to interrupt. */}
          <p id={statusId} role="status" aria-live="polite" className="sr-only">
            {cameraStatusText[cameraStatus]}
          </p>
        </section>

        <div className="flex items-start gap-3 border-t pt-4">
          <Checkbox
            id="consent-checkbox"
            checked={agreed}
            onCheckedChange={(checked) => setAgreed(checked === true)}
            aria-describedby={statusId}
          />
          <Label htmlFor="consent-checkbox" className="text-sm leading-normal font-normal">
            I understand what is collected and how it will be used, and I consent to being monitored
            for the duration of this session.
          </Label>
        </div>

        <Button
          type="button"
          className="w-full"
          onClick={handleContinue}
          disabled={!agreed || cameraStatus !== "ok"}
        >
          Continue to session start
        </Button>
      </CardContent>
    </Card>
  );
}
