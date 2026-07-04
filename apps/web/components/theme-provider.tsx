"use client";

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Wraps next-themes with the platform's three supported themes.
 * `system` maps to the OS `prefers-color-scheme`; `high-contrast` is an
 * explicit user choice (not tied to any OS media feature) that swaps in
 * stronger-contrast CSS variables (see globals.css `.high-contrast`).
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      themes={["light", "dark", "high-contrast"]}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  );
}
