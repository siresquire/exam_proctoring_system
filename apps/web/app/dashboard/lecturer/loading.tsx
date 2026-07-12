import { Skeleton } from "@/components/ui/skeleton";
import { AnalyticsSkeleton } from "@/components/charts/analytics-skeleton";

export default function Loading() {
  return (
    <div aria-hidden="true">
      <AnalyticsSkeleton className="mx-auto max-w-6xl px-4 pt-10 sm:px-6" />
      <div className="mx-auto grid max-w-6xl gap-4 px-4 pt-6 sm:grid-cols-2 sm:px-6 lg:grid-cols-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    </div>
  );
}
