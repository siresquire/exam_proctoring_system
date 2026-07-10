import type { LucideIcon } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { STATUS_COLOR_VAR, STATUS_ICON, type ChartStatus } from "@/components/charts/chart-status";

interface StatTileProps {
  /** Sentence case, no trailing colon (dataviz skill's stat-tile contract). */
  label: string;
  /** Pre-formatted display value (e.g. "1,284", "42%") — proportional figures, not tabular-nums (marks-and-anatomy.md: tabular-nums is for columns, not a standalone hero/stat value). */
  value: string;
  icon: LucideIcon;
  /** A status reading always pairs the tile's icon+border color with this same word in `caption` or nearby text — never color alone. */
  status?: ChartStatus;
  caption?: string;
}

/**
 * A single current value — the dataviz skill's "is it even a chart?" table:
 * one headline number is a stat tile, not a one-bar bar chart. Icon carries
 * the same status meaning as the color (never color-alone).
 */
export function StatTile({ label, value, icon: Icon, status, caption }: StatTileProps) {
  const color = status ? STATUS_COLOR_VAR[status] : undefined;
  const StatusIcon = status ? STATUS_ICON[status] : Icon;

  return (
    <Card style={color ? { borderColor: color } : undefined}>
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground flex items-center gap-2 text-sm font-medium">
          <StatusIcon aria-hidden className="size-4" style={color ? { color } : undefined} />
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold" style={color ? { color } : undefined}>
          {value}
        </p>
        {caption ? <p className="text-muted-foreground mt-1 text-xs">{caption}</p> : null}
      </CardContent>
    </Card>
  );
}
