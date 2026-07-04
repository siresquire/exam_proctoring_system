import { DashboardShell } from "@/components/dashboard-shell";

export default function AdminDashboard() {
  return (
    <DashboardShell
      title="Admin Dashboard"
      description="Manage classes, lecturers, and department-level exam settings. Placeholder shell — wired up in later phases."
      cards={[
        { title: "Classes", description: "Create classes and manage enrollment." },
        { title: "Lecturers", description: "Assign lecturers to classes and question banks." },
        {
          title: "Exam windows",
          description: "Review scheduled exam windows across the department.",
        },
      ]}
    />
  );
}
