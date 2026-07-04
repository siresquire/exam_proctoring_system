import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface DashboardShellProps {
  title: string;
  description: string;
  cards: { title: string; description: string }[];
}

/**
 * Minimal accessible dashboard placeholder: a heading and a card grid.
 * No auth gating yet — that lands with the Supabase/RLS layer (Phase 0
 * part 2). Real widgets replace these placeholder cards in later phases.
 */
export function DashboardShell({ title, description, cards }: DashboardShellProps) {
  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="text-muted-foreground mt-2 max-w-2xl">{description}</p>

      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => (
          <Card key={card.title}>
            <CardHeader>
              <CardTitle>{card.title}</CardTitle>
              <CardDescription>{card.description}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </div>
    </div>
  );
}
