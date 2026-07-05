/**
 * Font-size scaling (WCAG 1.4.4 "Resize text" beyond browser zoom alone —
 * PLAN.md Phase 1.5, DESIGN.md §3 "Perceivable": "text resizable to 200%
 * without loss; layouts in rem/flex/grid"). Scales apply to the `<html>`
 * element's font-size, which every `rem` unit in the app is relative to —
 * no per-component work needed beyond already being rem-based.
 */

export const FONT_SCALE_STORAGE_KEY = "usted-font-scale";

export const FONT_SCALE_OPTIONS = [
  { value: "100%", label: "100%" },
  { value: "112.5%", label: "112.5%" },
  { value: "125%", label: "125%" },
  { value: "150%", label: "150%" },
] as const;

export type FontScale = (typeof FONT_SCALE_OPTIONS)[number]["value"];

export const DEFAULT_FONT_SCALE: FontScale = "100%";

export function isFontScale(value: string): value is FontScale {
  return FONT_SCALE_OPTIONS.some((option) => option.value === value);
}
