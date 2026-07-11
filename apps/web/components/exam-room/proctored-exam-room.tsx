"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createProctorEngine,
  type ProctorEngine,
  type ProctorLogResult,
  type WebcamHandle,
} from "@proctor/core";
import { ChevronDown, FileWarning, ShieldCheck } from "lucide-react";

import { ExamRoom } from "@/components/exam-room/exam-room";
import { EventFeed, type FeedEvent } from "@/components/proctor/event-feed";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createMediaPipeFaceDetectorAdapter } from "@/lib/proctor/face-detector";
import { createSupabaseTransportAdapter } from "@/lib/proctor/supabase-adapters";
import { createProctorStorageAdapter } from "@/lib/proctor/storage-adapter";
import { notify } from "@/lib/notify";
import { createClient } from "@/lib/supabase/client";
import type { AttemptQuestions } from "@/lib/supabase/types";

const SNAPSHOT_INTERVAL_MS = 20000;
const HEARTBEAT_INTERVAL_MS = 20000;
const MAX_THUMBNAILS = 6;

interface Thumbnail {
  url: string;
  capturedAt: string;
}

interface ProctoredExamRoomProps {
  initial: AttemptQuestions;
  examTitle: string;
  proctorSessionId: string;
  integrityTier: 2 | 3 | 4;
  /** The live webcam stream opened during identity verification, handed off so the engine can reuse it for periodic snapshots without a second camera prompt. Null on a page-refresh resume — see the doc comment below. */
  webcamHandle: WebcamHandle | null;
}

/**
 * Phase 3d-ii: wraps the real exam room (ExamRoom, unchanged) with the same
 * proctor-core engine wiring used by forms-exam-wrapper.tsx and
 * proctor-demo.tsx — started against the session start_exam_attempt already
 * created server-side (context 'exam:<attempt_id>', tier+policy loaded from
 * the EXAM, never chosen here). On server-reported termination
 * (engine.onTerminated, fired from log_proctor_events' response — see the
 * 20260705000013 termination-tie trigger, which closes the exam_attempt in
 * the SAME transaction that flips the session to 'terminated'), this
 * component locks the room and shows the calm termination summary; the
 * underlying attempt is already closed server-side by the time this fires,
 * so there is nothing left for the client to submit.
 *
 * Honest limitation carried over from IdentityCheck: on a fresh session the
 * caller hands off the webcam stream opened during the portrait capture
 * (webcamHandle) so the camera opens exactly once. On a page-refresh RESUME
 * (get_attempt_questions reports an existing proctor_session_id but this
 * component just remounted), there is no stream to reuse — webcamHandle is
 * null and the engine simply runs without snapshot capture until the
 * student's browser session ends; a future iteration could re-prompt for
 * camera access on resume. This does not affect the non-camera signals
 * (fullscreen/tab/clipboard/etc), which proctor-core collects regardless.
 */
export function ProctoredExamRoom({
  initial,
  examTitle,
  proctorSessionId,
  integrityTier,
  webcamHandle,
}: ProctoredExamRoomProps) {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [thumbnails, setThumbnails] = useState<Thumbnail[]>([]);
  const [panelOpen, setPanelOpen] = useState(true);
  const [terminated, setTerminated] = useState(false);
  const [violationStanding, setViolationStanding] = useState<{ count: number; limit: number } | null>(null);
  const [faceDetector] = useState(() => createMediaPipeFaceDetectorAdapter());

  const engineRef = useRef<ProctorEngine | null>(null);
  const webcamRef = useRef<WebcamHandle | null>(webcamHandle);
  const snapshotTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const announcedViolationsRef = useRef(0);

  const takeSnapshot = useCallback(async () => {
    const webcam = webcamRef.current;
    const supabase = createClient();
    if (!webcam || !supabase) return;

    const blob = await webcam.captureSnapshot({ maxWidth: 640, quality: 0.7 });
    if (!blob) return;

    const capturedAt = new Date().toISOString();
    const storage = createProctorStorageAdapter(supabase);
    try {
      await storage.uploadSnapshot(proctorSessionId, blob, { capturedAt, mimeType: "image/jpeg" });
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
  }, [proctorSessionId]);

  useEffect(() => {
    const supabase = createClient();
    if (!supabase) return;

    const engine = createProctorEngine({
      sessionId: proctorSessionId,
      adapters: {
        transport: createSupabaseTransportAdapter(supabase),
        faceDetector,
      },
      options: {
        heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
        tier: integrityTier,
      },
    });

    engine.on((event) => {
      if (event.event_type === "heartbeat" || event.event_type === "snapshot_captured") {
        return;
      }
      setEvents((prev) => [
        { event_type: event.event_type, severity: event.severity, occurred_at: event.occurred_at, meta: event.meta },
        ...prev,
      ]);

      // Accessibility (DESIGN.md §3): accommodations already annotate rather
      // than hard-fail AT-triggered signals server-side (the policy/severity
      // is assigned by log_proctor_events, not here) — this toast is purely
      // informational, calm wording, never alarming (notify.examWarning
      // never uses the "error" red treatment).
      if (event.severity === "high") {
        announcedViolationsRef.current += 1;
        void notify.examWarning(
          `Violation ${announcedViolationsRef.current} recorded`,
          `${event.event_type.replace(/_/g, " ")} — logged to your proctoring session.`,
        );
      } else if (event.severity === "medium") {
        void notify.examWarning(
          "Integrity signal recorded",
          `${event.event_type.replace(/_/g, " ")} — logged to your proctoring session.`,
        );
      }
    });

    engine.onViolationUpdate((result: ProctorLogResult) => {
      setViolationStanding({ count: result.violation_count, limit: result.violation_limit });
    });

    engine.onTerminated((result: ProctorLogResult) => {
      setTerminated(true);
      setViolationStanding({ count: result.violation_count, limit: result.violation_limit });
      if (snapshotTimerRef.current) {
        clearInterval(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
      webcamRef.current?.stop();
      void notify.error(
        "Session ended: violation limit reached",
        "Your attempt was submitted for review. Your lecturer will review the proctoring report.",
      );
    });

    engine.start();
    engineRef.current = engine;

    // Captured once at effect-setup time (not re-read from the ref in
    // cleanup below) — webcamHandle is handed off exactly once per attempt
    // (see IdentityCheck) and never reassigned during this component's
    // life, so the ref and this local always agree; capturing it locally
    // avoids the "ref value may have changed by cleanup time" lint warning
    // that applies to refs which CAN be reassigned mid-lifecycle.
    const webcam = webcamRef.current;
    if (webcam) {
      void takeSnapshot();
      snapshotTimerRef.current = setInterval(() => void takeSnapshot(), SNAPSHOT_INTERVAL_MS);
    }

    return () => {
      engine.stop();
      void engine.flush();
      if (snapshotTimerRef.current) {
        clearInterval(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
      webcam?.stop();
    };
  }, [proctorSessionId, integrityTier, faceDetector, takeSnapshot]);

  if (terminated) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <Card className="border-destructive">
          <CardHeader>
            <CardTitle className="text-xl">Session ended — submitted for review</CardTitle>
            <CardDescription>{examTitle}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="border-destructive bg-destructive/5 flex items-start gap-3 rounded-md border p-3">
              <FileWarning aria-hidden className="text-destructive mt-0.5 size-5 shrink-0" />
              <p className="text-sm">
                Your attempt reached this exam&apos;s violation limit
                {violationStanding ? ` (${violationStanding.count} of ${violationStanding.limit})` : ""} and
                was automatically submitted with your answers so far. Any answered objective questions have
                already been graded; a report has been filed for your lecturer to review — this is not a
                final verdict.
              </p>
            </div>
            <p className="text-muted-foreground text-sm">
              You will be able to see your result once your lecturer releases it, from your dashboard&apos;s
              results section.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
        <span className="flex items-center gap-2">
          <span className="relative flex size-2.5">
            <span className="bg-destructive absolute inline-flex size-full animate-ping rounded-full opacity-75 motion-reduce:animate-none" />
            <span className="bg-destructive relative inline-flex size-2.5 rounded-full" />
          </span>
          Proctoring active — tier {integrityTier}
          {violationStanding ? ` · strikes ${violationStanding.count} of ${violationStanding.limit}` : ""}
        </span>
        <ShieldCheck aria-hidden className="text-muted-foreground size-4" />
      </div>

      <ExamRoom initial={initial} examTitle={examTitle} />

      <details
        open={panelOpen}
        onToggle={(event) => setPanelOpen(event.currentTarget.open)}
        className="mx-auto max-w-6xl rounded-xl border px-4 py-2 sm:px-6"
      >
        <summary
          aria-expanded={panelOpen}
          className="flex min-h-11 cursor-pointer select-none list-none items-center justify-between gap-2 py-2 text-sm font-medium"
        >
          Monitoring panel
          <ChevronDown
            aria-hidden
            className={panelOpen ? "size-4 rotate-180 transition-transform" : "size-4 transition-transform"}
          />
        </summary>
        <div className="grid gap-6 border-t py-4 lg:grid-cols-2">
          <section>
            <h2 className="mb-2 text-sm font-medium">Live event feed</h2>
            <p className="text-muted-foreground mb-2 text-xs">Newest first. Announces politely to screen readers.</p>
            <EventFeed events={events} />
          </section>
          <section>
            <h2 className="mb-2 text-sm font-medium">Recent snapshots</h2>
            <p className="text-muted-foreground mb-2 text-xs">
              Latest {MAX_THUMBNAILS}, captured every {SNAPSHOT_INTERVAL_MS / 1000}s.
            </p>
            {thumbnails.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {webcamHandle ? "No snapshots captured yet." : "Camera not reattached after resume — non-camera monitoring is still active."}
              </p>
            ) : (
              <ul className="grid grid-cols-3 gap-2">
                {thumbnails.map((thumb) => (
                  <li key={thumb.capturedAt}>
                    {/* eslint-disable-next-line @next/next/no-img-element --
                        local blob: URL for a just-captured snapshot. */}
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
  );
}
