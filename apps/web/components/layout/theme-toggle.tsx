"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Check, Contrast, Moon, Sun, SunMoon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "high-contrast", label: "High contrast", icon: Contrast },
  { value: "system", label: "System", icon: SunMoon },
] as const;

function subscribeNoop() {
  return () => {};
}

/**
 * True only after the client has hydrated. Using useSyncExternalStore
 * (rather than a useState+useEffect pair) avoids the "setState in an
 * effect" anti-pattern while still giving us a render that's guaranteed to
 * happen only on the client, which is what we need to safely read
 * next-themes' resolved theme without a hydration mismatch.
 */
function useMounted() {
  return React.useSyncExternalStore(
    subscribeNoop,
    () => true,
    () => false,
  );
}

/**
 * Header theme toggle. Cycles through light / dark / high-contrast / system.
 * Always paired with a visible text label per DESIGN.md (icons are never
 * the sole means of conveying meaning).
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useMounted();

  // Before hydration we don't know the persisted theme yet (it lives in
  // localStorage, which the server can't see) — always render the
  // "system" option's icon/label on the server and first client render so
  // the two match, then swap to the real value once mounted.
  const current = mounted
    ? (THEME_OPTIONS.find((option) => option.value === theme) ?? THEME_OPTIONS[3])
    : THEME_OPTIONS[3];
  const CurrentIcon = current.icon;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <CurrentIcon aria-hidden="true" className="size-4" />
          <span>Theme: {current.label}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {THEME_OPTIONS.map((option) => {
          const OptionIcon = option.icon;
          const isActive = mounted && theme === option.value;
          return (
            <DropdownMenuItem key={option.value} onSelect={() => setTheme(option.value)}>
              <OptionIcon aria-hidden="true" className="size-4" />
              <span className="flex-1">{option.label}</span>
              {isActive ? <Check aria-hidden="true" className="size-4" /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
