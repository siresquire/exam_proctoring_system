import { describe, expect, it } from "vitest";

import { defaultSeverity } from "./types";

describe("defaultSeverity", () => {
  it("maps tab_hidden to medium regardless of tier", () => {
    expect(defaultSeverity("tab_hidden", 1)).toBe("medium");
    expect(defaultSeverity("tab_hidden", 4)).toBe("medium");
  });

  it("escalates fullscreen_exit to high at tier >= 3, medium below", () => {
    expect(defaultSeverity("fullscreen_exit", 1)).toBe("medium");
    expect(defaultSeverity("fullscreen_exit", 2)).toBe("medium");
    expect(defaultSeverity("fullscreen_exit", 3)).toBe("high");
    expect(defaultSeverity("fullscreen_exit", 4)).toBe("high");
  });

  it("escalates copy/paste/cut to medium at tier >= 3, low below", () => {
    expect(defaultSeverity("copy_attempt", 2)).toBe("low");
    expect(defaultSeverity("copy_attempt", 3)).toBe("medium");
    expect(defaultSeverity("paste_attempt", 3)).toBe("medium");
    expect(defaultSeverity("cut_attempt", 3)).toBe("medium");
  });

  it("treats camera_lost and concurrent_session_detected as high", () => {
    expect(defaultSeverity("camera_lost")).toBe("high");
    expect(defaultSeverity("concurrent_session_detected")).toBe("high");
  });

  it("treats benign/lifecycle events as info", () => {
    expect(defaultSeverity("tab_visible")).toBe("info");
    expect(defaultSeverity("window_focus")).toBe("info");
    expect(defaultSeverity("fullscreen_enter")).toBe("info");
    expect(defaultSeverity("connection_restored")).toBe("info");
    expect(defaultSeverity("snapshot_captured")).toBe("info");
    expect(defaultSeverity("session_start")).toBe("info");
    expect(defaultSeverity("session_end")).toBe("info");
    expect(defaultSeverity("heartbeat")).toBe("info");
  });

  it("defaults unknown-to-this-switch values to info without throwing", () => {
    // multi_monitor_detected is deliberately low-signal (info) — a second
    // display isn't itself suspicious, just worth recording.
    expect(defaultSeverity("multi_monitor_detected")).toBe("info");
  });
});
