import { requireRole } from "@/lib/auth";

export default async function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  await requireRole("super_admin");
  return children;
}
