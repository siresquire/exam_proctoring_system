import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createProctorEngine } from "./engine";
import type { ProctorTransportAdapter } from "./types";

describe("createProctorEngine", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeTransport(): ProctorTransportAdapter & { sent: unknown[] } {
    const sent: unknown[] = [];
    return {
      sent,
      async sendEvents(_sessionId, events) {
        sent.push(...events);
      },
    };
  }

  it("start() attaches collectors so a DOM event reaches listeners with mapped severity", () => {
    const transport = makeTransport();
    const engine = createProctorEngine({
      sessionId: "s1",
      adapters: { transport },
      options: { tier: 2 },
    });

    const received: unknown[] = [];
    engine.on((event) => received.push(event));

    engine.start();
    window.dispatchEvent(new Event("blur"));

    expect(received).toEqual([
      expect.objectContaining({ event_type: "window_blur", severity: "low" }),
    ]);

    engine.stop();
  });

  it("stop() detaches collectors so events no longer fire", () => {
    const transport = makeTransport();
    const engine = createProctorEngine({ sessionId: "s2", adapters: { transport } });

    const received: unknown[] = [];
    engine.on((event) => received.push(event));

    engine.start();
    engine.stop();

    window.dispatchEvent(new Event("blur"));
    expect(received).toHaveLength(0);
  });

  it("report() lets a host app inject an arbitrary event/severity (e.g. webcam snapshot_captured)", () => {
    const transport = makeTransport();
    const engine = createProctorEngine({ sessionId: "s3", adapters: { transport } });

    const received: unknown[] = [];
    engine.on((event) => received.push(event));

    engine.report("snapshot_captured", "info", { widthPx: 640 });

    expect(received).toEqual([
      expect.objectContaining({
        event_type: "snapshot_captured",
        severity: "info",
        meta: { widthPx: 640 },
      }),
    ]);
  });

  it("emits a heartbeat on the configured interval while running", async () => {
    const transport = makeTransport();
    const engine = createProctorEngine({
      sessionId: "s4",
      adapters: { transport },
      options: { heartbeatIntervalMs: 1000, batchIntervalMs: 100000 },
    });

    const received: string[] = [];
    engine.on((event) => received.push(event.event_type));

    engine.start();
    await vi.advanceTimersByTimeAsync(3000);
    engine.stop();

    expect(received.filter((t) => t === "heartbeat")).toHaveLength(3);
  });

  it("flush() forwards queued events to the transport adapter", async () => {
    const transport = makeTransport();
    const engine = createProctorEngine({
      sessionId: "s5",
      adapters: { transport },
      options: { batchIntervalMs: 100000 },
    });

    engine.report("copy_attempt", "low");
    await engine.flush();

    expect(transport.sent).toEqual([expect.objectContaining({ event_type: "copy_attempt" })]);
  });

  it("double start()/stop() is idempotent (no duplicate listeners)", () => {
    const transport = makeTransport();
    const engine = createProctorEngine({ sessionId: "s6", adapters: { transport } });

    const received: unknown[] = [];
    engine.on((event) => received.push(event));

    engine.start();
    engine.start(); // second call should be a no-op
    window.dispatchEvent(new Event("blur"));

    expect(received).toHaveLength(1);
    engine.stop();
  });

  it("onTerminated fires once when a batch response reports session_status=terminated, and stops local collection (Phase 1.5)", async () => {
    const sendEvents = vi.fn().mockResolvedValue({
      accepted: true,
      session_status: "terminated",
      violation_count: 3,
      violation_limit: 3,
    });
    const transport: ProctorTransportAdapter = { sendEvents };
    const engine = createProctorEngine({
      sessionId: "s7",
      adapters: { transport },
      options: { batchIntervalMs: 100000 },
    });

    const terminations: unknown[] = [];
    engine.onTerminated((result) => terminations.push(result));

    engine.start();
    engine.report("copy_attempt", "high");
    await engine.flush();

    expect(terminations).toEqual([
      expect.objectContaining({
        session_status: "terminated",
        violation_count: 3,
        violation_limit: 3,
      }),
    ]);

    // Local collection stopped: a DOM event no longer reaches listeners.
    const received: unknown[] = [];
    engine.on((event) => received.push(event));
    window.dispatchEvent(new Event("blur"));
    expect(received).toHaveLength(0);

    // A second flush settling "terminated" again must not double-fire.
    await engine.flush();
    expect(terminations).toHaveLength(1);

    engine.stop();
  });

  it("onViolationUpdate fires on every accepted batch (Phase 1.6), not just at termination", async () => {
    const responses = [
      { accepted: 1, session_status: "active", violation_count: 1, violation_limit: 3 },
      { accepted: 1, session_status: "active", violation_count: 2, violation_limit: 3 },
      { accepted: 1, session_status: "terminated", violation_count: 3, violation_limit: 3 },
    ];
    const sendEvents = vi.fn().mockImplementation(async () => responses.shift());
    const transport: ProctorTransportAdapter = { sendEvents };
    const engine = createProctorEngine({
      sessionId: "s8",
      adapters: { transport },
      options: { batchIntervalMs: 100000 },
    });

    const updates: unknown[] = [];
    engine.onViolationUpdate((result) => updates.push(result));
    const terminations: unknown[] = [];
    engine.onTerminated((result) => terminations.push(result));

    engine.start();
    engine.report("camera_lost", "high");
    await engine.flush();
    engine.report("concurrent_session_detected", "high");
    await engine.flush();
    engine.report("identity_mismatch", "high");
    await engine.flush();

    expect(updates).toEqual([
      expect.objectContaining({ session_status: "active", violation_count: 1 }),
      expect.objectContaining({ session_status: "active", violation_count: 2 }),
      expect.objectContaining({ session_status: "terminated", violation_count: 3 }),
    ]);
    // onTerminated only fires once, for the final (terminal) update.
    expect(terminations).toHaveLength(1);

    engine.stop();
  });
});
