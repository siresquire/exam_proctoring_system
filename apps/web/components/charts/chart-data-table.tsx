import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export interface ChartTableColumn {
  key: string;
  label: string;
  align?: "left" | "right";
}

export interface ChartTableRow {
  [key: string]: string | number;
}

interface ChartDataTableToggleProps {
  /** Accessible name for the <details> disclosure, e.g. "Show data table for Users by role". */
  toggleLabel: string;
  columns: ChartTableColumn[];
  rows: ChartTableRow[];
}

/**
 * The accessible fallback every chart in this app ships with (dataviz skill,
 * DESIGN.md §5 DoD): every value shown by a mark is also reachable as plain
 * text, never gated behind hover/color alone. Built on native
 * `<details>/<summary>` rather than a custom disclosure widget — it is
 * keyboard-operable, exposes its own expanded/collapsed state to assistive
 * tech, and needs zero ARIA wiring, for free (ponytail: reach for the
 * platform primitive before a bespoke one).
 */
export function ChartDataTableToggle({ toggleLabel, columns, rows }: ChartDataTableToggleProps) {
  return (
    <details className="group mt-3">
      <summary className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 rounded-md text-sm font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:outline-none">
        <span aria-hidden className="inline-block transition-transform group-open:rotate-90">
          ▸
        </span>
        {toggleLabel}
      </summary>
      <div className="mt-2 overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              {columns.map((col) => (
                <TableHead key={col.key} className={col.align === "right" ? "text-right" : undefined}>
                  {col.label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, i) => (
              <TableRow key={i}>
                {columns.map((col) => (
                  <TableCell
                    key={col.key}
                    className={col.align === "right" ? "text-right font-mono tabular-nums" : undefined}
                  >
                    {row[col.key]}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </details>
  );
}
