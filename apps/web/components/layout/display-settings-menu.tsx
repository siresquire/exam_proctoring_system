"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Check, Contrast, Moon, Settings2, Sun, SunMoon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  DEFAULT_FONT_SCALE,
  FONT_SCALE_OPTIONS,
  FONT_SCALE_STORAGE_KEY,
  isFontScale,
  type FontScale,
} from "@/lib/font-scale";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "high-contrast", label: "High contrast", icon: Contrast },
  { value: "system", label: "System", icon: SunMoon },
] as const;

function subscribeNoop() {
  return () => {};
}

/** True only after client hydration (persisted prefs live in localStorage, invisible to the server) — same hydration-safe gate the old split controls used. */
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
    // localStorage unavailable — the choice still applies for this page view.
  }
}

/**
 * Consolidated display + accessibility settings: a single icon button beside
 * the account avatar that opens ONE dropdown holding both the text-size
 * (WCAG 1.4.4) and theme (light/dark/high-contrast/system) controls. Merges
 * what used to be two wide header pills into one compact control so the
 * primary nav has room to lay out inline. Selecting an option keeps the menu
 * open (preventDefault on select) so a user can adjust size and theme in one
 * visit; changes are announced via an aria-live region.
 */
export function DisplaySettingsMenu() {
  const mounted = useMounted();
  const { theme, setTheme } = useTheme();
  const [scale, setScale] = React.useState<FontScale>(readStoredScale);
  const [announcement, setAnnouncement] = React.useState("");

  const currentScale = mounted ? scale : DEFAULT_FONT_SCALE;
  const currentTheme = mounted ? theme : "system";

  function handleScale(next: FontScale) {
    applyScale(next);
    setScale(next);
    setAnnouncement(`Text size set to ${next}`);
  }

  function handleTheme(next: string, label: string) {
    setTheme(next);
    setAnnouncement(`Theme set to ${label}`);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            className="min-h-11 min-w-11"
            aria-label="Display and accessibility settings"
          >
            <Settings2 aria-hidden="true" className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          <DropdownMenuLabel>Text size</DropdownMenuLabel>
          {FONT_SCALE_OPTIONS.map((option) => {
            const isActive = mounted && currentScale === option.value;
            return (
              <DropdownMenuItem
                key={option.value}
                // Keep the menu open so size + theme can be adjusted together.
                onSelect={(event) => {
                  event.preventDefault();
                  handleScale(option.value);
                }}
              >
                <span className="flex-1">{option.label}</span>
                {isActive ? <Check aria-hidden="true" className="size-4" /> : null}
              </DropdownMenuItem>
            );
          })}

          <DropdownMenuSeparator />
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          {THEME_OPTIONS.map((option) => {
            const OptionIcon = option.icon;
            const isActive = mounted && currentTheme === option.value;
            return (
              <DropdownMenuItem
                key={option.value}
                onSelect={(event) => {
                  event.preventDefault();
                  handleTheme(option.value, option.label);
                }}
              >
                <OptionIcon aria-hidden="true" className="size-4" />
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
