/**
 * Hand-written Database types mirroring supabase/migrations. Shaped like the
 * output of `supabase gen types typescript` so it can be replaced verbatim
 * once a live project exists (see README.md "Supabase setup"):
 *
 *   supabase gen types typescript --linked > apps/web/lib/supabase/types.ts
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type UserRole = "super_admin" | "admin" | "lecturer" | "student";

export type ProctorSessionStatus = "active" | "ended" | "abandoned" | "terminated";
export type ProctorSeverity = "info" | "low" | "medium" | "high";
export type ProctorReportStatus = "pending_review" | "reviewed";
export type ProctorReportVerdict = "pass" | "escalate" | "violation";

/** Phase 2a: forms_exams.status. draft is never visible to students; published is the only state start_forms_exam_session accepts; closed stops new sessions. */
export type FormsExamStatus = "draft" | "published" | "closed";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          role: UserRole;
          full_name: string | null;
          /** USTED index number, exactly 10 digits (CHECK profiles_student_number_format). Null for staff. */
          student_number: string | null;
          /**
           * Documented keys (see SQL comment on profiles.accommodations):
           * extra_time_multiplier (number), suppress_at_flags (boolean),
           * notes (string).
           */
          accommodations: Json;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          role?: UserRole;
          full_name?: string | null;
          student_number?: string | null;
          accommodations?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          role?: UserRole;
          full_name?: string | null;
          student_number?: string | null;
          accommodations?: Json;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      audit_log: {
        Row: {
          id: number;
          actor_id: string | null;
          action: string;
          target_type: string | null;
          target_id: string | null;
          metadata: Json;
          ip: string | null;
          created_at: string;
        };
        // audit_log is append-only and writable only via the log_audit()
        // RPC; Insert/Update types exist to satisfy the client's generics
        // but no RLS policy permits direct writes.
        Insert: {
          actor_id?: string | null;
          action: string;
          target_type?: string | null;
          target_id?: string | null;
          metadata?: Json;
          ip?: string | null;
          created_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      keepalive: {
        Row: {
          id: number;
          pinged_at: string;
        };
        Insert: {
          id: number;
          pinged_at?: string;
        };
        Update: never;
        Relationships: [];
      };
      proctor_sessions: {
        Row: {
          id: string;
          user_id: string;
          context: string;
          status: ProctorSessionStatus;
          integrity_tier: number;
          consent_given_at: string;
          user_agent: string | null;
          started_at: string;
          ended_at: string | null;
          last_heartbeat_at: string | null;
          /** Phase 1.5: strikes tolerated before auto-termination (default 3). */
          violation_limit: number;
          /** Phase 1.5: running count of high-severity events, maintained by log_proctor_events(). */
          violation_count: number;
          /** Phase 1.5: storage path of the one-shot identity portrait, set via attach_identity_portrait(). */
          identity_portrait_path: string | null;
          /** Phase 1.5: index number entered at the identity step. */
          claimed_index_number: string | null;
          /** Phase 1.5: server-stamped attestation timestamp, set by start_proctor_session. */
          attested_at: string | null;
          /** Phase 1.7: snapshot of event_type -> {severity, counts}, merged from default_violation_policy() + caller overrides at start_proctor_session time. log_proctor_events reads this, never the client payload's severity. */
          violation_policy: Json;
        };
        // Writable only via start_proctor_session/end_proctor_session/
        // attach_identity_portrait RPCs (security definer) — no client
        // INSERT/UPDATE policy exists.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      proctor_events: {
        Row: {
          id: number;
          session_id: string;
          event_type: string;
          severity: ProctorSeverity;
          occurred_at: string;
          received_at: string;
          meta: Json;
        };
        // Writable only via log_proctor_events() RPC.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      proctor_media: {
        Row: {
          id: number;
          session_id: string;
          storage_path: string;
          kind: "snapshot" | "clip";
          captured_at: string;
          created_at: string;
        };
        // Writable only via record_proctor_media() RPC.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      proctor_reports: {
        Row: {
          id: string;
          session_id: string;
          reason: "violation_limit_reached";
          summary: Json;
          generated_at: string;
          status: ProctorReportStatus;
          reviewed_by: string | null;
          reviewed_at: string | null;
          verdict: ProctorReportVerdict | null;
        };
        // Append-only, filed only by log_proctor_events() (security
        // definer). reviewed_by/reviewed_at/verdict are reserved for the
        // Phase 4 review RPC — no client UPDATE policy exists yet.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      forms_exams: {
        Row: {
          id: string;
          owner_id: string;
          title: string;
          /** Normalized to the embeddable form (".../viewform?embedded=true") server-side — see lib/forms/google-form-url.ts. Never trust an un-normalized value from the client. */
          google_form_url: string;
          integrity_tier: number;
          /** Lecturer-chosen policy snapshotted onto every session start_forms_exam_session creates for this exam. The student never supplies this. */
          violation_policy: Json;
          opens_at: string | null;
          closes_at: string | null;
          duration_minutes: number | null;
          status: FormsExamStatus;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          owner_id: string;
          title: string;
          google_form_url: string;
          integrity_tier?: number;
          violation_policy?: Json;
          opens_at?: string | null;
          closes_at?: string | null;
          duration_minutes?: number | null;
          status?: FormsExamStatus;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          title?: string;
          google_form_url?: string;
          integrity_tier?: number;
          violation_policy?: Json;
          opens_at?: string | null;
          closes_at?: string | null;
          duration_minutes?: number | null;
          status?: FormsExamStatus;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      current_user_role: {
        Args: Record<string, never>;
        Returns: UserRole;
      };
      has_role: {
        Args: { roles: UserRole[] };
        Returns: boolean;
      };
      is_admin_or_higher: {
        Args: Record<string, never>;
        Returns: boolean;
      };
      log_audit: {
        Args: {
          action: string;
          target_type?: string | null;
          target_id?: string | null;
          metadata?: Json;
        };
        Returns: number;
      };
      set_user_role: {
        Args: { target: string; new_role: UserRole };
        Returns: undefined;
      };
      start_proctor_session: {
        // Phase 1.5: gains claimed_index_number + attested. attested must be
        // true or the RPC raises (identity attestation gate); a mismatch
        // between claimed_index_number and profiles.student_number logs a
        // high-severity identity_mismatch event but never blocks creation.
        // Phase 1.7: gains violation_policy — partial overrides merged over
        // default_violation_policy() and validated server-side, then
        // snapshotted onto proctor_sessions.violation_policy.
        Args: {
          context: string;
          tier?: number;
          claimed_index_number?: string | null;
          attested?: boolean;
          violation_policy?: Json | null;
        };
        Returns: string;
      };
      default_violation_policy: {
        // Phase 1.7: the server's defaults (event_type -> {severity, counts}).
        // Immutable/pure — used both as start_proctor_session's merge base
        // and by the policy editor UI to prefill its controls.
        Args: Record<string, never>;
        Returns: Json;
      };
      end_proctor_session: {
        Args: { session_id: string };
        Returns: undefined;
      };
      log_proctor_events: {
        Args: { session_id: string; events: Json };
        // Phase 1.5: returns the server's verdict on this batch so the
        // client learns about violation-limit auto-termination without a
        // second round-trip. See ProctorLogResult in @proctor/core.
        Returns: {
          accepted: boolean | number;
          session_status: string;
          violation_count: number;
          violation_limit: number;
        };
      };
      record_proctor_media: {
        Args: { session_id: string; storage_path: string; kind: string; captured_at: string };
        Returns: number;
      };
      attach_identity_portrait: {
        // One-shot, owner-only, own ACTIVE session, only while
        // identity_portrait_path is still null.
        Args: { session_id: string; storage_path: string };
        Returns: undefined;
      };
      start_forms_exam_session: {
        // Phase 2a: the forms-exam entry point. Deliberately has NO
        // tier/violation_policy parameter — those are loaded server-side
        // from the forms_exams row, never from the caller. Raises if the
        // exam is not found, not status='published', or now() is outside
        // [opens_at, closes_at].
        Args: {
          forms_exam_id: string;
          claimed_index_number?: string | null;
          attested?: boolean;
        };
        Returns: string;
      };
      forms_exam_sessions: {
        // Phase 2a lecturer results view: one row per proctoring session
        // started against this forms_exam. SELECT-guarded to the exam owner
        // or lecturer-or-higher.
        Args: { forms_exam_id: string };
        Returns: {
          session_id: string;
          user_id: string;
          full_name: string | null;
          claimed_index_number: string | null;
          status: string;
          violation_count: number;
          violation_limit: number;
          started_at: string;
          ended_at: string | null;
          has_report: boolean;
        }[];
      };
    };
    Enums: {
      user_role: UserRole;
    };
    CompositeTypes: Record<string, never>;
  };
}

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
export type ProctorSessionRow = Database["public"]["Tables"]["proctor_sessions"]["Row"];
export type ProctorEventRow = Database["public"]["Tables"]["proctor_events"]["Row"];
export type ProctorMediaRow = Database["public"]["Tables"]["proctor_media"]["Row"];
export type ProctorReportRow = Database["public"]["Tables"]["proctor_reports"]["Row"];
export type FormsExamRow = Database["public"]["Tables"]["forms_exams"]["Row"];
export type FormsExamSessionRow =
  Database["public"]["Functions"]["forms_exam_sessions"]["Returns"][number];
