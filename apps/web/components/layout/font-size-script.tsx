import { FONT_SCALE_STORAGE_KEY } from "@/lib/font-scale";

/**
 * Pre-paint font-scale application (WCAG 1.4.4 control, DESIGN.md-style
 * "no flash" requirement) — mirrors next-themes' own technique (see
 * node_modules/next-themes/dist/index.js: a synchronous inline `<script>`
 * rendered before any content, reading localStorage and mutating
 * `document.documentElement` directly, before React hydrates). Rendered as
 * the first child of `<body>` in app/layout.tsx: browsers run a
 * synchronous inline `<script>` before continuing to parse/paint the
 * elements after it, so `html`'s font-size is correct before any text
 * paints, without needing a client component + `useEffect` (which would
 * paint once at 100%, then jump — the flash this exists to avoid).
 */
function applyStoredFontScale(storageKey: string) {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored) document.documentElement.style.fontSize = stored;
  } catch {
    // localStorage disabled/unavailable — fall back to the CSS default (100%).
  }
}

export function FontSizeScript() {
  return (
    <script
      // Not user input: the string is built entirely from this file's own
      // constant + function source, never from request data.
      dangerouslySetInnerHTML={{
        __html: `(${applyStoredFontScale.toString()})(${JSON.stringify(FONT_SCALE_STORAGE_KEY)})`,
      }}
    />
  );
}
