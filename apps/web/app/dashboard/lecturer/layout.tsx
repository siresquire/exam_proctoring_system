import { requireRole } from "@/lib/auth";

// lecturer + admin + super_admin (super_admin passes every requireRole check).
export default async function LecturerLayout({ children }: { children: React.ReactNode }) {
  await requireRole("lecturer", "admin");
  return children;
}
