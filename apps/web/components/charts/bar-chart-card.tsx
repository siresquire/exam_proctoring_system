"use client";

import * as React from "react";
import { Bar, BarChart, CartesianGrid, LabelList, XAxis } from "recharts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ChartDataTableToggle } from "@/components/charts/chart-data-table";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

export interface BarChartDatum {
  category: string;
  value: number;
}

interface BarChartCardProps {
  title: string;
  description?: string;
  data: BarChartDatum[];
  /** Column header for the value in the table fallback, e.g. "Count". */
  valueLabel?: string;
  formatValue?: (value: number) => string;
  emptyMessage?: string;
}

/**
 * Compare-magnitude, single-series bar chart (dataviz skill's "the job -> the
 * type" table: bar/column for magnitude). ONE flat color for every bar
 * (chart-series-1 = brand primary) — per the skill's anti-patterns, a value
 * ramp or one-hue-per-bar on a single series of NOMINAL categories (role,
 * exam status, ...) would double-encode identity the x-axis label already
 * shows. No legend: a single series needs none, the title already names it.
 * Direct value labels ride the cap of every bar (short, discrete category
 * count — unlike a dense line, labeling every bar here is the documented
 * exception, not the "number on every point" anti-pattern).
 */
export function BarChartCard({
  title,
  description,
  data,
  valueLabel = "Count",
  formatValue = (v) => v.toLocaleString(),
  emptyMessage = "No data yet.",
}: BarChartCardProps) {
  const reducedMotion = useReducedMotion();
  const hasData = data.some((d) => d.value > 0);

  const config: ChartConfig = {
    value: { label: valueLabel, color: "var(--chart-series-1)" },
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent>
        {hasData ? (
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
              />
              <ChartTooltip
                cursor={{ fill: "var(--muted)" }}
                content={<ChartTooltipContent formatter={(value) => formatValue(Number(value))} />}
              />
              <Bar dataKey="value" fill="var(--chart-series-1)" radius={[4, 4, 0, 0]} maxBarSize={48} isAnimationActive={!reducedMotion}>
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
        ) : (
          <p className="text-muted-foreground py-8 text-center text-sm">{emptyMessage}</p>
        )}
        <ChartDataTableToggle
          toggleLabel={`Show data table for ${title}`}
          columns={[
            { key: "category", label: "Category" },
            { key: "value", label: valueLabel, align: "right" },
          ]}
          rows={data.map((d) => ({ category: d.category, value: formatValue(d.value) }))}
        />
      </CardContent>
    </Card>
  );
}
