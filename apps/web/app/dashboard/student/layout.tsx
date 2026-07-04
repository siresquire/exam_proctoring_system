import { requireRole } from "@/lib/auth";

// student only — except super_admin, which passes every requireRole check
// (universal role).
export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  await requireRole("student");
  return children;
}
