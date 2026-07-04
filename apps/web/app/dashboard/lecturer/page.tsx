import { DashboardShell } from "@/components/dashboard-shell";

export default function LecturerDashboard() {
  return (
    <DashboardShell
      title="Lecturer Dashboard"
      description="Build question banks, schedule exams, and review proctoring flags for your classes. Placeholder shell — wired up in later phases."
      cards={[
        { title: "Question banks", description: "Author and version exam questions." },
        { title: "Exams", description: "Schedule exams, set proctoring tier, review results." },
        {
          title: "Live monitoring",
          description: "Watch active exam sessions and respond to flags.",
        },
      ]}
    />
  );
}
