/**
 * Hand-written Database types mirroring supabase/migrations. Shaped like the
 * output of `supabase gen types typescript` so it can be replaced verbatim
 * once a live project exists (see README.md "Supabase setup"):
 *
 *   supabase gen types typescript --linked > apps/web/lib/supabase/types.ts
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type UserRole = "super_admin" | "admin" | "lecturer" | "student";

/** Phase 3b: questions.type — see supabase/migrations/20260705000010_question_banks.sql for the documented body jsonb shape per type. */
export type QuestionTypeDb = "mcq_single" | "mcq_multi" | "true_false" | "numeric" | "short_answer" | "essay";
export type QuestionDifficultyDb = "easy" | "medium" | "hard";
export type QuestionStatusDb = "active" | "retired";

export type ProctorSessionStatus = "active" | "ended" | "abandoned" | "terminated";
export type ProctorSeverity = "info" | "low" | "medium" | "high";
export type ProctorReportStatus = "pending_review" | "reviewed";
export type ProctorReportVerdict = "pass" | "escalate" | "violation";

/** Phase 2a: forms_exams.status. draft is never visible to students; published is the only state start_forms_exam_session accepts; closed stops new sessions. */
export type FormsExamStatus = "draft" | "published" | "closed";

/** Phase 2b: forms_submissions.match_status — see the migration comment on the column for the full classification rules. */
export type FormsSubmissionMatchStatus = "matched" | "no_session" | "out_of_window" | "no_email";

/** Phase 3c: exams.status. draft is never visible to students; published (+ in-window + enrolled) is what the student SELECT policy allows; closed stops new attempts (Phase 3d). */
export type ExamStatus = "draft" | "published" | "closed";
export type ExamResultsRelease = "immediate" | "after_close" | "manual";
export type ExamSectionSourceType = "fixed" | "pool";

/** Phase 3d-i: exam_attempts.status. in_progress -> submitted/auto_submitted at student submit; graded/terminated are reserved for Phase 3d-ii (manual essay grading / proctoring termination). */
export type ExamAttemptStatus = "in_progress" | "submitted" | "auto_submitted" | "graded" | "terminated";

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
          /** Phase 3a: true for accounts created with (or re-issued) a server-generated temp password. Gates /onboarding/set-password via requireRole. Only changeable via clear_must_change_password() or the service role — never a direct client PATCH, including by super_admin. */
          must_change_password: boolean;
          /** Phase 3a: optional contact number for the SMS onboarding adapter (lib/sms/). Light validation only. */
          phone: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          role?: UserRole;
          full_name?: string | null;
          student_number?: string | null;
          accommodations?: Json;
          must_change_password?: boolean;
          phone?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          role?: UserRole;
          full_name?: string | null;
          student_number?: string | null;
          accommodations?: Json;
          must_change_password?: boolean;
          phone?: string | null;
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
          /** Phase 2b: per-exam shared secret for the Apps Script webhook (x-forms-secret header). Null until rotate_forms_exam_secret() is called. Never render this outside the one-time "generated" display — re-fetching the row later shows it again (unlike a true one-way hash), so treat it as a live secret, not just a one-time reveal. */
          submission_secret: string | null;
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
          submission_secret?: string | null;
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
          submission_secret?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      forms_submissions: {
        Row: {
          id: string;
          forms_exam_id: string;
          respondent_email: string | null;
          submitted_at: string | null;
          received_at: string;
          matched_session_id: string | null;
          match_status: FormsSubmissionMatchStatus;
          raw: Json;
        };
        // Insert exists in the type (unlike proctor_events/proctor_reports,
        // which are RPC-only) because the ONE sanctioned writer — the
        // webhook route (apps/web/app/api/forms/submission/route.ts) — uses
        // the service-role client's plain `.insert()`, not an RPC. RLS still
        // has NO insert policy for authenticated/anon at all (see the
        // migration), so this type permissiveness does not open a new write
        // path for any browser-facing client: the service-role client
        // bypasses RLS by construction and is never imported into browser
        // code (see lib/supabase/admin.ts's guard).
        Insert: {
          id?: string;
          forms_exam_id: string;
          respondent_email?: string | null;
          submitted_at?: string | null;
          received_at?: string;
          matched_session_id?: string | null;
          match_status: FormsSubmissionMatchStatus;
          raw?: Json;
        };
        Update: never;
        Relationships: [];
      };
      classes: {
        Row: {
          id: string;
          owner_id: string;
          name: string;
          code: string | null;
          description: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          owner_id: string;
          name: string;
          code?: string | null;
          description?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          name?: string;
          code?: string | null;
          description?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      class_members: {
        Row: {
          id: string;
          class_id: string;
          student_id: string;
          created_at: string;
        };
        // Writable only via enroll_existing_student()/remove_class_member()
        // RPCs (security definer) — no client INSERT/UPDATE/DELETE policy.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      question_banks: {
        Row: {
          id: string;
          owner_id: string;
          name: string;
          description: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          owner_id: string;
          name: string;
          description?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Update: {
          id?: string;
          owner_id?: string;
          name?: string;
          description?: string | null;
          created_at?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      question_categories: {
        Row: {
          id: string;
          bank_id: string;
          parent_id: string | null;
          name: string;
          created_at: string;
        };
        // Writable only via create_question_category()/rename_question_category()/
        // delete_question_category() RPCs — no client INSERT/UPDATE/DELETE policy.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      questions: {
        Row: {
          id: string;
          bank_id: string;
          category_id: string | null;
          type: QuestionTypeDb;
          difficulty: QuestionDifficultyDb;
          tags: string[];
          status: QuestionStatusDb;
          current_version_id: string | null;
          created_by: string | null;
          created_at: string;
          updated_at: string;
        };
        // Writable only via create_question()/add_question_version()/
        // set_question_status() RPCs — no client INSERT/UPDATE/DELETE policy.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      question_versions: {
        Row: {
          id: string;
          question_id: string;
          version_no: number;
          prompt: string;
          /** Shape per parent question's type — see the migration's table comment for the documented per-type body shape. */
          body: Json;
          created_by: string | null;
          created_at: string;
        };
        // Writable only via create_question()/add_question_version() RPCs.
        // Rows are immutable once created (question_versions_no_update
        // trigger) — "editing" always inserts a new version.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      exams: {
        Row: {
          id: string;
          owner_id: string;
          class_id: string | null;
          title: string;
          description: string | null;
          status: ExamStatus;
          opens_at: string | null;
          closes_at: string | null;
          duration_minutes: number | null;
          integrity_tier: number;
          violation_policy: Json;
          shuffle_questions: boolean;
          shuffle_options: boolean;
          results_release: ExamResultsRelease;
          /** Phase 3d-ii: set by release_exam_results() for a results_release='manual' exam. Null = not yet released; irrelevant for 'immediate'/'after_close'. */
          results_released_at: string | null;
          created_at: string;
          updated_at: string;
        };
        // Writable only via create_exam()/update_exam()/set_exam_status()
        // RPCs (security definer) — no client INSERT/UPDATE policy exists;
        // DELETE has no client policy either (owner-or-lecturer can delete
        // via the RLS delete policy directly, mirroring classes/question_banks).
        Insert: never;
        Update: never;
        Relationships: [];
      };
      exam_sections: {
        Row: {
          id: string;
          exam_id: string;
          title: string;
          description: string | null;
          ordinal: number;
          created_at: string;
          updated_at: string;
        };
        // Writable only via add_exam_section()/reorder_exam_section()/
        // remove_exam_section() RPCs — no client INSERT/UPDATE/DELETE policy.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      exam_section_sources: {
        Row: {
          id: string;
          section_id: string;
          source_type: ExamSectionSourceType;
          ordinal: number;
          question_id: string | null;
          bank_id: string | null;
          category_id: string | null;
          difficulty: QuestionDifficultyDb | null;
          tags: string[] | null;
          draw_count: number | null;
          created_at: string;
        };
        // Writable only via add_section_source()/remove_section_source() RPCs.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      exam_attempts: {
        Row: {
          id: string;
          exam_id: string;
          student_id: string;
          status: ExamAttemptStatus;
          seed: string;
          started_at: string;
          /** Server-authoritative deadline = started_at + duration_minutes * accommodations extra_time_multiplier. Null exam duration -> far-future deadline (no time limit), never a null column. */
          deadline_at: string;
          submitted_at: string | null;
          auto_score: number | null;
          max_score: number | null;
          needs_manual_grading: boolean;
          /** Phase 3d-ii: the linked proctor_sessions row for integrity_tier >= 2 attempts (null for tier 1, which runs no camera/engine). Set once at start_exam_attempt time from the exam's own tier+policy — never client-supplied. */
          proctor_session_id: string | null;
          created_at: string;
        };
        // Writable only via start_exam_attempt()/submit_exam_attempt() RPCs
        // (security definer) — no client INSERT/UPDATE policy.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      exam_answers: {
        Row: {
          id: string;
          attempt_id: string;
          question_version_id: string;
          /** Per-attempt slot id "<section_id>:<index>" minted when the paper is frozen — see get_attempt_questions. */
          question_ref: string;
          response: Json | null;
          flagged: boolean;
          /** Phase 3d-ii: manual essay grade, set only via grade_essay_slot (owner/lecturer-only). Null for non-essay slots and ungraded essays. */
          marks_awarded: number | null;
          /** Phase 3d-ii: optional lecturer feedback for a manually-graded essay slot. */
          feedback: string | null;
          updated_at: string;
        };
        // Writable only via save_exam_answer() RPC (security definer).
        Insert: never;
        Update: never;
        Relationships: [];
      };
      // exam_attempt_papers is intentionally OMITTED from this Database type:
      // it has zero client-reachable RLS policies (not even for the owning
      // student) and is never read/written via the client library — only
      // through get_attempt_questions()/submit_exam_attempt() (which strip
      // or internally consume its content) or the service role. Omitting it
      // here means the generated client types don't even offer
      // `.from("exam_attempt_papers")` as an autocomplete suggestion.
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
      rotate_forms_exam_secret: {
        // Phase 2b: generates + stores a new random submission_secret for
        // a forms_exams row and returns it ONCE (like showing an API key at
        // creation time) — not retrievable again except by rotating again.
        // Owner-or-lecturer-or-higher only.
        Args: { forms_exam_id: string };
        Returns: string;
      };
      forms_exam_submissions: {
        // Phase 2b lecturer results view: one row per Apps Script
        // onFormSubmit webhook call recorded for this forms_exam.
        // SELECT-guarded to the exam owner or lecturer-or-higher.
        Args: { forms_exam_id: string };
        Returns: {
          submission_id: string;
          respondent_email: string | null;
          submitted_at: string | null;
          received_at: string;
          match_status: FormsSubmissionMatchStatus;
          matched_session_id: string | null;
        }[];
      };
      match_forms_submission: {
        // Phase 2b: INTERNAL cross-check, EXECUTE revoked from
        // anon/authenticated (service_role only, same lock-down pattern as
        // _create_proctor_session) — called only from the webhook route via
        // the admin (service-role) client. Classifies a hypothetical
        // submission against proctor_sessions without writing anything.
        Args: { forms_exam_id: string; respondent_email: string | null; submitted_at: string | null };
        Returns: {
          match_status: FormsSubmissionMatchStatus;
          matched_session_id: string | null;
        }[];
      };
      clear_must_change_password: {
        // Phase 3a: clears must_change_password on the CALLER's own profile
        // only (no id parameter). Called after a successful
        // supabase.auth.updateUser() in /onboarding/set-password.
        Args: Record<string, never>;
        Returns: undefined;
      };
      create_class: {
        // Phase 3a: lecturer-or-higher only (has_role('lecturer')). Returns
        // the new class id. Audit-logged.
        Args: { name: string; code?: string | null; description?: string | null };
        Returns: string;
      };
      enroll_existing_student: {
        // Phase 3a: owner-or-lecturer-or-higher only. Upserts a
        // class_members row; no-op if already enrolled. Rejects targets
        // whose profile role is not 'student'.
        Args: { class_id: string; student_id: string };
        Returns: undefined;
      };
      remove_class_member: {
        // Phase 3a: owner-or-lecturer-or-higher only. No-op if not enrolled.
        Args: { class_id: string; student_id: string };
        Returns: undefined;
      };
      class_roster: {
        // Phase 3a: owner-or-lecturer-or-higher roster view with student
        // full_name/student_number/phone, for the class dashboard, roster
        // export, and SMS send flow.
        Args: { class_id: string };
        Returns: {
          student_id: string;
          full_name: string | null;
          student_number: string | null;
          phone: string | null;
          enrolled_at: string;
        }[];
      };
      create_question_bank: {
        // Phase 3b: lecturer-or-higher only (has_role('lecturer')). Mirrors
        // create_class. Returns the new bank id. Audit-logged.
        Args: { name: string; description?: string | null };
        Returns: string;
      };
      can_manage_question_bank: {
        // Phase 3b: true when the caller is lecturer-or-higher OR owns the
        // given bank. Safe to call directly (re-derives authority from
        // auth.uid(), no lock-down needed) — shared by every RPC below.
        Args: { bank_id: string };
        Returns: boolean;
      };
      create_question: {
        // Phase 3b: owner-or-lecturer-or-higher (can_manage_question_bank).
        // Creates the question + its version 1 in one transaction and
        // returns the new question id. Validates type/difficulty against
        // the fixed vocabularies and does minimal per-type body shape
        // validation — see the migration's question_versions comment for
        // the documented body shape per type.
        Args: {
          bank_id: string;
          type: QuestionTypeDb;
          category_id?: string | null;
          difficulty?: QuestionDifficultyDb;
          tags?: string[];
          prompt?: string;
          body?: Json;
        };
        Returns: string;
      };
      add_question_version: {
        // Phase 3b: THIS is how "editing" a question works — inserts
        // version_no = max+1 and repoints questions.current_version_id.
        // Never mutates an existing version row. Same authority as
        // create_question. Returns the new version id.
        Args: { question_id: string; prompt: string; body: Json };
        Returns: string;
      };
      set_question_status: {
        // Phase 3b: retire/reactivate. Owner-or-lecturer-or-higher only.
        Args: { question_id: string; status: QuestionStatusDb };
        Returns: undefined;
      };
      create_question_category: {
        // Phase 3b: creates a category, optionally nested under parent_id
        // (must belong to the same bank). Owner-or-lecturer-or-higher only.
        Args: { bank_id: string; name: string; parent_id?: string | null };
        Returns: string;
      };
      rename_question_category: {
        Args: { category_id: string; name: string };
        Returns: undefined;
      };
      delete_question_category: {
        // Phase 3b: child categories cascade-delete; questions filed under
        // it become uncategorized (category_id set null), never deleted.
        Args: { category_id: string };
        Returns: undefined;
      };
      bank_questions: {
        // Phase 3b: owner-or-lecturer-or-higher question list for the
        // authoring UI — one row per question with its CURRENT version's
        // prompt/body inlined and category name resolved.
        Args: { bank_id: string };
        Returns: {
          question_id: string;
          type: QuestionTypeDb;
          difficulty: QuestionDifficultyDb;
          tags: string[];
          status: QuestionStatusDb;
          category_id: string | null;
          category_name: string | null;
          current_version_id: string | null;
          version_no: number | null;
          prompt: string | null;
          body: Json | null;
          created_at: string;
          updated_at: string;
        }[];
      };
      can_manage_exam: {
        // Phase 3c: true when the caller is lecturer-or-higher OR owns the
        // given exam. Safe to call directly (re-derives authority).
        Args: { exam_id: string };
        Returns: boolean;
      };
      pool_available_count: {
        // Phase 3c: count of ACTIVE questions in bank_id matching the
        // optional category/difficulty/tags filter. Used by validate_exam
        // and the builder's live "N matching available" indicator.
        Args: { bank_id: string; category_id?: string | null; difficulty?: string | null; tags?: string[] | null };
        Returns: number;
      };
      create_exam: {
        // Phase 3c: lecturer-or-higher only. Creates a draft exam and
        // returns its id. Audit-logged.
        Args: { title: string; description?: string | null; class_id?: string | null };
        Returns: string;
      };
      update_exam: {
        // Phase 3c: owner-or-lecturer-or-higher only. Validates + merges
        // violation_policy exactly like start_proctor_session. Does not
        // change status — see set_exam_status.
        Args: {
          exam_id: string;
          title: string;
          description?: string | null;
          class_id?: string | null;
          opens_at?: string | null;
          closes_at?: string | null;
          duration_minutes?: number | null;
          integrity_tier?: number;
          violation_policy?: Json | null;
          shuffle_questions?: boolean;
          shuffle_options?: boolean;
          results_release?: ExamResultsRelease;
        };
        Returns: undefined;
      };
      add_exam_section: {
        // Phase 3c: appends a section at the end (ordinal = max + 1).
        // Owner-or-lecturer-or-higher only.
        Args: { exam_id: string; title: string; description?: string | null };
        Returns: string;
      };
      reorder_exam_section: {
        // Phase 3c: swaps ordinal with the immediate up/down neighbor
        // (accessibility: up/down buttons, never drag-only). No-op at the
        // edge. Owner-or-lecturer-or-higher only.
        Args: { section_id: string; direction: "up" | "down" };
        Returns: undefined;
      };
      remove_exam_section: {
        // Phase 3c: deletes a section (cascades to its sources).
        Args: { section_id: string };
        Returns: undefined;
      };
      add_section_source: {
        // Phase 3c: adds a fixed or pool source to a section, appended at
        // the end. Fixed requires question_id; pool requires bank_id +
        // draw_count. Re-checks can_manage_question_bank on the referenced
        // bank in addition to can_manage_exam on the exam.
        Args: {
          section_id: string;
          source_type: ExamSectionSourceType;
          question_id?: string | null;
          bank_id?: string | null;
          category_id?: string | null;
          difficulty?: QuestionDifficultyDb | null;
          tags?: string[] | null;
          draw_count?: number | null;
        };
        Returns: string;
      };
      remove_section_source: {
        Args: { source_id: string };
        Returns: undefined;
      };
      validate_exam: {
        // Phase 3c: readiness check — every section has >=1 source, every
        // pool source has enough ACTIVE matching questions for its
        // draw_count, fixed sources still point at active questions, and a
        // class is assigned. set_exam_status(published) calls this and
        // refuses to publish when ok=false.
        Args: { exam_id: string };
        Returns: { ok: boolean; issues: string[] };
      };
      set_exam_status: {
        // Phase 3c: publishing calls validate_exam first and raises with
        // the issue list if not ok. Owner-or-lecturer-or-higher only.
        Args: { exam_id: string; status: ExamStatus };
        Returns: undefined;
      };
      draw_exam_for_attempt: {
        // Phase 3c: THE core per-attempt deterministic seeded draw. Same
        // (exam_id, seed) always returns the same result (md5(seed || ...)
        // ordering, never actual randomness). Freezes current_version_id at
        // call time. Returns FULL body INCLUDING correct answers — LOCKED
        // DOWN: EXECUTE revoked from public/anon/authenticated. Only the
        // service role (future Phase 3d attempt-creation code) and
        // preview_exam_draw may call it. A direct client call fails with
        // "permission denied for function" (42501), not a business-logic
        // error — that IS the security boundary.
        Args: { exam_id: string; seed: string };
        Returns: {
          exam_id: string;
          seed: string;
          sections: {
            section_id: string;
            title: string;
            description: string | null;
            questions: {
              question_id: string;
              version_id: string;
              type: QuestionTypeDb;
              prompt: string;
              body: Json;
            }[];
          }[];
        };
      };
      preview_exam_draw: {
        // Phase 3c: owner-or-lecturer-or-higher-only preview of a sample
        // drawn paper (fresh throwaway seed each call). Answers ARE
        // included — acceptable because the caller already has authoring
        // access to every question here. Never exposed to students.
        Args: { exam_id: string };
        Returns: Database["public"]["Functions"]["draw_exam_for_attempt"]["Returns"];
      };
      start_exam_attempt: {
        // Phase 3d-i: validates attested=true (identity gate), exam
        // published + in-window, and class_members enrollment. Resumes an
        // existing in_progress attempt if one exists (idempotent); otherwise
        // enforces one-attempt-per-exam, calls the locked-down
        // draw_exam_for_attempt, and stores the frozen paper in
        // exam_attempt_papers (never in exam_attempts itself). Returns the
        // attempt id.
        Args: { exam_id: string; claimed_index_number?: string | null; attested?: boolean };
        Returns: string;
      };
      get_attempt_questions: {
        // Phase 3d-i: THE sanitized delivery RPC. Owner-only. Strips every
        // answer-bearing body field (correct/accepted/case_sensitive/
        // tolerance/rubric) server-side before returning, and rebuilds
        // options as bare {id,text}. Also returns saved responses/flags
        // (exam_answers) + deadline_at + server `now()` so the client can
        // render resume state and a server-authoritative countdown.
        Args: { attempt_id: string };
        Returns: {
          attempt_id: string;
          status: ExamAttemptStatus;
          started_at: string;
          deadline_at: string;
          server_now: string;
          sections: {
            section_id: string;
            title: string;
            description: string | null;
            questions: {
              question_ref: string;
              question_id: string;
              version_id: string;
              type: QuestionTypeDb;
              prompt: string;
              /** Answer fields already stripped — see the migration comment on get_attempt_questions. */
              body: Json;
            }[];
          }[];
          answers: { question_ref: string; response: Json | null; flagged: boolean }[];
          /** Phase 3d-ii: the parent exam's integrity_tier (1..4) — drives whether the client attaches the proctoring engine at all. */
          integrity_tier: number;
          /** Phase 3d-ii: the linked proctor session id for tier>=2 attempts (null for tier 1), so a resumed/refreshed exam room reattaches to the SAME session rather than starting a new one. */
          proctor_session_id: string | null;
        };
      };
      save_exam_answer: {
        // Phase 3d-i: autosave. Owner-only, attempt must be in_progress, and
        // REJECTED once now() > deadline_at regardless of client-claimed
        // state (server-authoritative). Upserts on (attempt_id, question_ref).
        Args: { attempt_id: string; question_ref: string; response?: Json | null; flagged?: boolean };
        Returns: undefined;
      };
      submit_exam_attempt: {
        // Phase 3d-i: owner-only. Auto-grades every non-essay slot against
        // the frozen paper; essay slots set needs_manual_grading=true and
        // score 0 (graded in Phase 3d-ii). Records status='submitted' or
        // 'auto_submitted' (when called past deadline_at). Per-question
        // correctness is returned ONLY when exams.results_release='immediate'
        // — otherwise per_question is null and only totals/ack are returned.
        Args: { attempt_id: string };
        Returns: {
          attempt_id: string;
          status: ExamAttemptStatus;
          auto_score: number;
          max_score: number;
          needs_manual_grading: boolean;
          results_released: boolean;
          per_question: { question_ref: string; score?: number; max?: number; needs_manual_grading?: boolean }[] | null;
        };
      };
      grade_essay_slot: {
        // Phase 3d-ii: owner/lecturer-or-higher only. Re-derives the slot's
        // max marks from the frozen paper (never trusts a client-supplied
        // max) and clamps marks_awarded to [0, slot marks]. Auto-finalizes
        // the attempt once every essay slot has a grade.
        Args: { attempt_id: string; question_ref: string; marks_awarded: number; feedback?: string | null };
        Returns: undefined;
      };
      finalize_attempt_grade: {
        // Phase 3d-ii: recomputes auto_score = objective auto_score + sum of
        // graded essay marks_awarded, sets status='graded'. Owner/lecturer-
        // or-higher only. Idempotent.
        Args: { attempt_id: string };
        Returns: undefined;
      };
      release_exam_results: {
        // Phase 3d-ii: for a results_release='manual' exam only, stamps
        // exams.results_released_at = now(). Owner/lecturer-or-higher only.
        Args: { exam_id: string };
        Returns: undefined;
      };
      get_attempt_result: {
        // Phase 3d-ii: THE single answer-revealing student-facing RPC.
        // Owner-only (the attempt's own student). Returns {released:false,
        // reason} until the exam's results_release condition is met;
        // afterward returns the total plus a per-question breakdown
        // (response, correct/accepted answer, score/max for objective
        // types; marks_awarded/feedback/needs_manual_grading for essays).
        Args: { attempt_id: string };
        Returns: {
          released: boolean;
          reason?: "not_submitted" | "not_yet_released";
          results_release?: ExamResultsRelease;
          status?: ExamAttemptStatus;
          auto_score?: number | null;
          max_score?: number | null;
          needs_manual_grading?: boolean;
          per_question?: {
            question_ref: string;
            prompt: string;
            type: QuestionTypeDb;
            response: Json | null;
            correct?: Json;
            /** Bare {id,text} pairs for mcq_single/mcq_multi/true_false, so the client can render option text instead of a raw id. Null for types without options. */
            options?: { id: string; text: string }[] | null;
            score?: number;
            max: number;
            marks_awarded?: number | null;
            feedback?: string | null;
            needs_manual_grading?: boolean;
          }[];
        };
      };
      get_attempt_for_grading: {
        // Phase 3d-ii lecturer-facing grading detail. Owner/lecturer-or-
        // higher only, NOT release-gated (a lecturer grades before
        // release). Every slot's prompt + student response, plus rubric/
        // marks_awarded/feedback for essays and auto-score/max for
        // objective types.
        Args: { attempt_id: string };
        Returns: {
          attempt_id: string;
          status: ExamAttemptStatus;
          per_question: {
            question_ref: string;
            prompt: string;
            type: QuestionTypeDb;
            response: Json | null;
            rubric?: Json;
            marks_awarded?: number | null;
            feedback?: string | null;
            score?: number;
            max: number;
          }[];
        };
      };
      exam_results: {
        // Phase 3d-ii lecturer results view: one row per attempt with
        // grading state + (for tier>=2 attempts) the linked proctor
        // session's integrity summary. Owner/lecturer-or-higher only.
        Args: { exam_id: string };
        Returns: {
          attempt_id: string;
          student_id: string;
          full_name: string | null;
          student_number: string | null;
          status: ExamAttemptStatus;
          auto_score: number | null;
          max_score: number | null;
          needs_manual_grading: boolean;
          started_at: string;
          submitted_at: string | null;
          proctor_session_id: string | null;
          violation_count: number | null;
          violation_limit: number | null;
          session_status: string | null;
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
export type FormsSubmissionRow = Database["public"]["Tables"]["forms_submissions"]["Row"];
export type FormsExamSubmissionRow =
  Database["public"]["Functions"]["forms_exam_submissions"]["Returns"][number];
export type ClassRow = Database["public"]["Tables"]["classes"]["Row"];
export type ClassMemberRow = Database["public"]["Tables"]["class_members"]["Row"];
export type ClassRosterRow = Database["public"]["Functions"]["class_roster"]["Returns"][number];
export type QuestionBankRow = Database["public"]["Tables"]["question_banks"]["Row"];
export type QuestionCategoryRow = Database["public"]["Tables"]["question_categories"]["Row"];
export type QuestionRow = Database["public"]["Tables"]["questions"]["Row"];
export type QuestionVersionRow = Database["public"]["Tables"]["question_versions"]["Row"];
export type BankQuestionRow = Database["public"]["Functions"]["bank_questions"]["Returns"][number];
export type ExamRow = Database["public"]["Tables"]["exams"]["Row"];
export type ExamSectionRow = Database["public"]["Tables"]["exam_sections"]["Row"];
export type ExamSectionSourceRow = Database["public"]["Tables"]["exam_section_sources"]["Row"];
export type ExamValidationResult = Database["public"]["Functions"]["validate_exam"]["Returns"];
export type ExamDraw = Database["public"]["Functions"]["draw_exam_for_attempt"]["Returns"];
export type ExamAttemptRow = Database["public"]["Tables"]["exam_attempts"]["Row"];
export type ExamAnswerRow = Database["public"]["Tables"]["exam_answers"]["Row"];
export type AttemptQuestions = Database["public"]["Functions"]["get_attempt_questions"]["Returns"];
export type AttemptSection = AttemptQuestions["sections"][number];
export type AttemptQuestion = AttemptSection["questions"][number];
export type SubmitAttemptResult = Database["public"]["Functions"]["submit_exam_attempt"]["Returns"];
export type AttemptResult = Database["public"]["Functions"]["get_attempt_result"]["Returns"];
export type AttemptResultQuestion = NonNullable<AttemptResult["per_question"]>[number];
export type ExamResultRow = Database["public"]["Functions"]["exam_results"]["Returns"][number];
export type AttemptGradingDetail = Database["public"]["Functions"]["get_attempt_for_grading"]["Returns"];
export type AttemptGradingQuestion = AttemptGradingDetail["per_question"][number];
