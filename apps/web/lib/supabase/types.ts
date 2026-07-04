/**
 * Hand-written Database types mirroring supabase/migrations. Shaped like the
 * output of `supabase gen types typescript` so it can be replaced verbatim
 * once a live project exists (see README.md "Supabase setup"):
 *
 *   supabase gen types typescript --linked > apps/web/lib/supabase/types.ts
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type UserRole = "super_admin" | "admin" | "lecturer" | "student";

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
    };
    Enums: {
      user_role: UserRole;
    };
    CompositeTypes: Record<string, never>;
  };
}

export type Profile = Database["public"]["Tables"]["profiles"]["Row"];
