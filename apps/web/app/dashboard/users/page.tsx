import { requireRole } from "@/lib/auth";
import { listUsersWithEmail } from "@/lib/admin/users";
import { UsersTable } from "@/components/admin/users-table";

export default async function UsersPage() {
  const session = await requireRole("admin", "super_admin");

  const { users, error } = await listUsersWithEmail();

  return (
    <UsersTable users={users} loadError={error} currentUserId={session.user.id} viewerRole={session.profile.role} />
  );
}
