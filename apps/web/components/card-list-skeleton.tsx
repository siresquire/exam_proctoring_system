import { Skeleton } from "@/components/ui/skeleton";

interface CardListSkeletonProps {
  /** Number of card placeholders (matches the real page's card count roughly — a rough match is enough since the grid reflows once real cards swap in). */
  cards?: number;
}

/**
 * Route `loading.tsx` fallback for the "breadcrumb + header + card grid"
 * list pages (classes, question banks, exams — see their page.tsx files):
 * same structure (breadcrumb line, title + description + a primary action
 * button, then a card grid) so there's no layout jump when real content
 * arrives. `aria-hidden` — nothing here is worth announcing; the real
 * heading takes over once the route resolves.
 */
export function CardListSkeleton({ cards = 6 }: CardListSkeletonProps) {
  return (
    <div aria-hidden="true" className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <Skeleton className="mb-6 h-4 w-48" />
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Skeleton className="h-11 w-32" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {Array.from({ length: cards }).map((_, i) => (
          <Skeleton key={i} className="h-28 w-full" />
        ))}
      </div>
    </div>
  );
}
