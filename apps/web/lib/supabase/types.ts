/**
 * Hand-written Database types mirroring supabase/migrations. Shaped like the
 * output of `supabase gen types typescript` so it can be replaced verbatim
 * once a live project exists (see README.md "Supabase setup"):
 *
 *   supabase gen types typescript --linked > apps/web/lib/supabase/types.ts
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type UserRole = "super_admin" | "admin" | "lecturer" | "student";

export type ProctorSessionStatus = "active" | "ended" | "abandoned";
export type ProctorSeverity = "info" | "low" | "medium" | "high";

export interface Database {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          role: UserRole;
          full_name: string | null;
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
        };
        // Writable only via start_proctor_session/end_proctor_session RPCs
        // (security definer) — no client INSERT/UPDATE policy exists.
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
        Args: { context: string; tier?: number };
        Returns: string;
      };
      end_proctor_session: {
        Args: { session_id: string };
        Returns: undefined;
      };
      log_proctor_events: {
        Args: { session_id: string; events: Json };
        Returns: undefined;
      };
      record_proctor_media: {
        Args: { session_id: string; storage_path: string; kind: string; captured_at: string };
        Returns: number;
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
