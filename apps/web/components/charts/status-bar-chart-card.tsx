"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, Cell, LabelList, XAxis } from "recharts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ChartDataTableToggle } from "@/components/charts/chart-data-table";
import { STATUS_COLOR_VAR, STATUS_ICON, STATUS_LABEL, type ChartStatus } from "@/components/charts/chart-status";
import { truncateLabel } from "@/components/charts/truncate-label";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

export interface StatusBarChartDatum {
  category: string;
  value: number;
  status: ChartStatus;
}

interface StatusBarChartCardProps {
  title: string;
  description?: string;
  data: StatusBarChartDatum[];
  valueLabel?: string;
  formatValue?: (value: number) => string;
  emptyMessage?: string;
}

/**
 * Bar chart where color carries STATUS meaning (good/warning/serious/
 * critical), not generic series identity — e.g. proctoring sessions by
 * status, integrity flags by severity. Per the dataviz skill, status color
 * is a small fixed reserved scale and must ALWAYS pair with an icon + label,
 * never color alone: the legend below lists every status actually present,
 * each with its icon and word, and every bar additionally carries its
 * category name on the x-axis (never color as the only identity channel).
 */
export function StatusBarChartCard({
  title,
  description,
  data,
  valueLabel = "Count",
  formatValue = (v) => v.toLocaleString(),
  emptyMessage = "No data yet.",
}: StatusBarChartCardProps) {
  const reducedMotion = useReducedMotion();
  const hasData = data.some((d) => d.value > 0);

  const presentStatuses = Array.from(new Set(data.map((d) => d.status)));

  const config: ChartConfig = {
    value: { label: valueLabel, color: "var(--chart-status-good)" },
  };

  // See BarChartCard's identical comment: tighter cap as category count grows.
  const tickMax = data.length >= 5 ? 8 : data.length === 4 ? 11 : 16;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        {hasData ? (
          <>
            <ChartContainer config={config} className="aspect-auto h-56 w-full">
              <BarChart data={data} margin={{ top: 20, left: 4, right: 4 }} accessibilityLayer>
                <CartesianGrid vertical={false} strokeDasharray="0" stroke="var(--border)" />
                <XAxis
                  dataKey="category"
                  tickLine={false}
                  axisLine={false}
                  tickMargin={8}
                  interval={0}
                  tick={{ fontSize: 12 }}
                  tickFormatter={(value: string) => truncateLabel(value, tickMax)}
                />
                <ChartTooltip
                  cursor={{ fill: "var(--muted)" }}
                  content={
                    <ChartTooltipContent
                      formatter={(value, _name, item) => {
                        const status = (item?.payload as StatusBarChartDatum)?.status;
                        return `${formatValue(Number(value))}${status ? ` — ${STATUS_LABEL[status]}` : ""}`;
                      }}
                    />
                  }
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={!reducedMotion}>
                  {data.map((d, i) => (
                    <Cell key={i} fill={STATUS_COLOR_VAR[d.status]} />
                  ))}
                  <LabelList
                    dataKey="value"
                    position="top"
                    className="fill-foreground"
                    fontSize={12}
                    formatter={(value: unknown) => formatValue(Number(value))}
                  />
                </Bar>
              </BarChart>
            </ChartContainer>
            <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Status legend">
              {presentStatuses.map((status) => {
                const Icon = STATUS_ICON[status];
                return (
                  <li key={status} className="flex items-center gap-1.5 text-xs">
                    <Icon aria-hidden className="size-3.5" style={{ color: STATUS_COLOR_VAR[status] }} />
                    <span className="text-muted-foreground">{STATUS_LABEL[status]}</span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className="text-muted-foreground py-8 text-center text-sm">{emptyMessage}</p>
        )}
        <ChartDataTableToggle
          toggleLabel={`Show data table for ${title}`}
          columns={[
            { key: "category", label: "Category" },
            { key: "status", label: "Status" },
            { key: "value", label: valueLabel, align: "right" },
          ]}
          rows={data.map((d) => ({
            category: d.category,
            status: STATUS_LABEL[d.status],
            value: formatValue(d.value),
          }))}
        />
      </CardContent>
    </Card>
  );
}
