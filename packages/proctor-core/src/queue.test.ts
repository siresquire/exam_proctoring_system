import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createEventQueue } from "./queue";
import type { ProctorEventPayload, ProctorTransportAdapter } from "./types";

function makeEvent(overrides: Partial<ProctorEventPayload> = {}): ProctorEventPayload {
  return {
    event_type: "tab_hidden",
    severity: "medium",
    occurred_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("createEventQueue", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches enqueued events and sends them together on flush", async () => {
    const sendEvents = vi.fn().mockResolvedValue(undefined);
    const transport: ProctorTransportAdapter = { sendEvents };

    const queue = createEventQueue("session-1", transport, { batchIntervalMs: 5000 });
    queue.enqueue(makeEvent({ event_type: "tab_hidden" }));
    queue.enqueue(makeEvent({ event_type: "window_blur" }));

    await queue.flush();

    expect(sendEvents).toHaveBeenCalledTimes(1);
    expect(sendEvents).toHaveBeenCalledWith(
      "session-1",
      expect.arrayContaining([
        expect.objectContaining({ event_type: "tab_hidden" }),
        expect.objectContaining({ event_type: "window_blur" }),
      ]),
    );
    expect(queue.pendingCount()).toBe(0);
  });

  it("flushes automatically on the batch interval once started", async () => {
    const sendEvents = vi.fn().mockResolvedValue(undefined);
    const queue = createEventQueue("session-1", { sendEvents }, { batchIntervalMs: 1000 });

    queue.enqueue(makeEvent());
    queue.start();

    // start() itself attempts an immediate flush.
    await vi.advanceTimersByTimeAsync(0);
    expect(sendEvents).toHaveBeenCalledTimes(1);

    queue.enqueue(makeEvent({ event_type: "copy_attempt" }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendEvents).toHaveBeenCalledTimes(2);

    queue.stop();
  });

  it("retries with exponential backoff on failure, keeping events queued", async () => {
    const sendEvents = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockRejectedValueOnce(new Error("still down"))
      .mockResolvedValueOnce(undefined);

    const queue = createEventQueue("session-1", { sendEvents }, { batchIntervalMs: 60000 });
    queue.enqueue(makeEvent());

    await queue.flush(); // fails -> schedules retry at 1000ms
    expect(sendEvents).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1000); // retry #2 fails -> schedules at 2000ms
    expect(sendEvents).toHaveBeenCalledTimes(2);
    expect(queue.pendingCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(2000); // retry #3 succeeds
    expect(sendEvents).toHaveBeenCalledTimes(3);
    expect(queue.pendingCount()).toBe(0);
  });

  it("persists pending events to localStorage so a new queue instance (simulating a refresh) recovers them", async () => {
    const sendEvents = vi.fn().mockRejectedValue(new Error("offline"));
    const queueA = createEventQueue("session-refresh", { sendEvents }, { batchIntervalMs: 60000 });
    queueA.enqueue(makeEvent({ event_type: "connection_lost" }));
    await queueA.flush();
    expect(queueA.pendingCount()).toBe(1);

    // Simulate a page refresh: a brand new queue for the same session id
    // reads the same localStorage key and should recover the buffered event.
    const sendEvents2 = vi.fn().mockResolvedValue(undefined);
    const queueB = createEventQueue("session-refresh", { sendEvents: sendEvents2 }, { batchIntervalMs: 60000 });
    expect(queueB.pendingCount()).toBe(1);

    await queueB.flush();
    expect(sendEvents2).toHaveBeenCalledWith(
      "session-refresh",
      expect.arrayContaining([expect.objectContaining({ event_type: "connection_lost" })]),
    );
    expect(queueB.pendingCount()).toBe(0);
  });

  it("keeps events enqueued during an in-flight send for the next flush", async () => {
    let resolveSend: () => void = () => {};
    const sendEvents = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const queue = createEventQueue("session-inflight", { sendEvents }, { batchIntervalMs: 60000 });

    queue.enqueue(makeEvent({ event_type: "tab_hidden" }));
    const flushPromise = queue.flush();

    // Enqueue a second event while the first send is still in flight.
    queue.enqueue(makeEvent({ event_type: "window_blur" }));

    resolveSend();
    await flushPromise;

    expect(sendEvents).toHaveBeenCalledTimes(1);
    expect(queue.pendingCount()).toBe(1); // window_blur wasn't part of the in-flight batch
  });

  it("does not call the transport when there is nothing pending", async () => {
    const sendEvents = vi.fn();
    const queue = createEventQueue("session-empty", { sendEvents });
    await queue.flush();
    expect(sendEvents).not.toHaveBeenCalled();
  });
});
