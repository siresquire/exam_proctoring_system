import { describe, expect, it, vi } from "vitest";

import {
  collectClipboard,
  collectConnection,
  collectContextMenu,
  collectFullscreen,
  collectUnload,
  collectVisibility,
  collectWindowFocus,
} from "./collectors";

// Light smoke coverage per the task brief: attach, trigger the underlying
// DOM event, assert emit fired with the right ProctorEvent, detach, assert
// it stops firing. Not exhaustive per-browser-quirk testing.

describe("collectors", () => {
  it("collectVisibility emits tab_hidden/tab_visible and detaches cleanly", () => {
    const emit = vi.fn();
    const detach = collectVisibility(emit);

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(emit).toHaveBeenLastCalledWith("tab_hidden");

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(emit).toHaveBeenLastCalledWith("tab_visible");

    detach();
    emit.mockClear();
    document.dispatchEvent(new Event("visibilitychange"));
    expect(emit).not.toHaveBeenCalled();
  });

  it("collectWindowFocus emits window_blur/window_focus", () => {
    const emit = vi.fn();
    const detach = collectWindowFocus(emit);

    window.dispatchEvent(new Event("blur"));
    expect(emit).toHaveBeenCalledWith("window_blur");

    window.dispatchEvent(new Event("focus"));
    expect(emit).toHaveBeenCalledWith("window_focus");

    detach();
  });

  it("collectFullscreen emits fullscreen_enter/fullscreen_exit based on fullscreenElement", () => {
    const emit = vi.fn();
    const detach = collectFullscreen(emit);

    Object.defineProperty(document, "fullscreenElement", {
      value: document.documentElement,
      configurable: true,
    });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(emit).toHaveBeenLastCalledWith("fullscreen_enter");

    Object.defineProperty(document, "fullscreenElement", { value: null, configurable: true });
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(emit).toHaveBeenLastCalledWith("fullscreen_exit");

    detach();
  });

  it("collectClipboard emits copy/cut/paste attempts", () => {
    const emit = vi.fn();
    const detach = collectClipboard(emit);

    document.dispatchEvent(new Event("copy", { cancelable: true }));
    document.dispatchEvent(new Event("cut", { cancelable: true }));
    document.dispatchEvent(new Event("paste", { cancelable: true }));

    expect(emit).toHaveBeenCalledWith("copy_attempt");
    expect(emit).toHaveBeenCalledWith("cut_attempt");
    expect(emit).toHaveBeenCalledWith("paste_attempt");

    detach();
  });

  it("collectContextMenu emits contextmenu", () => {
    const emit = vi.fn();
    const detach = collectContextMenu(emit);

    document.dispatchEvent(new Event("contextmenu", { cancelable: true }));
    expect(emit).toHaveBeenCalledWith("contextmenu");

    detach();
  });

  it("collectConnection emits connection_lost/connection_restored", () => {
    const emit = vi.fn();
    const detach = collectConnection(emit);

    window.dispatchEvent(new Event("offline"));
    expect(emit).toHaveBeenCalledWith("connection_lost");

    window.dispatchEvent(new Event("online"));
    expect(emit).toHaveBeenCalledWith("connection_restored");

    detach();
  });

  it("collectUnload emits page_unload on beforeunload", () => {
    const emit = vi.fn();
    const detach = collectUnload(emit);

    window.dispatchEvent(new Event("beforeunload"));
    expect(emit).toHaveBeenCalledWith("page_unload");

    detach();
  });
});
