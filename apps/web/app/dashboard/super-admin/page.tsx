import { DashboardShell } from "@/components/dashboard-shell";

export default function SuperAdminDashboard() {
  return (
    <DashboardShell
      title="Super Admin Dashboard"
      description="Platform-wide observability: error logs, audit browser, storage and quota status. Placeholder shell — wired up in later phases."
      cards={[
        { title: "System health", description: "Uptime, keep-alive cron status, error rate." },
        { title: "Audit log", description: "Browse every privileged action across the platform." },
        {
          title: "Storage & quota",
          description: "Supabase and R2 usage against free-tier limits.",
        },
      ]}
    />
  );
}
