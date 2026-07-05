"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createProctorEngine,
  requestFullscreen,
  exitFullscreen,
  type ProctorEngine,
  type ProctorSeverity,
  type WebcamHandle,
} from "@proctor/core";
import { AlertTriangle, Camera, Maximize, Minimize, PlayCircle, StopCircle } from "lucide-react";

import { ConsentScreen } from "@/components/proctor/consent-screen";
import { EventFeed, type FeedEvent } from "@/components/proctor/event-feed";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/client";
import { createSupabaseStorageAdapter, createSupabaseTransportAdapter } from "@/lib/proctor/supabase-adapters";
import { notify } from "@/lib/notify";

type Phase = "intro" | "consent" | "ready" | "live" | "summary";

const SNAPSHOT_INTERVAL_MS = 20000;
const HEARTBEAT_INTERVAL_MS = 20000;
const MAX_THUMBNAILS = 6;

interface Thumbnail {
  url: string;
  capturedAt: string;
}

interface SessionSummary {
  startedAt: string;
  endedAt: string;
  counts: Record<ProctorSeverity, number>;
  snapshotCount: number;
}

const TRY_THESE = [
  "Switch to another browser tab and back",
  "Alt-Tab (or Cmd-Tab) to another application and back",
  "Exit fullscreen (press Esc) then re-enter",
  "Select and copy some of this page's text",
  "Turn off Wi-Fi briefly, then reconnect",
  "Right-click anywhere on the page",
];

export function ProctorDemo() {
  const [phase, setPhase] = useState<Phase>("intro");
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [thumbnails, setThumbnails] = useState<Thumbnail[]>([]);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [summary, setSummary] = useState<SessionSummary | null>(null);

  const webcamRef = useRef<WebcamHandle | null>(null);
  const engineRef = useRef<ProctorEngine | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const startedAtRef = useRef<string | null>(null);
  const countsRef = useRef<Record<ProctorSeverity, number>>({ info: 0, low: 0, medium: 0, high: 0 });
  const snapshotTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
  }, []);

  const handleConsent = useCallback(
    async (webcam: WebcamHandle) => {
      webcamRef.current = webcam;
      const supabase = createClient();
      if (!supabase) {
        await notify.error("Not configured", "Supabase is not configured in this environment.");
        return;
      }

      const { data: sessionId, error } = await supabase.rpc("start_proctor_session", {
        context: "demo",
        tier: 2,
      });
      if (error || !sessionId) {
        await notify.error("Could not start session", error?.message ?? "Unknown error");
        return;
      }

      sessionIdRef.current = sessionId;
      startedAtRef.current = new Date().toISOString();
      countsRef.current = { info: 0, low: 0, medium: 0, high: 0 };
      setEvents([]);
      setThumbnails([]);
      setPhase("ready");
    },
    [],
  );

  const handleStart = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    const supabase = createClient();
    if (!sessionId || !supabase) return;

    const engine = createProctorEngine({
      sessionId,
      adapters: { transport: createSupabaseTransportAdapter(supabase) },
      options: { heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS, tier: 2 },
    });

    engine.on((event) => {
      countsRef.current[event.severity] += 1;
      if (event.event_type === "heartbeat" || event.event_type === "snapshot_captured") {
        // Keep the feed focused on integrity-relevant signals; heartbeats
        // and snapshot bookkeeping would drown the list every 20s.
        return;
      }
      setEvents((prev) => [
        { event_type: event.event_type, severity: event.severity, occurred_at: event.occurred_at, meta: event.meta },
        ...prev,
      ]);

      if (event.severity === "high" || event.severity === "medium") {
        void notify.examWarning(
          "Integrity signal recorded",
          `${event.event_type.replace(/_/g, " ")} — this has been logged to your session.`,
        );
      }
    });

    engine.start();
    engineRef.current = engine;

    void takeSnapshot();
    snapshotTimerRef.current = setInterval(() => void takeSnapshot(), SNAPSHOT_INTERVAL_MS);

    setPhase("live");
    await notify.toast({ title: "Monitored session started" });
  }, [takeSnapshot]);

  const handleEnd = useCallback(async () => {
    const confirmed = await notify.confirm({
      title: "End monitored session?",
      text: "This stops event capture and the camera, and finalizes your session summary.",
      confirmButtonText: "End session",
    });
    if (!confirmed) return;

    const sessionId = sessionIdRef.current;
    const supabase = createClient();

    if (snapshotTimerRef.current) {
      clearInterval(snapshotTimerRef.current);
      snapshotTimerRef.current = null;
    }
    engineRef.current?.stop();
    await engineRef.current?.flush();
    webcamRef.current?.stop();

    if (sessionId && supabase) {
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
    });
    setPhase("summary");
    await notify.success("Session ended", "Your summary is below.");
  }, [thumbnails.length]);

  const handleRestart = useCallback(() => {
    sessionIdRef.current = null;
    startedAtRef.current = null;
    setEvents([]);
    setThumbnails([]);
    setSummary(null);
    setPhase("intro");
  }, []);

  async function handleToggleFullscreen() {
    if (document.fullscreenElement) {
      await exitFullscreen();
    } else {
      const ok = await requestFullscreen();
      if (!ok) {
        await notify.warning("Fullscreen unavailable", "Your browser blocked or does not support fullscreen.");
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
            You&apos;ll consent to monitoring, check your camera, then start a short monitored
            session. Try switching tabs, exiting fullscreen, copying text, or going offline — each
            shows up in the live event feed with a severity level, the same way it would appear to a
            human reviewer.
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

  if (phase === "ready") {
    return (
      <Card className="mx-auto max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <Camera aria-hidden className="text-primary" />
            Ready to start
          </CardTitle>
          <CardDescription>
            Consent recorded and camera verified. Starting will begin event capture and periodic
            snapshots immediately.
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
      <div className="mx-auto max-w-4xl space-y-6">
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
              <CardDescription>Events and snapshots are being recorded.</CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleToggleFullscreen}>
                {isFullscreen ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
                {isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
              </Button>
              <Button variant="destructive" onClick={handleEnd}>
                <StopCircle aria-hidden />
                End session
              </Button>
            </div>
          </CardHeader>
        </Card>

        <div className="grid gap-6 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Live event feed</CardTitle>
              <CardDescription>Newest first. Updates announce politely to screen readers.</CardDescription>
            </CardHeader>
            <CardContent>
              <EventFeed events={events} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent snapshots</CardTitle>
              <CardDescription>Latest {MAX_THUMBNAILS}, captured every {SNAPSHOT_INTERVAL_MS / 1000}s.</CardDescription>
            </CardHeader>
            <CardContent>
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
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Things to try</CardTitle>
            <CardDescription>Each of these should appear in the event feed above.</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2 sm:grid-cols-2">
              {TRY_THESE.map((item) => (
                <li key={item} className="text-muted-foreground flex items-start gap-2 text-sm">
                  <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
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
        <CardTitle className="text-xl">Session summary</CardTitle>
        <CardDescription>Duration: {durationLabel}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
          Snapshots captured: <span className="text-foreground font-medium">{summary?.snapshotCount ?? 0}</span>
        </p>
        <Button onClick={handleRestart}>Run the demo again</Button>
      </CardContent>
    </Card>
  );
}
