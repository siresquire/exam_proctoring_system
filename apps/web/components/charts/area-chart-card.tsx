"use client";

import * as React from "react";
import { Area, AreaChart, CartesianGrid, XAxis } from "recharts";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { ChartDataTableToggle } from "@/components/charts/chart-data-table";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

export interface AreaChartDatum {
  date: string;
  value: number;
}

interface AreaChartCardProps {
  title: string;
  description?: string;
  data: AreaChartDatum[];
  valueLabel?: string;
  emptyMessage?: string;
}

/**
 * Change-over-time, single series (dataviz skill: trend over time -> line;
 * area for a single series). One hue (brand primary), a 2px stroke over a
 * ~10% wash fill, hairline recessive grid. No legend — one series, the title
 * names it. The crosshair tooltip finds the nearest date on hover/focus;
 * every value is also in the table fallback, so the tooltip never gates.
 */
export function AreaChartCard({ title, description, data, valueLabel = "Entries", emptyMessage = "No activity yet." }: AreaChartCardProps) {
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
            <AreaChart data={data} margin={{ left: 4, right: 4 }} accessibilityLayer>
              <CartesianGrid vertical={false} strokeDasharray="0" stroke="var(--border)" />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tick={{ fontSize: 12 }}
              />
              <ChartTooltip cursor={{ stroke: "var(--border)" }} content={<ChartTooltipContent />} />
              <defs>
                <linearGradient id="area-chart-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--chart-series-1)" stopOpacity={0.1} />
                  <stop offset="100%" stopColor="var(--chart-series-1)" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <Area
                dataKey="value"
                type="monotone"
                stroke="var(--chart-series-1)"
                strokeWidth={2}
                fill="url(#area-chart-fill)"
                isAnimationActive={!reducedMotion}
              />
            </AreaChart>
          </ChartContainer>
        ) : (
          <p className="text-muted-foreground py-8 text-center text-sm">{emptyMessage}</p>
        )}
        <ChartDataTableToggle
          toggleLabel={`Show data table for ${title}`}
          columns={[
            { key: "date", label: "Date" },
            { key: "value", label: valueLabel, align: "right" },
          ]}
          rows={data.map((d) => ({ date: d.date, value: d.value }))}
        />
      </CardContent>
    </Card>
  );
}
