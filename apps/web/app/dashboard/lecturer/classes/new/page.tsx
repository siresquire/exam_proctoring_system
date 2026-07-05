import { requireRole } from "@/lib/auth";
import { NewClassForm } from "@/components/onboarding/new-class-form";

export default async function NewClassPage() {
  await requireRole("lecturer", "admin");

  return (
    <div className="mx-auto max-w-xl px-4 py-10 sm:px-6">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">New class</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Give the class a name. The optional code is a short identifier (e.g.{" "}
          <span className="font-mono">CS201-A</span>) shown alongside the name.
        </p>
      </header>
      <NewClassForm />
    </div>
  );
}
