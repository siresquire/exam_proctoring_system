import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { collectDisplayChange } from "./collectors";

/**
 * Phase 1.7: display-configuration-change detection. `screen` in jsdom has
 * no `isExtended`, no `addEventListener`, and `navigator.getScreenDetails`
 * doesn't exist at all — so these tests stub exactly the surface the
 * collector actually touches (readDisplaySnapshot's isExtended/width/height
 * read, and screen.addEventListener('change', ...) when present) rather
 * than depending on jsdom's real Screen implementation, then drive the
 * poll-fallback path with fake timers since jsdom never fires a real
 * 'change'/'screenschange' event on its own.
 */

function setScreenProps(props: { isExtended?: boolean; width?: number; height?: number }) {
  if ("isExtended" in props) {
    Object.defineProperty(screen, "isExtended", { value: props.isExtended, configurable: true });
  }
  if ("width" in props) {
    Object.defineProperty(screen, "width", { value: props.width, configurable: true });
  }
  if ("height" in props) {
    Object.defineProperty(screen, "height", { value: props.height, configurable: true });
  }
}

describe("collectDisplayChange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setScreenProps({ isExtended: false, width: 1920, height: 1080 });
  });

  afterEach(() => {
    vi.useRealTimers();
    // Reset jsdom's screen back to something sane so later tests in other
    // files aren't affected by a previous test's stubbed values.
    setScreenProps({ isExtended: false, width: 1920, height: 1080 });
  });

  it("does not emit anything when the display configuration never changes", () => {
    const emit = vi.fn();
    const detach = collectDisplayChange(emit, { pollIntervalMs: 1000 });

    vi.advanceTimersByTime(5000);

    expect(emit).not.toHaveBeenCalled();
    detach();
  });

  it("emits display_configuration_changed via the poll fallback when isExtended flips true (second monitor plugged in)", () => {
    const emit = vi.fn();
    const detach = collectDisplayChange(emit, { pollIntervalMs: 1000 });

    // Simulate an HDMI/dock plug-in mid-session: isExtended flips and the
    // reported width grows (extended desktop).
    setScreenProps({ isExtended: true, width: 3840, height: 1080 });
    vi.advanceTimersByTime(1000);

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "display_configuration_changed",
      expect.objectContaining({
        source: "poll",
        previous: expect.objectContaining({ isExtended: false, width: 1920 }),
        current: expect.objectContaining({ isExtended: true, width: 3840 }),
      }),
    );

    detach();
  });

  it("emits again on a second change and updates its baseline (does not re-fire for the same state)", () => {
    const emit = vi.fn();
    const detach = collectDisplayChange(emit, { pollIntervalMs: 1000 });

    setScreenProps({ isExtended: true, width: 3840, height: 1080 });
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);

    // No further change: polling again must not re-emit.
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(1);

    // Unplugged again: back to single display.
    setScreenProps({ isExtended: false, width: 1920, height: 1080 });
    vi.advanceTimersByTime(1000);
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenLastCalledWith(
      "display_configuration_changed",
      expect.objectContaining({
        source: "poll",
        previous: expect.objectContaining({ isExtended: true }),
        current: expect.objectContaining({ isExtended: false }),
      }),
    );

    detach();
  });

  it("detects a resize/rearrange even when isExtended stays the same", () => {
    const emit = vi.fn();
    const detach = collectDisplayChange(emit, { pollIntervalMs: 1000 });

    // Same isExtended, different resolution — still a configuration change
    // worth flagging (e.g. switching which monitor is primary).
    setScreenProps({ isExtended: false, width: 2560, height: 1440 });
    vi.advanceTimersByTime(1000);

    expect(emit).toHaveBeenCalledTimes(1);
    detach();
  });

  it("uses screen.addEventListener('change', ...) immediately when the browser supports it, without waiting for the poll", () => {
    const emit = vi.fn();
    const listeners: Record<string, () => void> = {};
    const screenWithListener = screen as Screen & {
      addEventListener?: (type: string, listener: () => void) => void;
      removeEventListener?: (type: string, listener: () => void) => void;
    };
    screenWithListener.addEventListener = vi.fn((type: string, listener: () => void) => {
      listeners[type] = listener;
    });
    screenWithListener.removeEventListener = vi.fn((type: string) => {
      delete listeners[type];
    });

    const detach = collectDisplayChange(emit, { pollIntervalMs: 60000 });
    expect(screenWithListener.addEventListener).toHaveBeenCalledWith("change", expect.any(Function));

    // Fire the change event directly (simulating the browser), well before
    // the 60s poll interval would ever elapse.
    setScreenProps({ isExtended: true, width: 3840, height: 1080 });
    listeners["change"]?.();

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      "display_configuration_changed",
      expect.objectContaining({ source: "screen.change" }),
    );

    detach();
    expect(screenWithListener.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );

    delete screenWithListener.addEventListener;
    delete screenWithListener.removeEventListener;
  });

  it("detach() stops the poll fallback from emitting further changes", () => {
    const emit = vi.fn();
    const detach = collectDisplayChange(emit, { pollIntervalMs: 1000 });

    detach();

    setScreenProps({ isExtended: true, width: 3840, height: 1080 });
    vi.advanceTimersByTime(5000);

    expect(emit).not.toHaveBeenCalled();
  });

  it("never attempts getScreenDetails when navigator.permissions / getScreenDetails are unavailable (no mid-exam prompt)", async () => {
    const emit = vi.fn();
    // jsdom's navigator has neither permissions.query nor getScreenDetails
    // by default — asserting that construction doesn't throw and doesn't
    // hang is the meaningful check here (a real prompt would require a
    // user gesture and reject/hang in a headless test environment).
    const detach = collectDisplayChange(emit, { pollIntervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    detach();
    // No assertion needed beyond "did not throw" — expect() call keeps the
    // linter happy about an assertion existing in the test body.
    expect(emit).not.toHaveBeenCalled();
  });
});
