import { cn } from "@/lib/utils";

/**
 * Loading placeholder (DESIGN.md §1 "Motion" — animation gated behind
 * `prefers-reduced-motion`, same posture as SweetAlert2 in lib/notify.ts).
 * `motion-reduce:animate-none` disables the pulse for users who've asked for
 * reduced motion, leaving a static gray block instead. Purely decorative by
 * default (`aria-hidden`) since the real content it stands in for is what
 * gets announced once it loads — callers wrapping a whole section should put
 * `aria-busy="true"` on that section's container, not here.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("bg-muted motion-reduce:animate-none animate-pulse rounded-md", className)}
      {...props}
    />
  );
}

export { Skeleton };
