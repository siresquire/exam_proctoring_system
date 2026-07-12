import { Skeleton } from "@/components/ui/skeleton";

interface TablePageSkeletonProps {
  /** Number of row placeholders. */
  rows?: number;
  /** Show the search/filter control row (Users & roles has one; exam results doesn't). */
  withFilters?: boolean;
}

/**
 * Route `loading.tsx` fallback for the "breadcrumb + header + table" pages
 * (Users & roles, exam results — see users-table.tsx / the exam results
 * page.tsx) so the shell renders instantly and the layout doesn't jump once
 * the real table swaps in. `aria-hidden` — nothing here is worth announcing.
 */
export function TablePageSkeleton({ rows = 8, withFilters = false }: TablePageSkeletonProps) {
  return (
    <div aria-hidden="true" className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <Skeleton className="mb-6 h-4 w-48" />
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-11 w-32" />
      </div>
      <div className="space-y-4 rounded-lg border p-4">
        {withFilters ? (
          <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : null}
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
