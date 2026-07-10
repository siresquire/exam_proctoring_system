/**
 * Truncates an x-axis category label so long, unpredictable text (exam
 * titles, class names — user content, not a fixed enum like "role") never
 * collides with its neighbors. The full text is never lost: it's still in
 * the tooltip (label prop) and the table fallback every chart ships with —
 * this only shortens the always-visible axis tick.
 */
export function truncateLabel(value: string, max = 14): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
