import { requireRole } from "@/lib/auth";

// admin + super_admin (super_admin passes every requireRole check).
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireRole("admin");
  return children;
}
