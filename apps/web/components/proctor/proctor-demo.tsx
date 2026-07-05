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
  Camera,
  ChevronDown,
  FileWarning,
  Maximize,
  Minimize,
  PlayCircle,
  StopCircle,
} from "lucide-react";

import { ConsentScreen } from "@/components/proctor/consent-screen";
import { EventFeed, type FeedEvent } from "@/components/proctor/event-feed";
import { IdentityCheck, type IdentityCheckResult } from "@/components/proctor/identity-check";
import { SampleQuiz } from "@/components/proctor/sample-quiz";
import { ViolationHarness } from "@/components/proctor/violation-harness";
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

type Phase = "intro" | "consent" | "identity" | "ready" | "live" | "summary";

const SNAPSHOT_INTERVAL_MS = 20000;
const HEARTBEAT_INTERVAL_MS = 20000;
const MAX_THUMBNAILS = 6;
/** Mirrors proctor_sessions.violation_limit's server-side default (20260705000001) — display-only fallback before the first log_proctor_events response tells us the real value. */
const DEFAULT_VIOLATION_LIMIT = 3;

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

const TRY_THESE = [
  "Switch to another browser tab and back",
  "Alt-Tab (or Cmd-Tab) to another application and back",
  "Exit fullscreen (press Esc) then re-enter",
  "Select and copy some of this page's text",
  "Turn off Wi-Fi briefly, then reconnect",
  "Right-click anywhere on the page",
];

interface ProctorDemoProps {
  fullName: string | null;
}

export function ProctorDemo({ fullName }: ProctorDemoProps) {
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
  const [noFaceSeverity, setNoFaceSeverity] = useState<"medium" | "high">("medium");
  // Lazy useState initializer (not a ref read during render, which the
  // react-hooks/refs rule forbids): runs exactly once per component
  // instance. createMediaPipeFaceDetectorAdapter() itself does no I/O —
  // it only returns an object whose detect() method lazily loads the
  // MediaPipe WASM runtime + model on first call (see
  // lib/proctor/face-detector.ts) — so constructing it eagerly here is
  // cheap and safe even during SSR.
  const [faceDetector] = useState(() => createMediaPipeFaceDetectorAdapter());
  // Mirrors engineRef.current for JSX reads (ViolationHarness) — refs
  // can't be read during render, so the engine is ALSO tracked in state,
  // set alongside engineRef.current in handleStart/handleRestart. Callbacks
  // still use engineRef for imperative access (report/setNoFaceSeverity),
  // never trigger a re-render just to call a method.
  const [engineForDisplay, setEngineForDisplay] = useState<ProctorEngine | null>(null);

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

  useEffect(() => {
    function onFullscreenChange() {
      setIsFullscreen(Boolean(document.fullscreenElement));
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  // Best-effort cleanup if the component unmounts mid-session (e.g. nav away).
  useEffect(() => {
    return () => {
      engineRef.current?.stop();
      webcamRef.current?.stop();
      if (snapshotTimerRef.current) clearInterval(snapshotTimerRef.current);
    };
  }, []);

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

    // Phase 1.6: run face-presence detection on the same frame just
    // captured. Independent of the upload try/catch above — a storage
    // hiccup shouldn't also skip the face check on an otherwise-good frame.
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

  const handleIdentityVerified = useCallback(async (result: IdentityCheckResult) => {
    const supabase = createClient();
    if (!supabase) {
      await notify.error("Not configured", "Supabase is not configured in this environment.");
      return;
    }

    // Reuse the same webcam stream IdentityCheck opened for the portrait —
    // avoids prompting for camera access twice for one session.
    webcamRef.current = result.webcamHandle;

    const { data: sessionId, error } = await supabase.rpc("start_proctor_session", {
      context: "demo",
      tier: 2,
      claimed_index_number: result.claimedIndexNumber,
      attested: result.attested,
    });
    if (error || !sessionId) {
      await notify.error("Could not start session", error?.message ?? "Unknown error");
      return;
    }

    // Upload the identity portrait under {session_id}/... (storage RLS
    // requires an active session owned by the caller) then link it.
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
  }, []);

  const handleStart = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    const supabase = createClient();
    if (!sessionId || !supabase) return;

    const engine = createProctorEngine({
      sessionId,
      adapters: {
        transport: createSupabaseTransportAdapter(supabase),
        // Phase 1.6: same detector instance IdentityCheck used for the
        // portrait quality gate, reused for in-session
        // no_face_detected/multiple_faces_detected — avoids loading the
        // MediaPipe WASM runtime + model a second time.
        faceDetector,
      },
      options: {
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        tier: 2,
        // Demo harness lets the student flip no_face_detected between
        // medium (human-review signal only, the real-exam default) and
        // high (counts toward the 3-strike termination limit) — see
        // ViolationHarness's toggle and noFaceSeverity state above.
        noFaceSeverity,
      },
    });

    engine.on((event) => {
      countsRef.current[event.severity] += 1;
      if (event.event_type === "heartbeat" || event.event_type === "snapshot_captured") {
        // Keep the feed focused on integrity-relevant signals; heartbeats
        // and snapshot bookkeeping would drown the list every 20s.
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
        // Transparency/fairness (DESIGN.md, PLAN.md Phase 1.5): tell the
        // student exactly which strike this is and what triggered it,
        // BEFORE the server's next batch response might report termination.
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

    // Phase 1.6: keep the harness's live "N / limit" strike counter in sync
    // with the server's actual count as each batch is confirmed — not just
    // once, at termination (onTerminated below still handles that
    // separately: locking the UI and finalizing the session).
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
  }, [finalizeSession, takeSnapshot, noFaceSeverity, faceDetector]);

  const handleQuizSubmit = useCallback(() => {
    void finalizeSession({ terminated: false, violationCount: 0, violationLimit: 0 });
  }, [finalizeSession]);

  const handleEnd = useCallback(async () => {
    const confirmed = await notify.confirm({
      title: "End monitored session?",
      text: "This stops event capture and the camera, and finalizes your session summary.",
      confirmButtonText: "End session",
    });
    if (!confirmed) return;

    await finalizeSession({ terminated: false, violationCount: 0, violationLimit: 0 });
    await notify.success("Session ended", "Your summary is below.");
  }, [finalizeSession]);

  const handleRestart = useCallback(() => {
    sessionIdRef.current = null;
    startedAtRef.current = null;
    setEvents([]);
    setThumbnails([]);
    setSummary(null);
    setTerminated(false);
    setViolationStanding(null);
    setPhase("intro");
  }, []);

  const handleToggleNoFaceSeverity = useCallback(() => {
    setNoFaceSeverity((prev) => {
      const next = prev === "medium" ? "high" : "medium";
      // Flip it on the already-running engine too (not just for the next
      // session) — see ProctorEngine.setNoFaceSeverity's doc comment for
      // why this is a dedicated method rather than recreating the engine.
      engineRef.current?.setNoFaceSeverity(next);
      return next;
    });
  }, []);

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
      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <CardTitle className="text-xl">What this demo shows</CardTitle>
          <CardDescription>
            A training surface for the proctoring engine that will run inside real exams (Phase 2
            Forms wrapper and Phase 4 exam room). Nothing here is graded.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-sm">
            You&apos;ll consent to monitoring, verify your identity, check your camera, then start a
            short monitored session with a sample quiz. Try switching tabs, exiting fullscreen,
            copying text, or going offline — each shows up in the live event feed with a severity
            level, the same way it would appear to a human reviewer. Three high-severity signals end
            the session automatically, just like a real proctored exam.
          </p>
          <p className="text-muted-foreground text-sm">
            Client-side signals are evidence, not proof — a browser can always be tricked. That is
            why every flag here would route to human review before any consequence in a real exam.
          </p>
          <Button onClick={() => setPhase("consent")}>Begin</Button>
        </CardContent>
      </Card>
    );
  }

  if (phase === "consent") {
    return <ConsentScreen onConsent={handleConsent} />;
  }

  if (phase === "identity") {
    return (
      <IdentityCheck
        fullName={fullName}
        onVerified={handleIdentityVerified}
        faceDetector={faceDetector}
      />
    );
  }

  if (phase === "ready") {
    return (
      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Camera aria-hidden className="text-primary" />
            Ready to start
          </CardTitle>
          <CardDescription>
            Identity verified, consent recorded, and camera checked. Starting will begin event
            capture, periodic snapshots, and the sample quiz immediately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={handleStart}>
            <PlayCircle aria-hidden />
            Start monitored session
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (phase === "live") {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-xl">
                <span className="relative flex size-3">
                  <span className="bg-destructive absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:animate-none" />
                  <span className="bg-destructive relative inline-flex size-3 rounded-full" />
                </span>
                Session live
              </CardTitle>
              <CardDescription>
                Events and snapshots are being recorded.
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
              <Button variant="destructive" onClick={handleEnd} disabled={terminated}>
                <StopCircle aria-hidden />
                End session
              </Button>
            </div>
          </CardHeader>
        </Card>

        {terminated ? (
          <Card className="border-destructive">
            <CardContent className="flex items-start gap-3 py-4">
              <FileWarning aria-hidden className="text-destructive mt-0.5 size-5 shrink-0" />
              <div>
                <p className="font-medium">Session ended: violation limit reached.</p>
                <p className="text-muted-foreground text-sm">
                  A report has been sent to your lecturer for review. The quiz below is now locked.
                </p>
              </div>
            </CardContent>
          </Card>
        ) : null}

        <ViolationHarness
          engine={engineForDisplay}
          disabled={terminated}
          violationCount={violationStanding?.count ?? 0}
          violationLimit={violationStanding?.limit ?? DEFAULT_VIOLATION_LIMIT}
          noFaceSeverity={noFaceSeverity}
          onToggleNoFaceSeverity={handleToggleNoFaceSeverity}
        />

        <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
          <SampleQuiz disabled={terminated} onSubmit={handleQuizSubmit} />

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
                            optimization doesn't apply (nothing to fetch/resize
                            remotely) and would just add overhead here. */}
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

              <section>
                <h2 className="mb-2 text-sm font-medium">Things to try</h2>
                <ul className="space-y-2">
                  {TRY_THESE.map((item) => (
                    <li key={item} className="text-muted-foreground flex items-start gap-2 text-xs">
                      <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                      {item}
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          </details>
        </div>
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
    <Card className="mx-auto max-w-2xl">
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
        ) : null}
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
        <Button onClick={handleRestart}>Run the demo again</Button>
      </CardContent>
    </Card>
  );
}
