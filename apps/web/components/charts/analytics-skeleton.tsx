import { Skeleton } from "@/components/ui/skeleton";

interface AnalyticsSkeletonProps {
  /** Number of stat-tile placeholders (matches the real section's stat row). */
  tiles?: number;
  /** Number of chart-card placeholders (matches the real section's chart grid). */
  charts?: number;
  /** Extra classes on the outer wrapper — pass the real section's own layout classes so the skeleton doesn't shift anything once real content swaps in. */
  className?: string;
}

/**
 * Suspense fallback for a dashboard's analytics section (Task 4: the
 * service-role aggregate / RPC queries are the slow part of every role
 * dashboard — this renders in the analytics section's own place so the rest
 * of the page shell (header, nav cards) can paint immediately while the
 * aggregate query is still running on the server; see PlatformAnalyticsSection
 * / LecturerAnalyticsSection / StudentAnalyticsSection for the real layout
 * this mirrors.
 *
 * `aria-hidden` on the whole placeholder: there is nothing here worth
 * announcing to a screen reader mid-load — the real heading and stats
 * replace it and get announced once the Suspense boundary resolves.
 */
export function AnalyticsSkeleton({ tiles = 4, charts = 4, className }: AnalyticsSkeletonProps) {
  return (
    <div aria-hidden="true" className={className}>
      <Skeleton className="mb-4 h-6 w-48" />
      <div className="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: tiles }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: charts }).map((_, i) => (
          <Skeleton key={i} className="h-64 w-full" />
        ))}
      </div>
    </div>
  );
}
