export function SkipLink() {
  return (
    // Wrapped in its own landmark so the link isn't "unregioned" content
    // sitting directly under <body> (axe-core "region" rule) — it's a
    // one-item navigation mechanism, which is exactly what <nav> is for.
    <nav aria-label="Skip navigation">
      <a
        href="#main-content"
        className="focus:bg-primary focus:text-primary-foreground focus:ring-ring sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:outline-none focus:ring-2 focus:ring-offset-2"
      >
        Skip to content
      </a>
    </nav>
  );
}
