"use client";

import * as React from "react";
import { Check, TextCursorInput } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_OPTIONS,
  FONT_SCALE_STORAGE_KEY,
  isFontScale,
  type FontScale,
} from "@/lib/font-scale";

function subscribeNoop() {
  return () => {};
}

/** Same hydration-safe "mounted" gate as ThemeToggle — the persisted value lives in localStorage, invisible to the server. */
function useMounted() {
  return React.useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

function readStoredScale(): FontScale {
  if (typeof window === "undefined") return DEFAULT_FONT_SCALE;
  try {
    const stored = window.localStorage.getItem(FONT_SCALE_STORAGE_KEY);
    return stored && isFontScale(stored) ? stored : DEFAULT_FONT_SCALE;
  } catch {
    return DEFAULT_FONT_SCALE;
  }
}

function applyScale(next: FontScale) {
  document.documentElement.style.fontSize = next;
  try {
    window.localStorage.setItem(FONT_SCALE_STORAGE_KEY, next);
  } catch {
    // localStorage disabled/unavailable — the choice still applies for this page view.
  }
}

/**
 * Text-size control (WCAG 1.4.4, alongside the theme toggle) — 100% /
 * 112.5% / 125% / 150%, applied to `<html>` so every `rem` value in the app
 * scales with it, persisted in localStorage, and applied pre-paint by
 * components/layout/font-size-script.tsx (avoids a flash of
 * unscaled-then-scaled text on load, the same problem next-themes solves
 * for color scheme). The current value is always in the visible button
 * label — never icon-only — and announced to screen readers on change.
 */
export function FontSizeControl() {
  const mounted = useMounted();
  // Read lazily (not in an effect): readStoredScale() only touches
  // localStorage/document, neither of which exists during SSR, so the
  // initializer itself is what the `mounted` gate below guards against a
  // hydration mismatch — no state-in-effect needed.
  const [scale, setScale] = React.useState<FontScale>(readStoredScale);
  const [announcement, setAnnouncement] = React.useState("");

  function handleSelect(next: FontScale) {
    applyScale(next);
    setScale(next);
    setAnnouncement(`Text size set to ${next}`);
  }

  const current = mounted ? scale : DEFAULT_FONT_SCALE;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-2">
            <TextCursorInput aria-hidden="true" className="size-4" />
            <span>Text size: {current}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {FONT_SCALE_OPTIONS.map((option) => {
            const isActive = mounted && scale === option.value;
            return (
              <DropdownMenuItem key={option.value} onSelect={() => handleSelect(option.value)}>
                <span className="flex-1">{option.label}</span>
                {isActive ? <Check aria-hidden="true" className="size-4" /> : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </>
  );
}
