"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createProctorEngine,
  requestFullscreen,
  exitFullscreen,
  type ProctorEngine,
  type ProctorLogResult,
  type ProctorSeverity,
  type WebcamHandle,
} from "@proctor/core";
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  FileWarning,
  Maximize,
  Minimize,
  PlayCircle,
} from "lucide-react";

import { ConsentScreen } from "@/components/proctor/consent-screen";
import { EventFeed, type FeedEvent } from "@/components/proctor/event-feed";
import { IdentityCheck, type IdentityCheckResult } from "@/components/proctor/identity-check";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import {
  createSupabaseStorageAdapter,
  createSupabaseTransportAdapter,
} from "@/lib/proctor/supabase-adapters";
import { createMediaPipeFaceDetectorAdapter } from "@/lib/proctor/face-detector";
import { notify } from "@/lib/notify";
import type { FormsExamRow } from "@/lib/supabase/types";

type Phase = "intro" | "consent" | "identity" | "ready" | "live" | "summary";
type IframeState = "loading" | "loaded" | "failed";

const SNAPSHOT_INTERVAL_MS = 20000;
const HEARTBEAT_INTERVAL_MS = 20000;
const MAX_THUMBNAILS = 6;
/** How long to wait for the Google Form iframe's load event before assuming it was blocked (org-restricted forms, network issues). Generous — Forms can be slow on first paint. */
const IFRAME_LOAD_TIMEOUT_MS = 8000;

interface Thumbnail {
  url: string;
  capturedAt: string;
}

interface SessionSummary {
  startedAt: string;
  endedAt: string;
  counts: Record<ProctorSeverity, number>;
  snapshotCount: number;
  terminated: boolean;
  violationCount: number;
  violationLimit: number;
}

const TIER_LABELS: Record<number, string> = {
  1: "T1 — Quiz",
  2: "T2 — Monitored",
  3: "T3 — Proctored",
  4: "T4 — High stakes",
};

interface FormsExamWrapperProps {
  exam: FormsExamRow;
  fullName: string | null;
}

/**
 * Phase 2a student wrapper: consent -> identity -> the Google Form in an
 * iframe with a live monitoring panel alongside it -> "I have submitted the
 * form" confirmation. Mirrors ProctorDemo's phase machine and engine wiring
 * closely (same building blocks — ConsentScreen, IdentityCheck, EventFeed,
 * MediaPipe face detection via processSnapshot) but:
 *   - skips the policy-editing phase entirely: the exam's tier/policy are
 *     fixed by the lecturer and loaded server-side by start_forms_exam_session,
 *     never chosen here;
 *   - starts the session via start_forms_exam_session(forms_exam_id, ...),
 *     NOT start_proctor_session — there is no violation_policy parameter to
 *     even pass, structurally preventing a client override;
 *   - renders the Google Form in an iframe instead of the sample quiz, with
 *     a persistent honest-limitation notice (we watch the environment, not
 *     the form's contents) and a manual completion step, since we cannot
 *     detect the form's real submit across the cross-origin boundary.
 */
export function FormsExamWrapper({ exam, fullName }: FormsExamWrapperProps) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [thumbnails, setThumbnails] = useState<Thumbnail[]>([]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [terminated, setTerminated] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [violationStanding, setViolationStanding] = useState<{
    count: number;
    limit: number;
  } | null>(null);
  const [iframeState, setIframeState] = useState<IframeState>("loading");
  const [engineForDisplay, setEngineForDisplay] = useState<ProctorEngine | null>(null);
  const [faceDetector] = useState(() => createMediaPipeFaceDetectorAdapter());

  const webcamRef = useRef<WebcamHandle | null>(null);
  const engineRef = useRef<ProctorEngine | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<string | null>(null);
  const countsRef = useRef<Record<ProctorSeverity, number>>({
    info: 0,
    low: 0,
    medium: 0,
    high: 0,
  });
  const snapshotTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const announcedViolationsRef = useRef(0);
  const iframeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    return () => {
      engineRef.current?.stop();
      webcamRef.current?.stop();
      if (snapshotTimerRef.current) clearInterval(snapshotTimerRef.current);
      if (iframeTimeoutRef.current) clearTimeout(iframeTimeoutRef.current);
    };
  }, []);

  // Iframe load-failure detection: Google's own X-Frame-Options (sent for
  // org-restricted forms, RESEARCH.md §1) blocks the load silently — the
  // iframe just never fires `load` and shows nothing. We can't read the
  // cross-origin frame to check, so a timeout is the only signal available:
  // if `load` hasn't fired within IFRAME_LOAD_TIMEOUT_MS, assume it failed
  // and show the graceful fallback (an "open in this window" link).
  useEffect(() => {
    if (phase !== "live") return;
    iframeTimeoutRef.current = setTimeout(() => {
      setIframeState((prev) => (prev === "loaded" ? prev : "failed"));
    }, IFRAME_LOAD_TIMEOUT_MS);
    return () => {
      if (iframeTimeoutRef.current) clearTimeout(iframeTimeoutRef.current);
    };
  }, [phase]);

  const takeSnapshot = useCallback(async () => {
    const webcam = webcamRef.current;
    const sessionId = sessionIdRef.current;
    const supabase = createClient();
    if (!webcam || !sessionId || !supabase) return;

    const blob = await webcam.captureSnapshot({ maxWidth: 640, quality: 0.7 });
    if (!blob) return;

    const capturedAt = new Date().toISOString();
    const storage = createSupabaseStorageAdapter(supabase);
    try {
      await storage.uploadSnapshot(sessionId, blob, { capturedAt, mimeType: "image/jpeg" });
      const url = URL.createObjectURL(blob);
      setThumbnails((prev) => [{ url, capturedAt }, ...prev].slice(0, MAX_THUMBNAILS));
      engineRef.current?.report("snapshot_captured", "info", { widthPx: 640 });
    } catch (err) {
      console.error("Snapshot upload failed", err);
    }

    let bitmap: ImageBitmap | null = null;
    try {
      bitmap = await createImageBitmap(blob);
      await engineRef.current?.processSnapshot(bitmap);
    } catch (err) {
      console.error("Face-presence check failed", err);
    } finally {
      bitmap?.close();
    }
  }, []);

  const finalizeSession = useCallback(
    async (outcome: { terminated: boolean; violationCount: number; violationLimit: number }) => {
      const sessionId = sessionIdRef.current;
      const supabase = createClient();

      if (snapshotTimerRef.current) {
        clearInterval(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
      engineRef.current?.stop();
      await engineRef.current?.flush();
      webcamRef.current?.stop();
      setEngineForDisplay(null);

      if (!outcome.terminated && sessionId && supabase) {
        const { error } = await supabase.rpc("end_proctor_session", { session_id: sessionId });
        if (error) {
          console.error("end_proctor_session failed", error);
        }
      }

      if (document.fullscreenElement) {
        await exitFullscreen();
      }

      setSummary({
        startedAt: startedAtRef.current ?? new Date().toISOString(),
        endedAt: new Date().toISOString(),
        counts: { ...countsRef.current },
        snapshotCount: thumbnails.length,
        terminated: outcome.terminated,
        violationCount: outcome.violationCount,
        violationLimit: outcome.violationLimit,
      });
      setPhase("summary");
    },
    [thumbnails.length],
  );

  const handleConsent = useCallback(() => {
    setPhase("identity");
  }, []);

  const handleIdentityVerified = useCallback(
    async (result: IdentityCheckResult) => {
      const supabase = createClient();
      if (!supabase) {
        await notify.error("Not configured", "Supabase is not configured in this environment.");
        return;
      }

      webcamRef.current = result.webcamHandle;

      // Phase 2a: start_forms_exam_session, NOT start_proctor_session — the
      // exam's tier/policy are loaded server-side from forms_exams; there is
      // no parameter here for the client to supply its own (see the
      // migration's comment on start_forms_exam_session for why that's
      // structural, not just convention).
      const { data: sessionId, error } = await supabase.rpc("start_forms_exam_session", {
        forms_exam_id: exam.id,
        claimed_index_number: result.claimedIndexNumber,
        attested: result.attested,
      });
      if (error || !sessionId) {
        await notify.error("Could not start session", error?.message ?? "Unknown error");
        return;
      }

      try {
        const path = `${sessionId}/identity-${Date.now()}.jpg`;
        const { error: uploadError } = await supabase.storage
          .from("proctoring")
          .upload(path, result.portraitBlob, { contentType: "image/jpeg", upsert: false });
        if (uploadError) throw uploadError;

        const { error: attachError } = await supabase.rpc("attach_identity_portrait", {
          session_id: sessionId,
          storage_path: path,
        });
        if (attachError) throw attachError;
      } catch (err) {
        console.error("Identity portrait upload/attach failed", err);
        await notify.warning(
          "Identity photo not saved",
          "Your session started, but the identity photo could not be uploaded. You may continue.",
        );
      }

      sessionIdRef.current = sessionId;
      startedAtRef.current = new Date().toISOString();
      countsRef.current = { info: 0, low: 0, medium: 0, high: 0 };
      announcedViolationsRef.current = 0;
      setTerminated(false);
      setViolationStanding(null);
      setEvents([]);
      setThumbnails([]);
      setPhase("ready");
    },
    [exam.id],
  );

  const handleStart = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    const supabase = createClient();
    if (!sessionId || !supabase) return;

    const engine = createProctorEngine({
      sessionId,
      adapters: {
        transport: createSupabaseTransportAdapter(supabase),
        faceDetector,
      },
      options: {
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        tier: (exam.integrity_tier as 1 | 2 | 3 | 4) ?? 2,
      },
    });

    engine.on((event) => {
      countsRef.current[event.severity] += 1;
      if (event.event_type === "heartbeat" || event.event_type === "snapshot_captured") {
        return;
      }
      setEvents((prev) => [
        {
          event_type: event.event_type,
          severity: event.severity,
          occurred_at: event.occurred_at,
          meta: event.meta,
        },
        ...prev,
      ]);

      if (event.severity === "high") {
        announcedViolationsRef.current += 1;
        const ordinal = announcedViolationsRef.current;
        void notify.examWarning(
          `Violation ${ordinal} recorded`,
          `${event.event_type.replace(/_/g, " ")} — this has been logged to your session.`,
        );
      } else if (event.severity === "medium") {
        void notify.examWarning(
          "Integrity signal recorded",
          `${event.event_type.replace(/_/g, " ")} — this has been logged to your session.`,
        );
      }
    });

    engine.onViolationUpdate((result: ProctorLogResult) => {
      setViolationStanding({ count: result.violation_count, limit: result.violation_limit });
    });

    engine.onTerminated((result: ProctorLogResult) => {
      setTerminated(true);
      setViolationStanding({ count: result.violation_count, limit: result.violation_limit });
      void notify.error(
        "Session ended: violation limit reached",
        "A report has been sent to your lecturer for review.",
      );
      void finalizeSession({
        terminated: true,
        violationCount: result.violation_count,
        violationLimit: result.violation_limit,
      });
    });

    engine.start();
    engineRef.current = engine;
    setEngineForDisplay(engine);

    void takeSnapshot();
    snapshotTimerRef.current = setInterval(() => void takeSnapshot(), SNAPSHOT_INTERVAL_MS);

    setPhase("live");
    await notify.toast({ title: "Monitored session started" });
  }, [finalizeSession, takeSnapshot, faceDetector, exam.integrity_tier]);

  const handleSubmitted = useCallback(async () => {
    const confirmed = await notify.confirm({
      title: "Confirm you have submitted the form?",
      text: "We cannot see your answers or detect your submission automatically — only you can confirm this. Ending the session stops monitoring and the camera.",
      confirmButtonText: "Yes, I have submitted",
    });
    if (!confirmed) return;

    await finalizeSession({ terminated: false, violationCount: 0, violationLimit: 0 });
    await notify.success("Session ended", "Your summary is below.");
  }, [finalizeSession]);

  async function handleToggleFullscreen() {
    if (document.fullscreenElement) {
      await exitFullscreen();
    } else {
      const ok = await requestFullscreen();
      if (!ok) {
        await notify.warning(
          "Fullscreen unavailable",
          "Your browser blocked or does not support fullscreen.",
        );
      }
    }
  }

  if (phase === "intro") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">{exam.title}</CardTitle>
            <CardDescription>
              Proctored Google Forms quiz — tier {TIER_LABELS[exam.integrity_tier] ?? exam.integrity_tier}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-secondary/50 rounded-md border p-3 text-sm">
              <p className="flex items-start gap-2 font-medium">
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                What we can and cannot see
              </p>
              <p className="text-muted-foreground mt-1">
                The form itself runs on Google&apos;s servers — we cannot read its questions, your
                answers, or detect when you press Google&apos;s own Submit button. What we monitor
                is your <em>exam environment</em>: tab switches, window focus, fullscreen exits,
                clipboard use, your camera, and extra displays — the same signals used throughout
                this platform. When you are done, you confirm submission yourself with a button in
                this page.
              </p>
            </div>
            <p className="text-muted-foreground text-sm">
              You&apos;ll consent to monitoring, verify your identity, then the form opens alongside
              a live monitoring panel. Reaching this exam&apos;s violation limit ends your session
              automatically and files a report for your lecturer to review — automated flags are
              never a final verdict on their own.
            </p>
            <Button onClick={() => setPhase("consent")}>Begin</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (phase === "consent") {
    return (
      <div className="px-4 py-10 sm:px-6">
        <ConsentScreen onConsent={handleConsent} />
      </div>
    );
  }

  if (phase === "identity") {
    return (
      <div className="px-4 py-10 sm:px-6">
        <IdentityCheck fullName={fullName} onVerified={handleIdentityVerified} faceDetector={faceDetector} />
      </div>
    );
  }

  if (phase === "ready") {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-xl">Ready to start</CardTitle>
            <CardDescription>
              Identity verified, consent recorded, and camera checked. Starting will open the form
              and begin monitoring immediately.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={handleStart}>
              <PlayCircle aria-hidden />
              Start monitored session
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (phase === "live") {
    return (
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-10 sm:px-6">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-xl">
                <span className="relative flex size-3">
                  <span className="bg-destructive absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:animate-none" />
                  <span className="bg-destructive relative inline-flex size-3 rounded-full" />
                </span>
                {exam.title}
              </CardTitle>
              <CardDescription>
                Monitoring is active.
                {violationStanding
                  ? ` Strikes: ${violationStanding.count} of ${violationStanding.limit}.`
                  : null}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleToggleFullscreen} disabled={terminated}>
                {isFullscreen ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
                {isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              </Button>
              <Button onClick={handleSubmitted} disabled={terminated}>
                I have submitted the form
              </Button>
            </div>
          </CardHeader>
        </Card>

        <div className="bg-secondary/50 flex items-start gap-2 rounded-md border p-3 text-sm">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <p>
            We monitor your exam environment only — not the form&apos;s questions or answers. Use
            the button above to confirm submission when you are finished; we cannot detect
            Google&apos;s own submit action.
          </p>
        </div>

        {terminated ? (
          <Card className="border-destructive">
            <CardContent className="flex items-start gap-3 py-4">
              <FileWarning aria-hidden className="text-destructive mt-0.5 size-5 shrink-0" />
              <div>
                <p className="font-medium">Session ended: violation limit reached.</p>
                <p className="text-muted-foreground text-sm">
                  A report has been sent to your lecturer for review. The form below is now locked.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <Card className={terminated ? "pointer-events-none opacity-50" : undefined}>
            <CardContent className="p-0">
              {iframeState === "failed" ? (
                <div className="space-y-3 p-6 text-sm">
                  <p className="flex items-start gap-2 font-medium">
                    <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                    The form did not load in this window
                  </p>
                  <p className="text-muted-foreground">
                    This can happen when a Google Form is restricted to signed-in users within an
                    organization. Monitoring is still running — open the form in this same
                    monitored window using the link below, then continue.
                  </p>
                  <Button asChild variant="outline">
                    <a href={exam.google_form_url} target="_self" rel="noopener noreferrer">
                      <ExternalLink aria-hidden />
                      Open form in this monitored window
                    </a>
                  </Button>
                </div>
              ) : (
                <iframe
                  title={`${exam.title} — Google Form`}
                  src={exam.google_form_url}
                  className="h-[80vh] w-full rounded-md border-0"
                  allow="camera *; microphone *"
                  onLoad={() => setIframeState("loaded")}
                />
              )}
            </CardContent>
          </Card>

          <details
            open={panelOpen}
            onToggle={(event) => setPanelOpen(event.currentTarget.open)}
            className="rounded-xl border"
          >
            <summary
              aria-expanded={panelOpen}
              className="flex min-h-11 cursor-pointer select-none list-none items-center justify-between gap-2 rounded-t-xl px-4 py-3 text-sm font-medium"
            >
              Monitoring panel
              <ChevronDown
                aria-hidden
                className={
                  panelOpen
                    ? "size-4 rotate-180 transition-transform"
                    : "size-4 transition-transform"
                }
              />
            </summary>
            <div className="space-y-6 border-t px-4 py-4">
              <section>
                <h2 className="mb-2 text-sm font-medium">Live event feed</h2>
                <p className="text-muted-foreground mb-2 text-xs">
                  Newest first. Announces politely to screen readers.
                </p>
                <EventFeed events={events} />
              </section>

              <section>
                <h2 className="mb-2 text-sm font-medium">Recent snapshots</h2>
                <p className="text-muted-foreground mb-2 text-xs">
                  Latest {MAX_THUMBNAILS}, captured every {SNAPSHOT_INTERVAL_MS / 1000}s.
                </p>
                {thumbnails.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No snapshots captured yet.</p>
                ) : (
                  <ul className="grid grid-cols-3 gap-2">
                    {thumbnails.map((thumb) => (
                      <li key={thumb.capturedAt}>
                        {/* eslint-disable-next-line @next/next/no-img-element --
                            local blob: URL for a just-captured snapshot; next/image
                            optimization doesn't apply here. */}
                        <img
                          src={thumb.url}
                          alt={`Webcam snapshot captured at ${new Date(thumb.capturedAt).toLocaleTimeString()}`}
                          className="aspect-video w-full rounded-md border object-cover"
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </details>
        </div>
        {/* engineForDisplay kept for parity with the demo's imperative access pattern; no harness is rendered in the wrapper (the lecturer already fixed the policy). */}
        {engineForDisplay ? null : null}
      </div>
    );
  }

  // summary
  const total = summary
    ? summary.counts.info + summary.counts.low + summary.counts.medium + summary.counts.high
    : 0;
  const durationMs = summary
    ? new Date(summary.endedAt).getTime() - new Date(summary.startedAt).getTime()
    : 0;
  const durationLabel = `${Math.floor(durationMs / 60000)}m ${Math.round((durationMs % 60000) / 1000)}s`;

  return (
    <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">
            {summary?.terminated ? "Session summary — submitted for review" : "Session summary"}
          </CardTitle>
          <CardDescription>Duration: {durationLabel}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {summary?.terminated ? (
            <div className="border-destructive bg-destructive/5 flex items-start gap-3 rounded-md border p-3">
              <FileWarning aria-hidden className="text-destructive mt-0.5 size-5 shrink-0" />
              <p className="text-sm">
                This session was ended automatically after reaching {summary.violationCount} of{" "}
                {summary.violationLimit} allowed violations. A report has been filed and is pending
                lecturer review — no automatic penalty has been applied.
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              Monitoring has ended. If you have not already submitted the Google Form itself,
              return to it and submit — this wrapper only tracked your exam environment, not your
              form answers.
            </p>
          )}
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground text-xs">Total events</dt>
              <dd className="text-lg font-semibold">{total}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">High severity</dt>
              <dd className="text-lg font-semibold">
                <Badge variant="destructive">{summary?.counts.high ?? 0}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Medium severity</dt>
              <dd className="text-lg font-semibold">{summary?.counts.medium ?? 0}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground text-xs">Low / info</dt>
              <dd className="text-lg font-semibold">
                {(summary?.counts.low ?? 0) + (summary?.counts.info ?? 0)}
              </dd>
            </div>
          </dl>
          <p className="text-muted-foreground text-sm">
            Snapshots captured:{" "}
            <span className="text-foreground font-medium">{summary?.snapshotCount ?? 0}</span>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
