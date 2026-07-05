"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { startWebcam, type FaceDetector, type WebcamHandle } from "@proctor/core";
import { Camera, IdCard, RotateCcw, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import { evaluatePortraitQuality, PORTRAIT_QUALITY_MESSAGES } from "@/lib/proctor/image-quality";

const INDEX_NUMBER_PATTERN = /^\d{10}$/;

export interface IdentityCheckResult {
  claimedIndexNumber: string;
  portraitBlob: Blob;
  attested: true;
  /**
   * The live webcam stream opened for the portrait capture, handed off to
   * the caller so the proctoring session can reuse it for periodic
   * snapshots instead of prompting for camera access a second time. The
   * caller now owns disposal (webcamHandle.stop()) — IdentityCheck will not
   * stop it on unmount once handed off.
   */
  webcamHandle: WebcamHandle;
}

interface IdentityCheckProps {
  /** Student's full name, interpolated into the attestation wording. Falls back to "the account holder" if unknown. */
  fullName: string | null;
  /** Called once the index number is valid, a portrait has been captured, and the attestation is checked. */
  onVerified: (result: IdentityCheckResult) => void | Promise<void>;
  /**
   * Phase 1.6: reused for portrait quality gating (exactly-one-face check)
   * before a captured photo is accepted — the same MediaPipe-backed
   * detector the live session later uses for no_face_detected/
   * multiple_faces_detected. Optional so this component still renders (with
   * the face-count check simply skipped) if a host app doesn't wire one up.
   */
  faceDetector?: FaceDetector;
}

type CameraState = "idle" | "starting" | "live" | "captured" | "checking" | "denied" | "unsupported";

const CAMERA_STATE_TEXT: Record<CameraState, string> = {
  idle: "Camera not yet started.",
  starting: "Starting camera…",
  live: "Camera live. Position your face inside the outline, then take the photo.",
  checking: "Checking photo quality…",
  captured: "Photo captured. Retake if it is unclear.",
  denied: "Camera access was denied or is unavailable. Grant camera permission and try again.",
  unsupported: "This browser does not support camera access. A different browser is required.",
};

/**
 * Phase 1.5 pre-session identity step (PLAN.md, DESIGN.md accessibility
 * requirements): index number entry, a live face-outline-guided portrait
 * capture, and an explicit impersonation attestation. No ML/face matching —
 * the portrait and index number are evidence for a human reviewer, same
 * posture as every other proctoring signal in this codebase. Camera state
 * changes are announced via an aria-live region so screen-reader users get
 * the same "camera detected" feedback sighted users get from the preview.
 */
export function IdentityCheck({ fullName, onVerified, faceDetector }: IdentityCheckProps) {
  const [indexNumber, setIndexNumber] = useState("");
  const [indexTouched, setIndexTouched] = useState(false);
  const [cameraState, setCameraState] = useState<CameraState>("idle");
  const [attested, setAttested] = useState(false);
  const [capturedUrl, setCapturedUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** Phase 1.6: portrait quality-check outcome, announced via the same aria-live status region as camera state. */
  const [qualityStatus, setQualityStatus] = useState<string | null>(null);

  const webcamRef = useRef<WebcamHandle | null>(null);
  const capturedBlobRef = useRef<Blob | null>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  const handedOffRef = useRef(false);
  const statusId = useId();
  const indexErrorId = useId();
  const indexHelpId = useId();

  const indexValid = INDEX_NUMBER_PATTERN.test(indexNumber);
  const indexError =
    indexTouched && !indexValid
      ? indexNumber.length === 0
        ? "Enter your 10-digit index number."
        : "Index number must be exactly 10 digits (e.g. 5201040845)."
      : null;

  useEffect(() => {
    return () => {
      // Only stop the stream if it was never handed off to onVerified — once
      // handed off, the caller owns disposal (it keeps the same stream alive
      // for periodic in-session snapshots rather than reopening the camera).
      if (!handedOffRef.current) webcamRef.current?.stop();
      if (capturedUrl) URL.revokeObjectURL(capturedUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup only, intentionally not re-running on capturedUrl changes.
  }, []);

  const startCamera = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setCameraState("unsupported");
      return;
    }
    setCameraState("starting");
    try {
      const handle = await startWebcam();
      webcamRef.current = handle;
      handle.videoEl.className = "h-full w-full rounded-md object-cover";
      handle.videoEl.setAttribute("aria-hidden", "true");
      videoContainerRef.current?.replaceChildren(handle.videoEl);
      setCameraState("live");
    } catch {
      setCameraState("denied");
    }
  }, []);

  async function handleTakePhoto() {
    const webcam = webcamRef.current;
    if (!webcam) return;
    const blob = await webcam.captureSnapshot({ maxWidth: 640, quality: 0.85 });
    if (!blob) {
      await notify.error(
        "Could not capture photo",
        "Try again, or retake with a different browser.",
      );
      return;
    }

    setCameraState("checking");
    setQualityStatus("Checking photo quality…");

    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(blob);
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2d context unavailable");
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      // No faceDetector configured (host app didn't wire one up) -> skip the
      // face-count check rather than block on a feature that isn't there;
      // brightness/sharpness still run either way.
      let faceCount = 1;
      if (faceDetector) {
        const result = await faceDetector.detect(bitmap);
        faceCount = result.faceCount;
      }

      const quality = evaluatePortraitQuality(imageData, faceCount);
      if (!quality.ok) {
        const messages = quality.failures.map((f) => PORTRAIT_QUALITY_MESSAGES[f]);
        setQualityStatus(messages.join(" "));
        await notify.warning("Photo not accepted", messages.join(" "));
        setCameraState("live");
        return;
      }
    } catch (err) {
      console.error("Portrait quality check failed", err);
      // Fail open on a check-pipeline error (e.g. createImageBitmap
      // unsupported) rather than blocking identity verification entirely —
      // the photo itself is still evidence for a human reviewer even
      // un-gated, same posture as every other soft signal in this repo.
    } finally {
      bitmap?.close();
    }

    capturedBlobRef.current = blob;
    if (capturedUrl) URL.revokeObjectURL(capturedUrl);
    setCapturedUrl(URL.createObjectURL(blob));
    setQualityStatus("Photo captured and passed quality checks.");
    setCameraState("captured");
  }

  function handleRetake() {
    capturedBlobRef.current = null;
    if (capturedUrl) URL.revokeObjectURL(capturedUrl);
    setCapturedUrl(null);
    setQualityStatus(null);
    setCameraState("live");
  }

  async function handleContinue() {
    setIndexTouched(true);
    if (!indexValid) {
      await notify.warning(
        "Index number required",
        "Enter a valid 10-digit index number before continuing.",
      );
      return;
    }
    if (!capturedBlobRef.current) {
      await notify.warning("Photo required", "Take your identity photo before continuing.");
      return;
    }
    if (!attested) {
      await notify.warning(
        "Attestation required",
        "You must confirm the attestation statement to continue.",
      );
      return;
    }
    const webcamHandle = webcamRef.current;
    if (!webcamHandle) return;

    setSubmitting(true);
    try {
      handedOffRef.current = true;
      await onVerified({
        claimedIndexNumber: indexNumber,
        portraitBlob: capturedBlobRef.current,
        attested: true,
        webcamHandle,
      });
    } catch (err) {
      // Verification failed downstream (e.g. session creation) — the stream
      // was never actually handed off in any usable state, so reclaim
      // disposal ownership rather than leaking an open camera.
      handedOffRef.current = false;
      throw err;
    } finally {
      setSubmitting(false);
    }
  }

  const displayName = fullName?.trim() || "the account holder";
  const canContinue = indexValid && cameraState === "captured" && attested && !submitting;

  return (
    <Card className="mx-auto max-w-2xl">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-xl">
          <IdCard className="text-primary" aria-hidden="true" />
          Verify your identity
        </CardTitle>
        <CardDescription>
          Required before every proctored session. Your index number and photo are evidence a human
          reviewer can check — there is no automated face matching.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section aria-labelledby="index-heading" className="space-y-2">
          <h2 id="index-heading" className="font-medium">
            Index number
          </h2>
          <div className="space-y-2">
            <Label htmlFor="index-number">USTED index number</Label>
            <Input
              id="index-number"
              name="index-number"
              inputMode="numeric"
              pattern="\d{10}"
              maxLength={10}
              autoComplete="off"
              value={indexNumber}
              onChange={(event) =>
                setIndexNumber(event.target.value.replace(/\D/g, "").slice(0, 10))
              }
              onBlur={() => setIndexTouched(true)}
              aria-invalid={Boolean(indexError)}
              aria-describedby={indexError ? `${indexErrorId} ${indexHelpId}` : indexHelpId}
              className="min-h-11 max-w-xs font-mono"
              placeholder="5201040845"
            />
            <p id={indexHelpId} className="text-muted-foreground text-sm">
              Exactly 10 digits, no spaces or letters.
            </p>
            {indexError ? (
              <p id={indexErrorId} className="text-destructive text-sm">
                {indexError}
              </p>
            ) : null}
          </div>
        </section>

        <section aria-labelledby="photo-heading" className="space-y-3 border-t pt-4">
          <h2 id="photo-heading" className="font-medium">
            Identity photo
          </h2>
          <p className="text-muted-foreground text-sm">
            Face the camera in good light, and remove caps or sunglasses so your face is clearly
            visible.
          </p>

          {cameraState === "captured" && capturedUrl ? (
            <div className="relative aspect-video max-w-sm overflow-hidden rounded-md border">
              {/* eslint-disable-next-line @next/next/no-img-element --
                  local blob: URL for a just-captured photo; nothing to
                  fetch/optimize remotely. */}
              <img
                src={capturedUrl}
                alt="Your captured identity photo"
                className="h-full w-full object-cover"
              />
            </div>
          ) : (
            <div className="relative aspect-video max-w-sm overflow-hidden rounded-md border bg-black/5">
              <div ref={videoContainerRef} className="h-full w-full" />
              {cameraState === "live" ? (
                <svg
                  viewBox="0 0 100 100"
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 h-full w-full"
                >
                  <ellipse
                    cx="50"
                    cy="52"
                    rx="26"
                    ry="34"
                    fill="none"
                    stroke="white"
                    strokeOpacity="0.85"
                    strokeWidth="1.5"
                    strokeDasharray="4 3"
                  />
                </svg>
              ) : null}
              {cameraState === "idle" ||
              cameraState === "denied" ||
              cameraState === "unsupported" ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Camera aria-hidden="true" className="text-muted-foreground size-8" />
                </div>
              ) : null}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {cameraState === "idle" || cameraState === "denied" || cameraState === "unsupported" ? (
              <Button type="button" variant="outline" onClick={startCamera}>
                <Camera aria-hidden="true" />
                Start camera
              </Button>
            ) : null}
            {cameraState === "live" || cameraState === "checking" ? (
              <Button type="button" onClick={handleTakePhoto} disabled={cameraState === "checking"}>
                <Camera aria-hidden="true" />
                {cameraState === "checking" ? "Checking photo…" : "Take photo"}
              </Button>
            ) : null}
            {cameraState === "captured" ? (
              <Button type="button" variant="outline" onClick={handleRetake}>
                <RotateCcw aria-hidden="true" />
                Retake
              </Button>
            ) : null}
          </div>

          {/* Non-visual feedback mirroring ConsentScreen's camera-check
              pattern — announced politely so screen-reader users learn the
              camera state without relying on the preview/outline. Includes
              the Phase 1.6 portrait-quality outcome so a rejected photo's
              reason reaches screen-reader users the same way the visible
              notify.warning() toast does for sighted users. */}
          <p id={statusId} role="status" aria-live="polite" className="sr-only">
            {qualityStatus ?? CAMERA_STATE_TEXT[cameraState]}
          </p>
          {cameraState === "denied" || cameraState === "unsupported" ? (
            <p className="text-destructive text-sm">{CAMERA_STATE_TEXT[cameraState]}</p>
          ) : null}
          {qualityStatus && cameraState === "live" ? (
            <p className="text-destructive text-sm">{qualityStatus}</p>
          ) : null}
        </section>

        <section aria-labelledby="attest-heading" className="space-y-3 border-t pt-4">
          <h2 id="attest-heading" className="font-medium">
            Attestation
          </h2>
          {/* Phase 1.6 redesign: a single natural-flowing full-width
              paragraph (not a narrow checkbox+text column) with the
              student's name/index colour-coded inline. The checkbox sits
              above the paragraph but both remain one accessible control —
              the <Label> still wraps the full paragraph text, so clicking
              anywhere in the sentence toggles the checkbox, exactly as the
              previous layout did (same htmlFor/id association, same
              accessible name), just restacked visually. */}
          <div className="space-y-2">
            <Checkbox
              id="attestation-checkbox"
              checked={attested}
              onCheckedChange={(checked) => setAttested(checked === true)}
              aria-describedby="attestation-text"
            />
            <Label
              htmlFor="attestation-checkbox"
              id="attestation-text"
              className="block w-full text-sm font-normal leading-relaxed"
            >
              I confirm that I,{" "}
              <span className="text-primary font-semibold">{displayName}</span>, index number{" "}
              <span className="text-primary font-mono font-semibold">
                {indexNumber || <span className="text-muted-foreground font-sans">(not yet entered)</span>}
              </span>
              , am the person taking this assessment. I understand that impersonation is an academic
              offense at USTED and may lead to cancellation of examination results, withdrawal from
              the institution, and other disciplinary measures.
            </Label>
          </div>
        </section>

        <Button type="button" className="w-full" onClick={handleContinue} disabled={!canContinue}>
          <ShieldCheck aria-hidden="true" />
          {submitting ? "Verifying…" : "Confirm identity and continue"}
        </Button>
      </CardContent>
    </Card>
  );
}
