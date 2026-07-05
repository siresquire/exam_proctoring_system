import { requireRole } from "@/lib/auth";
import { ProctorDemo } from "@/components/proctor/proctor-demo";

// Any authenticated role may open the demo — it's a training/review
// surface, not a real exam attempt, so there is no role restriction beyond
// "signed in" (requireRole with all four roles listed, though super_admin
// would pass regardless).
export default async function ProctorDemoPage() {
  await requireRole("super_admin", "admin", "lecturer", "student");

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Proctoring demo</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Live walkthrough of the proctoring engine shared by the Google Forms wrapper and the
          platform exam room. See README.md &quot;Proctoring engine &amp; demo&quot; for details on
          each signal.
        </p>
      </header>
      <ProctorDemo />
    </div>
  );
}
