import { redirect } from "next/navigation";

import { DASHBOARD_BY_ROLE, getSessionProfile } from "@/lib/auth";

/** /dashboard: sends each signed-in user to their role's dashboard. */
export default async function DashboardRedirect() {
  const session = await getSessionProfile();
  if (!session) redirect("/login");
  redirect(DASHBOARD_BY_ROLE[session.profile.role]);
}
