import { DashboardShell } from "@/components/dashboard-shell";

export default function StudentDashboard() {
  return (
    <DashboardShell
      title="Student Dashboard"
      description="Upcoming exams, past results, and appeals. Placeholder shell — wired up in later phases."
      cards={[
        { title: "Upcoming exams", description: "Exams scheduled for your enrolled classes." },
        { title: "Results", description: "Released grades and feedback." },
        { title: "Appeals", description: "Submit or track an appeal on a proctoring verdict." },
      ]}
    />
  );
}
