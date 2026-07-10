import { AlertOctagon, AlertTriangle, CheckCircle2, ShieldAlert } from "lucide-react";

/**
 * The fixed, reserved status scale (dataviz skill: "status is fixed" — never
 * themed, never reused as a categorical slot). Always paired with an icon +
 * label, never color alone — see StatusBarChartCard's legend.
 */
export type ChartStatus = "good" | "warning" | "serious" | "critical";

export const STATUS_COLOR_VAR: Record<ChartStatus, string> = {
  good: "var(--chart-status-good)",
  warning: "var(--chart-status-warning)",
  serious: "var(--chart-status-serious)",
  critical: "var(--chart-status-critical)",
};

export const STATUS_ICON: Record<ChartStatus, typeof CheckCircle2> = {
  good: CheckCircle2,
  warning: AlertTriangle,
  serious: AlertOctagon,
  critical: ShieldAlert,
};

export const STATUS_LABEL: Record<ChartStatus, string> = {
  good: "Good",
  warning: "Warning",
  serious: "Serious",
  critical: "Critical",
};
