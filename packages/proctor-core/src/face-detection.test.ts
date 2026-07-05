import { describe, expect, it, vi } from "vitest";

import { createProctorEngine } from "./engine";
import type { FaceDetector, ProctorEngineEvent, ProctorTransportAdapter } from "./types";

/**
 * Phase 1.6: face-presence debounce/threshold logic (engine.ts
 * processSnapshot). No real MediaPipe/ML here — a fake FaceDetector lets us
 * assert the engine's own decision logic (debounce no-face, don't debounce
 * multiple-faces, reset on a good frame, respect severity overrides)
 * independent of any actual detector implementation, which is what
 * apps/web's MediaPipe-backed adapter (injected, never imported by this
 * package) supplies in the real app.
 */

function makeTransport(): ProctorTransportAdapter & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    async sendEvents(_sessionId, events) {
      sent.push(...events);
    },
  };
}

/** A FaceDetector whose next N `detect()` calls return queued face counts in order. */
function makeFakeDetector(counts: number[]): FaceDetector {
  const queue = [...counts];
  return {
    async detect() {
      const faceCount = queue.length > 0 ? queue.shift()! : 1;
      return { faceCount };
    },
  };
}

// processSnapshot never looks inside the bitmap it's handed — the fake
// detector ignores it — so an empty object cast is fine for these tests.
const FAKE_BITMAP = {} as ImageBitmap;

describe("face-presence debounce (processSnapshot)", () => {
  it("does NOT emit no_face_detected on a single miss (below default threshold of 2)", async () => {
    const transport = makeTransport();
    const faceDetector = makeFakeDetector([0]);
    const engine = createProctorEngine({
      sessionId: "s1",
      adapters: { transport, faceDetector },
    });

    const received: ProctorEngineEvent[] = [];
    engine.on((event) => received.push(event));

    await engine.processSnapshot(FAKE_BITMAP);

    expect(received.filter((e) => e.event_type === "no_face_detected")).toHaveLength(0);
  });

  it("emits no_face_detected only after `noFaceThreshold` consecutive misses, with default medium severity", async () => {
    const transport = makeTransport();
    const faceDetector = makeFakeDetector([0, 0, 0]);
    const engine = createProctorEngine({
      sessionId: "s2",
      adapters: { transport, faceDetector },
      options: { noFaceThreshold: 2 },
    });

    const received: ProctorEngineEvent[] = [];
    engine.on((event) => received.push(event));

    await engine.processSnapshot(FAKE_BITMAP); // miss 1 — below threshold
    expect(received).toHaveLength(0);

    await engine.processSnapshot(FAKE_BITMAP); // miss 2 — hits threshold
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(
      expect.objectContaining({
        event_type: "no_face_detected",
        severity: "medium",
        meta: expect.objectContaining({ faceCount: 0, consecutiveMisses: 2 }),
      }),
    );

    await engine.processSnapshot(FAKE_BITMAP); // miss 3 (streak reset after the previous report)
    expect(received).toHaveLength(1);
  });

  it("a face reappearing resets the consecutive-miss counter", async () => {
    const transport = makeTransport();
    const faceDetector = makeFakeDetector([0, 1, 0]);
    const engine = createProctorEngine({
      sessionId: "s3",
      adapters: { transport, faceDetector },
      options: { noFaceThreshold: 2 },
    });

    const received: ProctorEngineEvent[] = [];
    engine.on((event) => received.push(event));

    await engine.processSnapshot(FAKE_BITMAP); // miss 1
    await engine.processSnapshot(FAKE_BITMAP); // 1 face -> resets streak
    await engine.processSnapshot(FAKE_BITMAP); // miss 1 again (not miss 3)

    expect(received.filter((e) => e.event_type === "no_face_detected")).toHaveLength(0);
  });

  it("emits multiple_faces_detected immediately (no debounce) with default high severity", async () => {
    const transport = makeTransport();
    const faceDetector = makeFakeDetector([2]);
    const engine = createProctorEngine({
      sessionId: "s4",
      adapters: { transport, faceDetector },
    });

    const received: ProctorEngineEvent[] = [];
    engine.on((event) => received.push(event));

    await engine.processSnapshot(FAKE_BITMAP);

    expect(received).toEqual([
      expect.objectContaining({
        event_type: "multiple_faces_detected",
        severity: "high",
        meta: expect.objectContaining({ faceCount: 2 }),
      }),
    ]);
  });

  it("respects noFaceSeverity/multipleFacesSeverity overrides (demo harness use case)", async () => {
    const transport = makeTransport();
    const faceDetector = makeFakeDetector([0, 0, 2]);
    const engine = createProctorEngine({
      sessionId: "s5",
      adapters: { transport, faceDetector },
      options: { noFaceThreshold: 2, noFaceSeverity: "high", multipleFacesSeverity: "medium" },
    });

    const received: ProctorEngineEvent[] = [];
    engine.on((event) => received.push(event));

    await engine.processSnapshot(FAKE_BITMAP);
    await engine.processSnapshot(FAKE_BITMAP);
    expect(received).toEqual([expect.objectContaining({ event_type: "no_face_detected", severity: "high" })]);

    await engine.processSnapshot(FAKE_BITMAP);
    expect(received).toEqual([
      expect.objectContaining({ event_type: "no_face_detected", severity: "high" }),
      expect.objectContaining({ event_type: "multiple_faces_detected", severity: "medium" }),
    ]);
  });

  it("setNoFaceSeverity changes severity on an already-running engine (demo harness live toggle)", async () => {
    const transport = makeTransport();
    const faceDetector = makeFakeDetector([0, 0, 0, 0]);
    const engine = createProctorEngine({
      sessionId: "s8",
      adapters: { transport, faceDetector },
      options: { noFaceThreshold: 2, noFaceSeverity: "medium" },
    });

    const received: ProctorEngineEvent[] = [];
    engine.on((event) => received.push(event));

    await engine.processSnapshot(FAKE_BITMAP);
    await engine.processSnapshot(FAKE_BITMAP);
    expect(received).toEqual([expect.objectContaining({ severity: "medium" })]);

    engine.setNoFaceSeverity("high");

    await engine.processSnapshot(FAKE_BITMAP);
    await engine.processSnapshot(FAKE_BITMAP);
    expect(received).toEqual([
      expect.objectContaining({ severity: "medium" }),
      expect.objectContaining({ severity: "high" }),
    ]);
  });

  it("is a no-op (never throws) when no faceDetector adapter is configured", async () => {
    const transport = makeTransport();
    const engine = createProctorEngine({ sessionId: "s6", adapters: { transport } });

    const received: ProctorEngineEvent[] = [];
    engine.on((event) => received.push(event));

    await expect(engine.processSnapshot(FAKE_BITMAP)).resolves.toBeUndefined();
    expect(received).toHaveLength(0);
  });

  it("fails open (no event, no throw) when the detector itself throws", async () => {
    const transport = makeTransport();
    const faceDetector: FaceDetector = {
      async detect() {
        throw new Error("wasm crashed");
      },
    };
    const engine = createProctorEngine({
      sessionId: "s7",
      adapters: { transport, faceDetector },
    });

    const received: ProctorEngineEvent[] = [];
    engine.on((event) => received.push(event));

    await expect(engine.processSnapshot(FAKE_BITMAP)).resolves.toBeUndefined();
    expect(received).toHaveLength(0);
  });
});
