import {
  AlertTriangle,
  Copy,
  Eye,
  EyeOff,
  Fullscreen,
  Heart,
  Info,
  MinusCircle,
  MousePointerClick,
  PlugZap,
  PowerOff,
  Scissors,
  ScreenShare,
  ScreenShareOff,
  ShieldAlert,
  Unplug,
  UserX,
  Users,
  Video,
  VideoOff,
  XCircle,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import type { ProctorEvent, ProctorSeverity } from "@proctor/core";

export interface FeedEvent {
  event_type: ProctorEvent;
  severity: ProctorSeverity;
  occurred_at: string;
  meta?: Record<string, unknown>;
}

const EVENT_LABELS: Record<ProctorEvent, string> = {
  tab_hidden: "Tab switched away",
  tab_visible: "Tab back in view",
  window_blur: "Window lost focus",
  window_focus: "Window regained focus",
  fullscreen_exit: "Exited fullscreen",
  fullscreen_enter: "Entered fullscreen",
  copy_attempt: "Copy attempted",
  paste_attempt: "Paste attempted",
  cut_attempt: "Cut attempted",
  contextmenu: "Right-click menu opened",
  connection_lost: "Connection lost",
  connection_restored: "Connection restored",
  snapshot_captured: "Snapshot captured",
  camera_lost: "Camera feed lost",
  multi_monitor_detected: "Multiple displays detected",
  page_unload: "Page closed or navigated away",
  heartbeat: "Heartbeat",
  session_start: "Session started",
  session_end: "Session ended",
  concurrent_session_detected: "Concurrent session detected",
  identity_mismatch: "Identity mismatch flagged",
  session_terminated: "Session terminated (violation limit reached)",
  no_face_detected: "No face detected",
  multiple_faces_detected: "Multiple faces detected",
};

const EVENT_ICONS: Record<
  ProctorEvent,
  React.ComponentType<{ className?: string; "aria-hidden": true }>
> = {
  tab_hidden: EyeOff,
  tab_visible: Eye,
  window_blur: MinusCircle,
  window_focus: Eye,
  fullscreen_exit: ScreenShareOff,
  fullscreen_enter: ScreenShare,
  copy_attempt: Copy,
  paste_attempt: Copy,
  cut_attempt: Scissors,
  contextmenu: MousePointerClick,
  connection_lost: Unplug,
  connection_restored: PlugZap,
  snapshot_captured: Video,
  camera_lost: VideoOff,
  multi_monitor_detected: Fullscreen,
  page_unload: PowerOff,
  heartbeat: Heart,
  session_start: Info,
  session_end: Info,
  concurrent_session_detected: AlertTriangle,
  identity_mismatch: ShieldAlert,
  session_terminated: XCircle,
  no_face_detected: UserX,
  multiple_faces_detected: Users,
};

const SEVERITY_VARIANT: Record<ProctorSeverity, "secondary" | "outline" | "destructive"> = {
  info: "secondary",
  low: "outline",
  medium: "outline",
  high: "destructive",
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Live event feed: semantic list (ul/li, not styled divs), newest first,
 * each row = severity Badge (icon + text, never color alone) + event text +
 * timestamp. The list container is aria-live="polite" so screen-reader
 * users hear new entries without losing their place — DESIGN.md's "polite,
 * used sparingly" guidance for a timed/monitored context.
 */
export function EventFeed({ events }: { events: FeedEvent[] }) {
  if (events.length === 0) {
    return (
      <p className="text-muted-foreground text-sm" role="status" aria-live="polite">
        No events yet. Try one of the actions in the checklist below.
      </p>
    );
  }

  return (
    <ul
      aria-live="polite"
      aria-label="Live proctoring event feed"
      className="max-h-96 space-y-2 overflow-y-auto"
    >
      {events.map((event, index) => {
        const Icon = EVENT_ICONS[event.event_type] ?? Info;
        return (
          <li
            key={`${event.occurred_at}-${index}`}
            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
          >
            <div className="flex items-center gap-2">
              <Icon aria-hidden className="text-muted-foreground size-4" />
              <span>{EVENT_LABELS[event.event_type] ?? event.event_type}</span>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={SEVERITY_VARIANT[event.severity]}>
                {event.severity === "high" && <AlertTriangle aria-hidden />}
                {event.severity}
              </Badge>
              <time
                dateTime={event.occurred_at}
                className="text-muted-foreground font-mono text-xs"
              >
                {formatTime(event.occurred_at)}
              </time>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
