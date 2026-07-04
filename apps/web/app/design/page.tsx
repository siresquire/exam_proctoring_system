import { Download, Pencil, Trash2 } from "lucide-react";

import { AccessibleFormDemo } from "@/components/design/accessible-form-demo";
import { NotifyDemo } from "@/components/design/notify-demo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const SAMPLE_SESSIONS = [
  { student: "A. Mensah", status: "In progress", flags: 0, connection: "Stable" },
  { student: "K. Owusu", status: "In progress", flags: 2, connection: "Reconnecting" },
  { student: "S. Boateng", status: "Submitted", flags: 1, connection: "Stable" },
];

export default function DesignSystemPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-12 px-4 py-10 sm:px-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Design system</h1>
        <p className="text-muted-foreground mt-2 max-w-2xl">
          Review surface for the design system: notifications, theming, accessible forms, tables,
          and icon+text buttons. Use the theme toggle in the header to check all three themes; try a
          keyboard-only pass and 200% zoom.
        </p>
      </header>

      <section aria-labelledby="notify-heading" className="space-y-4">
        <h2 id="notify-heading" className="text-xl font-semibold tracking-tight">
          Notifications (lib/notify.ts)
        </h2>
        <p className="text-muted-foreground max-w-2xl">
          Every popup, confirmation, and toast on the platform routes through the single SweetAlert2
          gateway. All variants below are theme-aware, honor reduced motion, and return focus to the
          trigger.
        </p>
        <NotifyDemo />
      </section>

      <section aria-labelledby="form-heading" className="space-y-4">
        <h2 id="form-heading" className="text-xl font-semibold tracking-tight">
          Accessible form pattern
        </h2>
        <p className="text-muted-foreground max-w-2xl">
          Submit with both fields empty to see the error summary, focus movement, and inline{" "}
          <code className="font-mono text-sm">aria-describedby</code> errors.
        </p>
        <AccessibleFormDemo />
      </section>

      <section aria-labelledby="table-heading" className="space-y-4">
        <h2 id="table-heading" className="text-xl font-semibold tracking-tight">
          Sample table
        </h2>
        <Card>
          <CardContent>
            <Table>
              <TableCaption>Live sessions for Introduction to Databases — Midterm.</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead>Student</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Flags</TableHead>
                  <TableHead>Connection</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {SAMPLE_SESSIONS.map((session) => (
                  <TableRow key={session.student}>
                    <TableCell className="font-medium">{session.student}</TableCell>
                    <TableCell>{session.status}</TableCell>
                    <TableCell>
                      {session.flags > 0 ? (
                        <Badge variant="destructive">{session.flags} flags</Badge>
                      ) : (
                        <Badge variant="secondary">No flags</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant={session.connection === "Stable" ? "secondary" : "outline"}>
                        {session.connection}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="buttons-heading" className="space-y-4">
        <h2 id="buttons-heading" className="text-xl font-semibold tracking-tight">
          Icon + text buttons
        </h2>
        <p className="text-muted-foreground max-w-2xl">
          Icons are always paired with a visible text label or, where space is tight, an{" "}
          <code className="font-mono text-sm">aria-label</code> plus tooltip — never icon-only
          meaning.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button className="min-h-11">
            <Download aria-hidden="true" />
            Export CSV
          </Button>
          <Button className="min-h-11" variant="outline">
            <Pencil aria-hidden="true" />
            Edit
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                className="min-h-11 min-w-11"
                variant="destructive"
                size="icon"
                aria-label="Delete question"
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete question</TooltipContent>
          </Tooltip>
        </div>
      </section>

      <section aria-labelledby="theme-heading" className="space-y-4">
        <h2 id="theme-heading" className="text-xl font-semibold tracking-tight">
          Themes
        </h2>
        <Card>
          <CardHeader>
            <CardTitle>Light, dark, and high-contrast</CardTitle>
            <CardDescription>
              Use the &quot;Theme&quot; control in the header to switch. High-contrast swaps in pure
              black/white with heavier borders and a 3px focus ring, rather than just inverting dark
              mode.
            </CardDescription>
          </CardHeader>
        </Card>
      </section>
    </div>
  );
}
