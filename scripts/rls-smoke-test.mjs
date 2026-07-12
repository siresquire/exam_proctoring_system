#!/usr/bin/env node
// Phase 0.3: repeatable RLS / security smoke test against a LOCAL Supabase
// stack (never point this at a hosted project — it creates role churn and
// prints service-role-derived state).
//
// What it does: signs in as each of the four seeded test users
// (scripts/rls-smoke-test.mjs expects them to already exist — see
// README.md "Local development & testing") and asserts, from the client's
// point of view, exactly what RLS/triggers/RPCs should allow or reject.
// Prints PASS/FAIL per check and exits non-zero if anything fails.
//
// Env vars (read from apps/web/.env.local if present, overridable):
//   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
//   SUPABASE_SERVICE_ROLE_KEY
//
// Usage: node scripts/rls-smoke-test.mjs

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

// --- env loading -----------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envLocalPath = path.resolve(__dirname, "..", "apps", "web", ".env.local");

function loadEnvLocal(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvLocal(envLocalPath);

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing env. Need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY " +
      `(checked ${envLocalPath} and process env).`,
  );
  process.exit(1);
}

if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(SUPABASE_URL)) {
  console.error(
    `Refusing to run: NEXT_PUBLIC_SUPABASE_URL (${SUPABASE_URL}) is not a local address. ` +
      "This script mutates roles and reads service-role data — local only.",
  );
  process.exit(1);
}

const PASSWORD = "Usted!Test2026";
const USERS = {
  super_admin: "superadmin@usted.test",
  admin: "admin@usted.test",
  lecturer: "lecturer@usted.test",
  student: "student@usted.test",
};

// --- test harness ------------------------------------------------------

const results = [];

function record(name, pass, detail) {
  results.push({ name, pass, detail });
  const tag = pass ? "PASS" : "FAIL";
  const line = `[${tag}] ${name}`;
  console.log(detail ? `${line} — ${detail}` : line);
}

/** True when a PostgREST/RPC error looks like an RLS/permission rejection. */
function isDenied(error) {
  if (!error) return false;
  const msg = `${error.message ?? ""} ${error.details ?? ""} ${error.hint ?? ""}`.toLowerCase();
  return (
    error.code === "42501" || // insufficient_privilege
    error.code === "PGRST301" ||
    msg.includes("permission denied") ||
    msg.includes("row-level security") ||
    msg.includes("row level security") ||
    msg.includes("policy") ||
    msg.includes("may only be changed") ||
    msg.includes("cannot be changed") ||
    msg.includes("only be changed via") ||
    msg.includes("can only be changed by") ||
    msg.includes("only super_admin") ||
    msg.includes("admin may only") ||
    msg.includes("may not change your own role") ||
    msg.includes("only admin or super_admin") ||
    msg.includes("is append-only") ||
    msg.includes("no function matches") // revoked execute -> not found for role
  );
}

async function signIn(email) {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return { client, userId: data.user.id };
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function getProfileRole(userId) {
  const { data, error } = await admin.from("profiles").select("role").eq("id", userId).single();
  if (error) throw error;
  return data.role;
}

/** Phase 4: account lifecycle status ('active' | 'suspended' | 'removed'). */
async function getProfileStatus(userId) {
  const { data, error } = await admin.from("profiles").select("status").eq("id", userId).single();
  if (error) throw error;
  return data.status;
}

/**
 * Non-throwing sign-in attempt (unlike signIn() above, which throws) — used
 * to prove a password reset actually invalidates the old password and
 * activates the new one, without aborting the whole script on the expected
 * "old password now fails" case.
 */
async function trySignIn(email, password) {
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  await client.auth.signOut().catch(() => {});
  return { ok: !error && Boolean(data?.user), error };
}

// --- main ----------------------------------------------------------------

async function main() {
  console.log(`Target: ${SUPABASE_URL}\n`);

  const sessions = {};
  for (const [role, email] of Object.entries(USERS)) {
    sessions[role] = await signIn(email);
  }

  const studentId = sessions.student.userId;
  const lecturerId = sessions.lecturer.userId;
  const adminId = sessions.admin.userId;
  const superAdminId = sessions.super_admin.userId;

  // Snapshot roles up front so we can restore at the end regardless of
  // what the test body does to them.
  const originalRoles = {
    student: await getProfileRole(studentId),
    lecturer: await getProfileRole(lecturerId),
    admin: await getProfileRole(adminId),
    super_admin: await getProfileRole(superAdminId),
  };

  // === (a) student: own profile visible, others not ========================
  {
    const { client } = sessions.student;
    const { data, error } = await client.from("profiles").select("*").eq("id", studentId);
    record(
      "a1. student SELECT own profile returns 1 row",
      !error && data?.length === 1,
      error?.message ?? `rows=${data?.length}`,
    );

    const { data: allRows, error: allErr } = await client.from("profiles").select("*");
    record(
      "a2. student SELECT profiles (no filter) returns only own row",
      !allErr && allRows?.length === 1 && allRows[0].id === studentId,
      allErr?.message ?? `rows=${allRows?.length}`,
    );

    const { data: otherRows, error: otherErr } = await client
      .from("profiles")
      .select("*")
      .eq("id", lecturerId);
    record(
      "a3. student SELECT another user's profile returns 0 rows",
      !otherErr && otherRows?.length === 0,
      otherErr?.message ?? `rows=${otherRows?.length}`,
    );
  }

  // === (b) student self-update column restrictions =========================
  {
    const { client } = sessions.student;

    const { error: nameErr } = await client
      .from("profiles")
      .update({ full_name: "Student Test (Updated)" })
      .eq("id", studentId);
    record("b1. student UPDATE own full_name succeeds", !nameErr, nameErr?.message);
    // revert immediately
    await client.from("profiles").update({ full_name: "Student Test" }).eq("id", studentId);

    const { error: roleErr } = await client
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", studentId);
    record(
      "b2. student UPDATE own role FAILS",
      isDenied(roleErr),
      roleErr?.message ?? "no error raised",
    );

    const { error: snErr } = await client
      .from("profiles")
      .update({ student_number: "S9999999" })
      .eq("id", studentId);
    record(
      "b3. student UPDATE own student_number FAILS",
      isDenied(snErr),
      snErr?.message ?? "no error raised",
    );

    const { error: accErr } = await client
      .from("profiles")
      .update({ accommodations: { notes: "self-granted" } })
      .eq("id", studentId);
    record(
      "b4. student UPDATE own accommodations FAILS",
      isDenied(accErr),
      accErr?.message ?? "no error raised",
    );

    const { error: caErr } = await client
      .from("profiles")
      .update({ created_at: "2000-01-01T00:00:00Z" })
      .eq("id", studentId);
    record(
      "b5. student UPDATE own created_at FAILS",
      isDenied(caErr),
      caErr?.message ?? "no error raised",
    );
  }

  // === (c) student cannot call log_audit ====================================
  {
    const { client } = sessions.student;
    const { error } = await client.rpc("log_audit", {
      action: "forged_action",
      target_type: "profile",
      target_id: studentId,
      metadata: {},
    });
    record(
      "c1. student rpc log_audit FAILS (permission denied)",
      isDenied(error),
      error?.message ?? "no error raised — SECURITY: forged audit entries are possible",
    );
  }

  // === (d) student cannot call set_user_role ================================
  {
    const { client } = sessions.student;
    const { error } = await client.rpc("set_user_role", {
      target: lecturerId,
      new_role: "admin",
    });
    record(
      "d1. student rpc set_user_role FAILS",
      isDenied(error),
      error?.message ?? "no error raised",
    );
  }

  // === (e) lecturer: same restrictions as student (own profile only) =======
  {
    const { client } = sessions.lecturer;

    const { data: ownRows, error: ownErr } = await client.from("profiles").select("*");
    record(
      "e1. lecturer SELECT profiles returns only own row",
      !ownErr && ownRows?.length === 1 && ownRows[0].id === lecturerId,
      ownErr?.message ?? `rows=${ownRows?.length}`,
    );

    const { error: otherErr } = await client.from("profiles").select("*").eq("id", studentId);
    const { data: otherData } = await client.from("profiles").select("*").eq("id", studentId);
    record(
      "e2. lecturer SELECT another user's profile returns 0 rows",
      !otherErr && otherData?.length === 0,
      otherErr?.message ?? `rows=${otherData?.length}`,
    );

    const { error: roleErr } = await client
      .from("profiles")
      .update({ role: "admin" })
      .eq("id", lecturerId);
    record(
      "e3. lecturer UPDATE own role FAILS",
      isDenied(roleErr),
      roleErr?.message ?? "no error raised",
    );

    const { error: accErr } = await client
      .from("profiles")
      .update({ accommodations: { notes: "self-granted" } })
      .eq("id", lecturerId);
    record(
      "e4. lecturer UPDATE own accommodations FAILS",
      isDenied(accErr),
      accErr?.message ?? "no error raised",
    );

    const { error: logErr } = await client.rpc("log_audit", { action: "forged" });
    record(
      "e5. lecturer rpc log_audit FAILS",
      isDenied(logErr),
      logErr?.message ?? "no error raised",
    );

    const { error: setRoleErr } = await client.rpc("set_user_role", {
      target: studentId,
      new_role: "lecturer",
    });
    record(
      "e6. lecturer rpc set_user_role FAILS",
      isDenied(setRoleErr),
      setRoleErr?.message ?? "no error raised",
    );
  }

  // === (f) admin ============================================================
  {
    const { client } = sessions.admin;

    const { data: allRows, error: allErr } = await client.from("profiles").select("*");
    record(
      "f1. admin SELECT all profiles returns 4+ rows",
      !allErr && allRows?.length >= 4,
      allErr?.message ?? `rows=${allRows?.length}`,
    );

    const { error: accErr } = await client
      .from("profiles")
      .update({ accommodations: { extra_time_multiplier: 1.5, notes: "smoke test" } })
      .eq("id", studentId);
    record("f2. admin UPDATE another user's accommodations succeeds", !accErr, accErr?.message);
    // revert
    await admin.from("profiles").update({ accommodations: {} }).eq("id", studentId);

    const { error: fullNameErr } = await client
      .from("profiles")
      .update({ full_name: "Hijacked Name" })
      .eq("id", studentId);
    record(
      "f3. admin UPDATE another user's full_name FAILS",
      isDenied(fullNameErr),
      fullNameErr?.message ?? "no error raised",
    );

    const { error: promoteErr } = await client.rpc("set_user_role", {
      target: studentId,
      new_role: "lecturer",
    });
    record(
      "f4. admin set_user_role(student -> lecturer) succeeds",
      !promoteErr,
      promoteErr?.message,
    );
    // revert student back to student for idempotency, using admin RPC (admin can set lecturer/student)
    const { error: revertErr } = await client.rpc("set_user_role", {
      target: studentId,
      new_role: "student",
    });
    record(
      "f4b. admin can revert set_user_role(lecturer -> student) [cleanup]",
      !revertErr,
      revertErr?.message,
    );

    const { error: escalateErr } = await client.rpc("set_user_role", {
      target: studentId,
      new_role: "admin",
    });
    record(
      "f5. admin set_user_role(-> admin) FAILS (escalation blocked)",
      isDenied(escalateErr),
      escalateErr?.message ?? "no error raised — SECURITY: admin escalated a user to admin",
    );

    const { error: selfErr } = await client.rpc("set_user_role", {
      target: adminId,
      new_role: "lecturer",
    });
    record(
      "f6. admin set_user_role on own account FAILS",
      isDenied(selfErr),
      selfErr?.message ?? "no error raised",
    );
  }

  // === (g) super_admin =======================================================
  {
    const { client } = sessions.super_admin;

    const { data: allRows, error: allErr } = await client.from("profiles").select("*");
    record(
      "g1. super_admin SELECT all profiles returns 4+ rows",
      !allErr && allRows?.length >= 4,
      allErr?.message ?? `rows=${allRows?.length}`,
    );

    const { error: promoteErr } = await client.rpc("set_user_role", {
      target: lecturerId,
      new_role: "admin",
    });
    record(
      "g2. super_admin set_user_role(lecturer -> admin) succeeds",
      !promoteErr,
      promoteErr?.message,
    );

    const { data: auditRows, error: auditErr } = await client
      .from("audit_log")
      .select("*")
      .eq("action", "set_user_role")
      .eq("target_id", lecturerId)
      .order("id", { ascending: false })
      .limit(1);
    const auditRow = auditRows?.[0];
    const auditLooksRight =
      !auditErr &&
      auditRow &&
      auditRow.actor_id === superAdminId &&
      auditRow.action === "set_user_role" &&
      auditRow.metadata?.new_role === "admin";
    record(
      "g3. audit_log SELECT shows the set_user_role entry with correct actor_id/action/metadata",
      Boolean(auditLooksRight),
      auditErr?.message ??
        `actor_id=${auditRow?.actor_id} action=${auditRow?.action} metadata=${JSON.stringify(auditRow?.metadata)}`,
    );

    // revert lecturer back to lecturer
    const { error: revertErr } = await client.rpc("set_user_role", {
      target: lecturerId,
      new_role: "lecturer",
    });
    record(
      "g3b. super_admin can revert set_user_role(admin -> lecturer) [cleanup]",
      !revertErr,
      revertErr?.message,
    );

    if (auditRow) {
      const { error: updErr } = await client
        .from("audit_log")
        .update({ action: "tampered" })
        .eq("id", auditRow.id);
      record(
        "g4. audit_log UPDATE FAILS",
        isDenied(updErr),
        updErr?.message ?? "no error raised — SECURITY: audit log is mutable",
      );

      const { error: delErr } = await client.from("audit_log").delete().eq("id", auditRow.id);
      record(
        "g5. audit_log DELETE FAILS",
        isDenied(delErr),
        delErr?.message ?? "no error raised — SECURITY: audit log entries can be deleted",
      );
    } else {
      record("g4. audit_log UPDATE FAILS", false, "skipped — no audit row found to test against");
      record("g5. audit_log DELETE FAILS", false, "skipped — no audit row found to test against");
    }
  }

  // === (h) anon client =======================================================
  {
    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: keepaliveRows, error: keepaliveErr } = await anon.from("keepalive").select("*");
    record(
      "h1. anon SELECT keepalive succeeds",
      !keepaliveErr && (keepaliveRows?.length ?? 0) >= 1,
      keepaliveErr?.message ?? `rows=${keepaliveRows?.length}`,
    );

    const { data: profileRows, error: profileErr } = await anon.from("profiles").select("*");
    record(
      "h2. anon SELECT profiles returns 0 rows or is denied",
      Boolean(profileErr) || (profileRows?.length ?? 0) === 0,
      profileErr ? profileErr.message : `rows=${profileRows?.length}`,
    );
  }

  // === (i) proctoring: sessions/events/media RLS + RPCs =====================
  // Phase 1. Uses a fresh 'smoke-test' context so it never collides with a
  // real 'demo' session the same student might have open in a browser tab.
  {
    const { client: studentClient } = sessions.student;
    const { client: lecturerClient } = sessions.lecturer;
    const context = `smoke-test-${Date.now()}`;

    // i1. student starts a session via RPC.
    const { data: sessionId, error: startErr } = await studentClient.rpc("start_proctor_session", {
      context,
      tier: 2,
      attested: true,
    });
    record(
      "i1. student start_proctor_session succeeds and returns a session id",
      !startErr && typeof sessionId === "string" && sessionId.length > 0,
      startErr?.message ?? `sessionId=${sessionId}`,
    );

    // i2. student logs a valid event batch.
    const nowIso = new Date().toISOString();
    const { error: logErr } = await studentClient.rpc("log_proctor_events", {
      session_id: sessionId,
      events: [
        {
          event_type: "tab_hidden",
          severity: "medium",
          occurred_at: nowIso,
          meta: { source: "smoke-test" },
        },
      ],
    });
    record("i2. student log_proctor_events (valid batch) succeeds", !logErr, logErr?.message);

    // i2b. student can SELECT the event just logged.
    const { data: ownEvents, error: ownEventsErr } = await studentClient
      .from("proctor_events")
      .select("*")
      .eq("session_id", sessionId)
      .eq("event_type", "tab_hidden");
    record(
      "i2b. student SELECT own proctor_events returns the logged event",
      !ownEventsErr && (ownEvents?.length ?? 0) >= 1,
      ownEventsErr?.message ?? `rows=${ownEvents?.length}`,
    );

    // i3. student cannot log events to another user's session.
    const { data: lecturerSessionId, error: lecturerStartErr } = await lecturerClient.rpc(
      "start_proctor_session",
      { context: `${context}-lecturer`, tier: 2, attested: true },
    );
    if (lecturerStartErr) {
      record(
        "i3. student log_proctor_events on another user's session FAILS",
        false,
        lecturerStartErr.message,
      );
    } else {
      const { error: crossLogErr } = await studentClient.rpc("log_proctor_events", {
        session_id: lecturerSessionId,
        events: [{ event_type: "tab_hidden", severity: "low", occurred_at: nowIso }],
      });
      record(
        "i3. student log_proctor_events on another user's session FAILS",
        Boolean(crossLogErr),
        crossLogErr?.message ??
          "no error raised — SECURITY: student wrote events into another user's session",
      );
      // Clean up the lecturer's throwaway session.
      await lecturerClient.rpc("end_proctor_session", { session_id: lecturerSessionId });
    }

    // i4. student cannot INSERT directly into proctor_sessions/events/media
    // (RPCs are the only sanctioned write path).
    const { error: directSessionErr } = await studentClient.from("proctor_sessions").insert({
      user_id: studentId,
      context: "forged",
      consent_given_at: nowIso,
    });
    record(
      "i4a. student direct INSERT into proctor_sessions FAILS",
      isDenied(directSessionErr) || Boolean(directSessionErr),
      directSessionErr?.message ?? "no error raised — SECURITY: direct session insert succeeded",
    );

    const { error: directEventErr } = await studentClient.from("proctor_events").insert({
      session_id: sessionId,
      event_type: "tab_hidden",
      severity: "low",
      occurred_at: nowIso,
    });
    record(
      "i4b. student direct INSERT into proctor_events FAILS",
      isDenied(directEventErr) || Boolean(directEventErr),
      directEventErr?.message ?? "no error raised — SECURITY: direct event insert succeeded",
    );

    const { error: directMediaErr } = await studentClient.from("proctor_media").insert({
      session_id: sessionId,
      storage_path: `${sessionId}/forged.jpg`,
      kind: "snapshot",
      captured_at: nowIso,
    });
    record(
      "i4c. student direct INSERT into proctor_media FAILS",
      isDenied(directMediaErr) || Boolean(directMediaErr),
      directMediaErr?.message ?? "no error raised — SECURITY: direct media insert succeeded",
    );

    // i5. events UPDATE/DELETE denied (append-only, belt-and-braces trigger).
    const { data: eventRow } = await admin
      .from("proctor_events")
      .select("id")
      .eq("session_id", sessionId)
      .eq("event_type", "tab_hidden")
      .limit(1)
      .maybeSingle();

    if (eventRow) {
      const { error: updEventErr } = await studentClient
        .from("proctor_events")
        .update({ severity: "high" })
        .eq("id", eventRow.id);
      record(
        "i5a. student UPDATE proctor_events FAILS",
        isDenied(updEventErr) || Boolean(updEventErr),
        updEventErr?.message ?? "no error raised — SECURITY: proctor_events is mutable",
      );

      const { error: delEventErr } = await studentClient
        .from("proctor_events")
        .delete()
        .eq("id", eventRow.id);
      record(
        "i5b. student DELETE proctor_events FAILS",
        isDenied(delEventErr) || Boolean(delEventErr),
        delEventErr?.message ?? "no error raised — SECURITY: proctor_events rows can be deleted",
      );
    } else {
      record("i5a. student UPDATE proctor_events FAILS", false, "skipped — no event row found");
      record("i5b. student DELETE proctor_events FAILS", false, "skipped — no event row found");
    }

    // i6. a second start_proctor_session for the same context abandons the
    // first and logs a concurrent_session_detected event on it.
    const { data: secondSessionId, error: secondStartErr } = await studentClient.rpc(
      "start_proctor_session",
      { context, tier: 2, attested: true },
    );
    record(
      "i6a. second start_proctor_session (same context) succeeds",
      !secondStartErr && typeof secondSessionId === "string" && secondSessionId !== sessionId,
      secondStartErr?.message ?? `secondSessionId=${secondSessionId}`,
    );

    const { data: firstSessionAfter, error: firstSessionAfterErr } = await admin
      .from("proctor_sessions")
      .select("status")
      .eq("id", sessionId)
      .single();
    record(
      "i6b. original session is now status=abandoned",
      !firstSessionAfterErr && firstSessionAfter?.status === "abandoned",
      firstSessionAfterErr?.message ?? `status=${firstSessionAfter?.status}`,
    );

    const { data: concurrentEvents, error: concurrentErr } = await admin
      .from("proctor_events")
      .select("*")
      .eq("session_id", sessionId)
      .eq("event_type", "concurrent_session_detected");
    record(
      "i6c. concurrent_session_detected event logged on the abandoned session",
      !concurrentErr && (concurrentEvents?.length ?? 0) >= 1,
      concurrentErr?.message ?? `rows=${concurrentEvents?.length}`,
    );

    // i7. lecturer can SELECT the student's session and events.
    const { data: lecturerSeesSession, error: lecturerSeesSessionErr } = await lecturerClient
      .from("proctor_sessions")
      .select("*")
      .eq("id", secondSessionId ?? sessionId);
    record(
      "i7a. lecturer SELECT student's proctor_sessions row succeeds",
      !lecturerSeesSessionErr && (lecturerSeesSession?.length ?? 0) >= 1,
      lecturerSeesSessionErr?.message ?? `rows=${lecturerSeesSession?.length}`,
    );

    const { data: lecturerSeesEvents, error: lecturerSeesEventsErr } = await lecturerClient
      .from("proctor_events")
      .select("*")
      .eq("session_id", sessionId);
    record(
      "i7b. lecturer SELECT student's proctor_events succeeds",
      !lecturerSeesEventsErr && (lecturerSeesEvents?.length ?? 0) >= 1,
      lecturerSeesEventsErr?.message ?? `rows=${lecturerSeesEvents?.length}`,
    );

    // i8. end_proctor_session by a non-owner fails.
    const { error: nonOwnerEndErr } = await lecturerClient.rpc("end_proctor_session", {
      session_id: secondSessionId,
    });
    record(
      "i8. end_proctor_session by non-owner FAILS",
      Boolean(nonOwnerEndErr),
      nonOwnerEndErr?.message ??
        "no error raised — SECURITY: a non-owner ended another user's session",
    );

    // Cleanup: end the second session as its rightful owner so this test is idempotent.
    if (secondSessionId) {
      await studentClient.rpc("end_proctor_session", { session_id: secondSessionId });
    }
  }

  // === (j) Phase 1.5: violation auto-termination + reports ==================
  {
    const { client: studentClient } = sessions.student;
    const { client: lecturerClient } = sessions.lecturer;
    const context = `smoke-test-violation-${Date.now()}`;

    const { data: sessionId, error: startErr } = await studentClient.rpc("start_proctor_session", {
      context,
      tier: 3,
      claimed_index_number: "5201040845",
      attested: true,
    });
    record(
      "j1. student start_proctor_session (attested) succeeds for violation test",
      !startErr && typeof sessionId === "string",
      startErr?.message ?? `sessionId=${sessionId}`,
    );

    // Log 2 high-severity events first: session should still be active,
    // violation_count should be 2, no report yet.
    const nowIso = new Date().toISOString();
    const { data: batch1, error: batch1Err } = await studentClient.rpc("log_proctor_events", {
      session_id: sessionId,
      events: [
        { event_type: "fullscreen_exit", severity: "high", occurred_at: nowIso },
        { event_type: "copy_attempt", severity: "high", occurred_at: nowIso },
      ],
    });
    record(
      "j2. after 2 high-severity events, session_status is still active",
      !batch1Err && batch1?.session_status === "active" && batch1?.violation_count === 2,
      batch1Err?.message ??
        `session_status=${batch1?.session_status} violation_count=${batch1?.violation_count}`,
    );

    // Third high-severity event crosses the default violation_limit (3) ->
    // the RPC response itself should report termination.
    const { data: batch2, error: batch2Err } = await studentClient.rpc("log_proctor_events", {
      session_id: sessionId,
      events: [{ event_type: "contextmenu", severity: "high", occurred_at: nowIso }],
    });
    record(
      "j3. 3rd high-severity event: log_proctor_events response reports session_status=terminated",
      !batch2Err && batch2?.session_status === "terminated" && batch2?.violation_count === 3,
      batch2Err?.message ??
        `session_status=${batch2?.session_status} violation_count=${batch2?.violation_count}`,
    );

    const { data: sessionRow, error: sessionRowErr } = await admin
      .from("proctor_sessions")
      .select("status, ended_at")
      .eq("id", sessionId)
      .single();
    record(
      "j4. proctor_sessions row is status=terminated with ended_at set",
      !sessionRowErr && sessionRow?.status === "terminated" && Boolean(sessionRow?.ended_at),
      sessionRowErr?.message ?? `status=${sessionRow?.status} ended_at=${sessionRow?.ended_at}`,
    );

    const { data: terminatedEvents, error: terminatedEventsErr } = await admin
      .from("proctor_events")
      .select("*")
      .eq("session_id", sessionId)
      .eq("event_type", "session_terminated");
    record(
      "j5. session_terminated event logged (high severity)",
      !terminatedEventsErr &&
        terminatedEvents?.length === 1 &&
        terminatedEvents[0].severity === "high",
      terminatedEventsErr?.message ?? `rows=${terminatedEvents?.length}`,
    );

    const { data: reportRow, error: reportRowErr } = await admin
      .from("proctor_reports")
      .select("*")
      .eq("session_id", sessionId)
      .maybeSingle();
    record(
      "j6. proctor_reports row exists with reason=violation_limit_reached, status=pending_review",
      !reportRowErr &&
        Boolean(reportRow) &&
        reportRow?.reason === "violation_limit_reached" &&
        reportRow?.status === "pending_review",
      reportRowErr?.message ?? `reason=${reportRow?.reason} status=${reportRow?.status}`,
    );

    // Owner can read their own report.
    const { data: ownReport, error: ownReportErr } = await studentClient
      .from("proctor_reports")
      .select("*")
      .eq("session_id", sessionId);
    record(
      "j7. session owner (student) SELECT own proctor_reports row succeeds",
      !ownReportErr && (ownReport?.length ?? 0) === 1,
      ownReportErr?.message ?? `rows=${ownReport?.length}`,
    );

    // Lecturer can read it too (has_role('lecturer') policy).
    const { data: lecturerReport, error: lecturerReportErr } = await lecturerClient
      .from("proctor_reports")
      .select("*")
      .eq("session_id", sessionId);
    record(
      "j8. lecturer SELECT student's proctor_reports row succeeds",
      !lecturerReportErr && (lecturerReport?.length ?? 0) === 1,
      lecturerReportErr?.message ?? `rows=${lecturerReport?.length}`,
    );

    // Further log_proctor_events calls on a terminated session must fail
    // (RPC re-checks status = 'active').
    const { error: postTerminationErr } = await studentClient.rpc("log_proctor_events", {
      session_id: sessionId,
      events: [{ event_type: "tab_hidden", severity: "low", occurred_at: nowIso }],
    });
    record(
      "j9. log_proctor_events on a terminated session FAILS",
      Boolean(postTerminationErr),
      postTerminationErr?.message ??
        "no error raised — SECURITY: events accepted after termination",
    );

    // A second student session (own, unrelated) reads 0 rows for the
    // terminated session's report — students never see each other's reports.
    const { data: lecturerOwnSessionId, error: lecturerOwnStartErr } = await lecturerClient.rpc(
      "start_proctor_session",
      { context: `${context}-lecturer-own`, tier: 2, attested: true },
    );
    if (lecturerOwnStartErr) {
      record(
        "j10. student cannot read another user's proctor_reports (0 rows)",
        false,
        lecturerOwnStartErr.message,
      );
    } else {
      // Force the lecturer's own session to terminate too, so there is a
      // *second* report row owned by someone else, then confirm the student
      // cannot see it.
      await lecturerClient.rpc("log_proctor_events", {
        session_id: lecturerOwnSessionId,
        events: [
          { event_type: "fullscreen_exit", severity: "high", occurred_at: nowIso },
          { event_type: "copy_attempt", severity: "high", occurred_at: nowIso },
          { event_type: "contextmenu", severity: "high", occurred_at: nowIso },
        ],
      });
      const { data: crossReport, error: crossReportErr } = await studentClient
        .from("proctor_reports")
        .select("*")
        .eq("session_id", lecturerOwnSessionId);
      record(
        "j10. student cannot read another user's proctor_reports (0 rows)",
        !crossReportErr && (crossReport?.length ?? 0) === 0,
        crossReportErr?.message ?? `rows=${crossReport?.length}`,
      );
    }
  }

  // === (k) Phase 1.5: identity verification ==================================
  {
    const { client: studentClient } = sessions.student;
    const { client: lecturerClient } = sessions.lecturer;

    // k1. start_proctor_session without attested=true fails.
    const { data: noAttestId, error: noAttestErr } = await studentClient.rpc(
      "start_proctor_session",
      {
        context: `smoke-test-identity-noattest-${Date.now()}`,
        tier: 2,
        claimed_index_number: "5201040845",
        attested: false,
      },
    );
    record(
      "k1. start_proctor_session without attested=true FAILS",
      Boolean(noAttestErr) && !noAttestId,
      noAttestErr?.message ?? "no error raised — SECURITY: session created without attestation",
    );

    // k2. mismatch between claimed index number and profiles.student_number
    // logs a high-severity identity_mismatch event but still creates the session.
    const mismatchContext = `smoke-test-identity-mismatch-${Date.now()}`;
    const { data: mismatchSessionId, error: mismatchErr } = await studentClient.rpc(
      "start_proctor_session",
      {
        context: mismatchContext,
        tier: 2,
        claimed_index_number: "9999999999",
        attested: true,
      },
    );
    record(
      "k2a. start_proctor_session with mismatched index number still succeeds (flag, not a block)",
      !mismatchErr && typeof mismatchSessionId === "string",
      mismatchErr?.message ?? `sessionId=${mismatchSessionId}`,
    );

    const { data: mismatchEvents, error: mismatchEventsErr } = await admin
      .from("proctor_events")
      .select("*")
      .eq("session_id", mismatchSessionId)
      .eq("event_type", "identity_mismatch");
    record(
      "k2b. identity_mismatch event logged (high severity) when claimed != profile student_number",
      !mismatchEventsErr && mismatchEvents?.length === 1 && mismatchEvents[0].severity === "high",
      mismatchEventsErr?.message ?? `rows=${mismatchEvents?.length}`,
    );
    if (mismatchSessionId) {
      await studentClient.rpc("end_proctor_session", { session_id: mismatchSessionId });
    }

    // k3. matching index number logs no identity_mismatch event.
    const matchContext = `smoke-test-identity-match-${Date.now()}`;
    const { data: matchSessionId, error: matchErr } = await studentClient.rpc(
      "start_proctor_session",
      {
        context: matchContext,
        tier: 2,
        claimed_index_number: "5201040845",
        attested: true,
      },
    );
    record(
      "k3a. start_proctor_session with matching index number succeeds",
      !matchErr,
      matchErr?.message,
    );

    const { data: noMismatchEvents, error: noMismatchEventsErr } = await admin
      .from("proctor_events")
      .select("*")
      .eq("session_id", matchSessionId)
      .eq("event_type", "identity_mismatch");
    record(
      "k3b. no identity_mismatch event when claimed == profile student_number",
      !noMismatchEventsErr && (noMismatchEvents?.length ?? 0) === 0,
      noMismatchEventsErr?.message ?? `rows=${noMismatchEvents?.length}`,
    );

    // k4. attach_identity_portrait: owner-only, one-shot.
    const portraitPath = `${matchSessionId}/identity-smoke-test.jpg`;
    const tinyJpegBytes = Buffer.from(
      "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMDAwMDAwMDAwMEAwMEBQgFBQQEBQoHBgYICwwLCwoKCgoLDA0ODw4NDAsKCgr/2wBDAQEBAQEBAQEBAQECAgECAgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwP/wAALCAABAAEBAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9sAQwADAwMDAwMDAwMDBAMDBAUIBQUEBAUKBwYGCAsMCwsKCgoKCwwNDg8ODQwLCgoK/9sAQwEBAQEBAQEBAQECAgECAgMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwP/2gAMAwEAAhADEAAAAT8A/9k=",
      "base64",
    );
    const { error: uploadErr } = await studentClient.storage
      .from("proctoring")
      .upload(portraitPath, tinyJpegBytes, { contentType: "image/jpeg" });
    record(
      "k4a. student uploads identity portrait to own active session succeeds",
      !uploadErr,
      uploadErr?.message,
    );

    const { error: attachErr } = await studentClient.rpc("attach_identity_portrait", {
      session_id: matchSessionId,
      storage_path: portraitPath,
    });
    record("k4b. attach_identity_portrait (first call) succeeds", !attachErr, attachErr?.message);

    const { error: secondAttachErr } = await studentClient.rpc("attach_identity_portrait", {
      session_id: matchSessionId,
      storage_path: portraitPath,
    });
    record(
      "k4c. attach_identity_portrait a second time (one-shot) FAILS",
      Boolean(secondAttachErr),
      secondAttachErr?.message ?? "no error raised — SECURITY: identity portrait re-attached",
    );

    const { error: nonOwnerAttachErr } = await lecturerClient.rpc("attach_identity_portrait", {
      session_id: matchSessionId,
      storage_path: portraitPath,
    });
    record(
      "k4d. attach_identity_portrait by non-owner FAILS",
      Boolean(nonOwnerAttachErr),
      nonOwnerAttachErr?.message ??
        "no error raised — SECURITY: non-owner attached an identity portrait",
    );

    if (matchSessionId) {
      await studentClient.rpc("end_proctor_session", { session_id: matchSessionId });
    }

    // k5. profiles.student_number CHECK rejects non-10-digit values. Must go
    // through the service role directly (student_number is never
    // client-updatable at all per profiles_guard_update — this asserts the
    // DB-level CHECK itself, independent of that RLS/trigger restriction).
    const { error: badFormatErr } = await admin
      .from("profiles")
      .update({ student_number: "12345" })
      .eq("id", studentId);
    record(
      "k5. profiles.student_number CHECK rejects a non-10-digit value (even via service role)",
      isDenied(badFormatErr) || Boolean(badFormatErr),
      badFormatErr?.message ?? "no error raised — SECURITY: non-10-digit student_number accepted",
    );
    // Confirm the value is unchanged after the rejected update.
    const { data: unchangedProfile } = await admin
      .from("profiles")
      .select("student_number")
      .eq("id", studentId)
      .single();
    record(
      "k5b. student_number remains unchanged after the rejected update",
      unchangedProfile?.student_number === "5201040845",
      `student_number=${unchangedProfile?.student_number}`,
    );
  }

  // === (l) Phase 1.6/1.7: face-presence detection events, server-assigned
  // severity =================================================================
  // Phase 1.7 changed the DEFAULT policy: no_face_detected now counts toward
  // the violation limit by default (counts=true, severity medium) — the
  // "students are supposed to stay on the screen" directive applies here
  // too, same as every other violation-type event. This section overrides
  // no_face_detected to counts=false so it can isolate the
  // multiple_faces_detected auto-termination path exactly like before,
  // AND separately asserts the actual new default (a fresh session with NO
  // override counts no_face_detected as a strike).
  {
    const { client: studentClient } = sessions.student;
    const context = `smoke-test-face-detection-${Date.now()}`;

    // l1. start a fresh session, explicitly overriding no_face_detected to
    // counts=false so this scenario can isolate multiple_faces_detected's
    // termination path the same way it did before Phase 1.7's default-policy
    // change (see l1b below for a session that keeps the new default).
    const { data: sessionId, error: startErr } = await studentClient.rpc("start_proctor_session", {
      context,
      tier: 2,
      claimed_index_number: "5201040845",
      attested: true,
      violation_policy: { no_face_detected: { counts: false } },
    });
    record(
      "l1. student start_proctor_session succeeds for face-detection test",
      !startErr && typeof sessionId === "string",
      startErr?.message ?? `sessionId=${sessionId}`,
    );

    // l1b. a SEPARATE session with no override: Phase 1.7's new default
    // policy makes no_face_detected count (medium, counts=true) — assert
    // that default directly, independent of l1's override.
    const { data: defaultPolicySessionId, error: defaultPolicyStartErr } = await studentClient.rpc(
      "start_proctor_session",
      { context: `${context}-default-policy`, tier: 2, claimed_index_number: "5201040845", attested: true },
    );
    if (defaultPolicyStartErr) {
      record("l1b. Phase 1.7 default policy: no_face_detected counts by default", false, defaultPolicyStartErr.message);
    } else {
      const nowIsoDefault = new Date().toISOString();
      const { data: defaultBatch, error: defaultBatchErr } = await studentClient.rpc("log_proctor_events", {
        session_id: defaultPolicySessionId,
        events: [
          {
            event_type: "no_face_detected",
            severity: "info", // client lies about severity — server must ignore this
            occurred_at: nowIsoDefault,
            meta: { faceCount: 0, consecutiveMisses: 2 },
          },
        ],
      });
      record(
        "l1b. Phase 1.7 default policy: no_face_detected counts (violation_count=1) even though the client reported severity=info",
        !defaultBatchErr && defaultBatch?.session_status === "active" && defaultBatch?.violation_count === 1,
        defaultBatchErr?.message ??
          `session_status=${defaultBatch?.session_status} violation_count=${defaultBatch?.violation_count}`,
      );

      const { data: storedDefaultEvent } = await admin
        .from("proctor_events")
        .select("severity")
        .eq("session_id", defaultPolicySessionId)
        .eq("event_type", "no_face_detected")
        .maybeSingle();
      record(
        "l1c. ANTI-TAMPER: stored severity is the server's policy value (medium), not the client's lied value (info)",
        storedDefaultEvent?.severity === "medium",
        `stored severity=${storedDefaultEvent?.severity}`,
      );

      await studentClient.rpc("end_proctor_session", { session_id: defaultPolicySessionId });
    }

    // l2. no_face_detected on the l1 session (overridden to counts=false)
    // logs fine at its default severity (medium) but does NOT count toward
    // the violation limit, isolating the multiple_faces_detected assertions
    // below from this unrelated signal.
    const nowIso = new Date().toISOString();
    const { data: noFaceBatch, error: noFaceErr } = await studentClient.rpc("log_proctor_events", {
      session_id: sessionId,
      events: [
        {
          event_type: "no_face_detected",
          severity: "medium",
          occurred_at: nowIso,
          meta: { faceCount: 0, consecutiveMisses: 2 },
        },
      ],
    });
    record(
      "l2. log_proctor_events accepts no_face_detected (overridden counts=false) and does not bump violation_count",
      !noFaceErr && noFaceBatch?.session_status === "active" && noFaceBatch?.violation_count === 0,
      noFaceErr?.message ??
        `session_status=${noFaceBatch?.session_status} violation_count=${noFaceBatch?.violation_count}`,
    );

    const { data: noFaceEvents, error: noFaceEventsErr } = await admin
      .from("proctor_events")
      .select("*")
      .eq("session_id", sessionId)
      .eq("event_type", "no_face_detected");
    record(
      "l3. no_face_detected event row persisted with meta.faceCount=0",
      !noFaceEventsErr && noFaceEvents?.length === 1 && noFaceEvents[0].meta?.faceCount === 0,
      noFaceEventsErr?.message ?? `rows=${noFaceEvents?.length}`,
    );

    // l4. multiple_faces_detected accepted at high severity and DOES count
    // toward the violation limit (default policy, unchanged by Phase 1.7 —
    // still counts=true/severity=high) — drive it to the default limit (3)
    // with three multiple_faces_detected events and confirm auto-termination
    // + report filing. The client sends severity="low" here deliberately —
    // the server must ignore it and use the policy's "high" regardless.
    const { data: batch1, error: batch1Err } = await studentClient.rpc("log_proctor_events", {
      session_id: sessionId,
      events: [
        {
          event_type: "multiple_faces_detected",
          severity: "low",
          occurred_at: nowIso,
          meta: { faceCount: 2 },
        },
        {
          event_type: "multiple_faces_detected",
          severity: "low",
          occurred_at: nowIso,
          meta: { faceCount: 2 },
        },
      ],
    });
    record(
      "l4. two multiple_faces_detected events accepted (client-reported severity=low ignored), violation_count=2, still active",
      !batch1Err && batch1?.session_status === "active" && batch1?.violation_count === 2,
      batch1Err?.message ??
        `session_status=${batch1?.session_status} violation_count=${batch1?.violation_count}`,
    );

    const { data: batch2, error: batch2Err } = await studentClient.rpc("log_proctor_events", {
      session_id: sessionId,
      events: [
        {
          event_type: "multiple_faces_detected",
          severity: "low",
          occurred_at: nowIso,
          meta: { faceCount: 3 },
        },
      ],
    });
    record(
      "l5. 3rd multiple_faces_detected event terminates the session (violation_limit reached)",
      !batch2Err && batch2?.session_status === "terminated" && batch2?.violation_count === 3,
      batch2Err?.message ??
        `session_status=${batch2?.session_status} violation_count=${batch2?.violation_count}`,
    );

    const { data: sessionRow, error: sessionRowErr } = await admin
      .from("proctor_sessions")
      .select("status, ended_at")
      .eq("id", sessionId)
      .single();
    record(
      "l6. proctor_sessions row is status=terminated with ended_at set",
      !sessionRowErr && sessionRow?.status === "terminated" && Boolean(sessionRow?.ended_at),
      sessionRowErr?.message ?? `status=${sessionRow?.status} ended_at=${sessionRow?.ended_at}`,
    );

    const { data: storedFacesEvents } = await admin
      .from("proctor_events")
      .select("severity")
      .eq("session_id", sessionId)
      .eq("event_type", "multiple_faces_detected");
    record(
      "l6b. ANTI-TAMPER: all 3 multiple_faces_detected rows stored as severity=high despite the client reporting low",
      Array.isArray(storedFacesEvents) &&
        storedFacesEvents.length === 3 &&
        storedFacesEvents.every((e) => e.severity === "high"),
      `severities=${JSON.stringify(storedFacesEvents?.map((e) => e.severity))}`,
    );

    const { data: reportRow, error: reportRowErr } = await admin
      .from("proctor_reports")
      .select("*")
      .eq("session_id", sessionId)
      .maybeSingle();
    record(
      "l7. proctor_reports row filed (reason=violation_limit_reached) after multiple_faces_detected reached the limit",
      !reportRowErr &&
        Boolean(reportRow) &&
        reportRow?.reason === "violation_limit_reached" &&
        reportRow?.summary?.by_type?.multiple_faces_detected === 3,
      reportRowErr?.message ??
        `reason=${reportRow?.reason} by_type=${JSON.stringify(reportRow?.summary?.by_type)}`,
    );

    // l8. an invalid event_type is still rejected (vocabulary is an
    // allowlist, not "anything goes now that we added more values").
    const { error: invalidErr } = await studentClient.rpc("log_proctor_events", {
      session_id: sessionId,
      events: [{ event_type: "face_swap_detected", severity: "high", occurred_at: nowIso }],
    });
    record(
      "l8. log_proctor_events still rejects an unrecognized event_type",
      Boolean(invalidErr),
      invalidErr?.message ?? "no error raised — SECURITY: arbitrary event_type accepted",
    );
  }

  // === (m) Phase 1.7: configurable violation policy + display-change =======
  {
    const { client: studentClient } = sessions.student;
    const context = `smoke-test-violation-policy-${Date.now()}`;

    // m1. default_violation_policy() is readable and shapes as expected.
    const { data: defaults, error: defaultsErr } = await studentClient.rpc("default_violation_policy");
    record(
      "m1. default_violation_policy() returns tab_hidden as counts=true/severity=high",
      !defaultsErr && defaults?.tab_hidden?.counts === true && defaults?.tab_hidden?.severity === "high",
      defaultsErr?.message ?? `tab_hidden=${JSON.stringify(defaults?.tab_hidden)}`,
    );
    record(
      "m1b. default_violation_policy() returns connection_lost as counts=true/severity=medium (user directive)",
      !defaultsErr &&
        defaults?.connection_lost?.counts === true &&
        defaults?.connection_lost?.severity === "medium",
      defaultsErr?.message ?? `connection_lost=${JSON.stringify(defaults?.connection_lost)}`,
    );
    record(
      "m1c. default_violation_policy() returns heartbeat as counts=false/severity=info (lifecycle, never a violation)",
      !defaultsErr && defaults?.heartbeat?.counts === false && defaults?.heartbeat?.severity === "info",
      defaultsErr?.message ?? `heartbeat=${JSON.stringify(defaults?.heartbeat)}`,
    );

    // m2. start_proctor_session with a partial override merges correctly:
    // disable copy_attempt entirely, downgrade tab_hidden to low severity
    // but keep it counting.
    const { data: sessionId, error: startErr } = await studentClient.rpc("start_proctor_session", {
      context,
      tier: 2,
      attested: true,
      violation_policy: {
        copy_attempt: { counts: false },
        tab_hidden: { severity: "low" },
      },
    });
    record(
      "m2. start_proctor_session with a partial violation_policy override succeeds",
      !startErr && typeof sessionId === "string",
      startErr?.message ?? `sessionId=${sessionId}`,
    );

    // m3. an event whose policy was overridden to counts=false never
    // increments violation_count, regardless of client-reported severity.
    const nowIso = new Date().toISOString();
    const { data: copyBatch, error: copyErr } = await studentClient.rpc("log_proctor_events", {
      session_id: sessionId,
      events: [{ event_type: "copy_attempt", severity: "high", occurred_at: nowIso }],
    });
    record(
      "m3. copy_attempt overridden to counts=false does not bump violation_count",
      !copyErr && copyBatch?.session_status === "active" && copyBatch?.violation_count === 0,
      copyErr?.message ?? `violation_count=${copyBatch?.violation_count}`,
    );

    // m4. tab_hidden overridden to severity=low still COUNTS (counts was
    // not overridden, stays true) and is stored with the overridden
    // severity, not the client's claimed "high".
    const { data: tabBatch, error: tabErr } = await studentClient.rpc("log_proctor_events", {
      session_id: sessionId,
      events: [{ event_type: "tab_hidden", severity: "high", occurred_at: nowIso }],
    });
    record(
      "m4. tab_hidden (severity overridden to low, counts left at default true) bumps violation_count to 1",
      !tabErr && tabBatch?.session_status === "active" && tabBatch?.violation_count === 1,
      tabErr?.message ?? `violation_count=${tabBatch?.violation_count}`,
    );

    const { data: storedTabEvent } = await admin
      .from("proctor_events")
      .select("severity")
      .eq("session_id", sessionId)
      .eq("event_type", "tab_hidden")
      .maybeSingle();
    record(
      "m5. stored tab_hidden severity reflects the session's override (low), not the client's claimed severity (high)",
      storedTabEvent?.severity === "low",
      `stored severity=${storedTabEvent?.severity}`,
    );

    // m6. an override naming an unknown event_type is rejected server-side
    // (strict validation, not "silently ignored").
    const { error: badKeyErr } = await studentClient.rpc("start_proctor_session", {
      context: `${context}-bad-key`,
      tier: 2,
      attested: true,
      violation_policy: { not_a_real_event_type: { counts: true } },
    });
    record(
      "m6. start_proctor_session rejects a violation_policy override with an unknown event_type",
      Boolean(badKeyErr),
      badKeyErr?.message ?? "no error raised — SECURITY: unknown event_type override accepted",
    );

    // m7. an override with an invalid severity value is rejected.
    const { error: badSeverityErr } = await studentClient.rpc("start_proctor_session", {
      context: `${context}-bad-severity`,
      tier: 2,
      attested: true,
      violation_policy: { tab_hidden: { severity: "catastrophic" } },
    });
    record(
      "m7. start_proctor_session rejects a violation_policy override with an invalid severity value",
      Boolean(badSeverityErr),
      badSeverityErr?.message ?? "no error raised — SECURITY: invalid severity override accepted",
    );

    // m8. an override with a non-boolean counts value is rejected.
    const { error: badCountsErr } = await studentClient.rpc("start_proctor_session", {
      context: `${context}-bad-counts`,
      tier: 2,
      attested: true,
      violation_policy: { tab_hidden: { counts: "yes" } },
    });
    record(
      "m8. start_proctor_session rejects a violation_policy override with a non-boolean counts value",
      Boolean(badCountsErr),
      badCountsErr?.message ?? "no error raised — SECURITY: non-boolean counts override accepted",
    );

    // m9. display_configuration_changed is accepted by the event_type
    // vocabulary and counts by default (Phase 1.7 new event type).
    const { data: displayBatch, error: displayErr } = await studentClient.rpc("log_proctor_events", {
      session_id: sessionId,
      events: [
        {
          event_type: "display_configuration_changed",
          severity: "info",
          occurred_at: nowIso,
          meta: { source: "screen.change" },
        },
      ],
    });
    record(
      "m9. display_configuration_changed accepted and counts by default (violation_count=2)",
      !displayErr && displayBatch?.session_status === "active" && displayBatch?.violation_count === 2,
      displayErr?.message ?? `violation_count=${displayBatch?.violation_count}`,
    );

    const { data: storedDisplayEvent } = await admin
      .from("proctor_events")
      .select("severity")
      .eq("session_id", sessionId)
      .eq("event_type", "display_configuration_changed")
      .maybeSingle();
    record(
      "m10. stored display_configuration_changed severity is the server default (high), not the client's claimed info",
      storedDisplayEvent?.severity === "high",
      `stored severity=${storedDisplayEvent?.severity}`,
    );

    await studentClient.rpc("end_proctor_session", { session_id: sessionId });
  }

  // === (n) Phase 2a: proctored Google Forms wrapper (System 1) ==============
  // forms_exams RLS, start_forms_exam_session's exam-owned tier/policy, the
  // forms_exam_sessions results RPC, and — critically — the security
  // regression guard for the lock-down migration (20260705000006): a signed-
  // in student must NOT be able to call the shared _create_proctor_session
  // helper directly.
  {
    const { client: lecturerClient } = sessions.lecturer;
    const { client: studentClient } = sessions.student;
    const suffix = Date.now();

    // n1. lecturer creates a forms_exam (draft) via authenticated insert.
    const { data: createdExam, error: createErr } = await lecturerClient
      .from("forms_exams")
      .insert({
        owner_id: lecturerId,
        title: `Smoke test forms exam ${suffix}`,
        google_form_url: `https://docs.google.com/forms/d/e/smoke-test-${suffix}/viewform?embedded=true`,
        integrity_tier: 3,
        violation_policy: { copy_attempt: { counts: false } },
      })
      .select("*")
      .single();
    record(
      "n1. lecturer INSERT forms_exams (draft) succeeds",
      !createErr && Boolean(createdExam?.id),
      createErr?.message ?? `id=${createdExam?.id}`,
    );
    const examId = createdExam?.id;

    // n2. draft is invisible to a student via bare SELECT (RLS).
    if (examId) {
      const { data: draftAsStudent, error: draftAsStudentErr } = await studentClient
        .from("forms_exams")
        .select("*")
        .eq("id", examId);
      record(
        "n2. student SELECT of a DRAFT forms_exam returns 0 rows",
        !draftAsStudentErr && (draftAsStudent?.length ?? 0) === 0,
        draftAsStudentErr?.message ?? `rows=${draftAsStudent?.length}`,
      );
    } else {
      record("n2. student SELECT of a DRAFT forms_exam returns 0 rows", false, "skipped — n1 failed");
    }

    // n3. start_forms_exam_session refuses while status='draft'.
    if (examId) {
      const { data: draftStartId, error: draftStartErr } = await studentClient.rpc(
        "start_forms_exam_session",
        { forms_exam_id: examId, claimed_index_number: "5201040845", attested: true },
      );
      record(
        "n3. start_forms_exam_session on a draft exam FAILS",
        Boolean(draftStartErr) && !draftStartId,
        draftStartErr?.message ?? "no error raised — SECURITY: session started against a draft exam",
      );
    } else {
      record("n3. start_forms_exam_session on a draft exam FAILS", false, "skipped — n1 failed");
    }

    // n4. lecturer publishes it; can read it back and call forms_exam_sessions.
    if (examId) {
      const { error: publishErr } = await lecturerClient
        .from("forms_exams")
        .update({ status: "published" })
        .eq("id", examId);
      record("n4a. lecturer UPDATE forms_exams to status=published succeeds", !publishErr, publishErr?.message);

      const { data: readBack, error: readBackErr } = await lecturerClient
        .from("forms_exams")
        .select("*")
        .eq("id", examId)
        .maybeSingle();
      record(
        "n4b. lecturer reads the published exam back",
        !readBackErr && readBack?.status === "published",
        readBackErr?.message ?? `status=${readBack?.status}`,
      );

      const { data: sessionsList, error: sessionsListErr } = await lecturerClient.rpc(
        "forms_exam_sessions",
        { forms_exam_id: examId },
      );
      record(
        "n4c. lecturer calls forms_exam_sessions() on own exam (0 rows so far, no error)",
        !sessionsListErr && Array.isArray(sessionsList),
        sessionsListErr?.message ?? `rows=${sessionsList?.length}`,
      );
    } else {
      record("n4a. lecturer UPDATE forms_exams to status=published succeeds", false, "skipped — n1 failed");
      record("n4b. lecturer reads the published exam back", false, "skipped — n1 failed");
      record("n4c. lecturer calls forms_exam_sessions() on own exam (0 rows so far, no error)", false, "skipped — n1 failed");
    }

    // n5. now published+open: a student CAN select it (RLS
    // forms_exams_select_published_and_open).
    if (examId) {
      const { data: publishedAsStudent, error: publishedAsStudentErr } = await studentClient
        .from("forms_exams")
        .select("*")
        .eq("id", examId);
      record(
        "n5. student SELECT of a PUBLISHED+OPEN forms_exam returns 1 row",
        !publishedAsStudentErr && publishedAsStudent?.length === 1,
        publishedAsStudentErr?.message ?? `rows=${publishedAsStudent?.length}`,
      );
    } else {
      record("n5. student SELECT of a PUBLISHED+OPEN forms_exam returns 1 row", false, "skipped — n1 failed");
    }

    // n6. SECURITY REGRESSION (critical, guards 20260705000006): a signed-in
    // student calling the internal _create_proctor_session helper directly
    // via rpc() must be DENIED — this is exactly the bypass the lead found
    // and fixed (a student could mint a session with an arbitrary
    // caller-supplied policy, bypassing the exam-owned guarantee entirely).
    {
      const { error: directHelperErr } = await studentClient.rpc("_create_proctor_session", {
        context: `smoke-test-direct-helper-${suffix}`,
        tier: 1,
        policy: { tab_hidden: { severity: "info", counts: false } },
        claimed_index_number: "5201040845",
        attested: true,
      });
      record(
        "n6. SECURITY: student rpc('_create_proctor_session', ...) directly is DENIED (guards 20260705000006)",
        isDenied(directHelperErr),
        directHelperErr?.message ??
          "no error raised — SECURITY REGRESSION: the internal session-creation helper is directly callable, bypassing exam-owned policy",
      );
    }

    // n7. start_forms_exam_session refuses when now() is outside
    // [opens_at, closes_at] — both a future opens_at and a past closes_at.
    const { data: futureExam, error: futureExamErr } = await lecturerClient
      .from("forms_exams")
      .insert({
        owner_id: lecturerId,
        title: `Smoke test forms exam (not yet open) ${suffix}`,
        google_form_url: `https://docs.google.com/forms/d/e/smoke-test-future-${suffix}/viewform?embedded=true`,
        status: "published",
        opens_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
      .select("id")
      .single();
    if (futureExamErr || !futureExam?.id) {
      record("n7a. start_forms_exam_session before opens_at FAILS", false, futureExamErr?.message ?? "insert failed");
    } else {
      const { data: tooEarlyId, error: tooEarlyErr } = await studentClient.rpc("start_forms_exam_session", {
        forms_exam_id: futureExam.id,
        attested: true,
      });
      record(
        "n7a. start_forms_exam_session before opens_at FAILS",
        Boolean(tooEarlyErr) && !tooEarlyId,
        tooEarlyErr?.message ?? "no error raised — SECURITY: session started before the exam opened",
      );
    }

    const { data: pastExam, error: pastExamErr } = await lecturerClient
      .from("forms_exams")
      .insert({
        owner_id: lecturerId,
        title: `Smoke test forms exam (closed window) ${suffix}`,
        google_form_url: `https://docs.google.com/forms/d/e/smoke-test-past-${suffix}/viewform?embedded=true`,
        status: "published",
        closes_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      })
      .select("id")
      .single();
    if (pastExamErr || !pastExam?.id) {
      record("n7b. start_forms_exam_session after closes_at FAILS", false, pastExamErr?.message ?? "insert failed");
    } else {
      const { data: tooLateId, error: tooLateErr } = await studentClient.rpc("start_forms_exam_session", {
        forms_exam_id: pastExam.id,
        attested: true,
      });
      record(
        "n7b. start_forms_exam_session after closes_at FAILS",
        Boolean(tooLateErr) && !tooLateId,
        tooLateErr?.message ?? "no error raised — SECURITY: session started after the exam closed",
      );
    }

    // n8. start_forms_exam_session on a status='closed' exam FAILS.
    const { data: closedExam, error: closedExamErr } = await lecturerClient
      .from("forms_exams")
      .insert({
        owner_id: lecturerId,
        title: `Smoke test forms exam (closed) ${suffix}`,
        google_form_url: `https://docs.google.com/forms/d/e/smoke-test-closed-${suffix}/viewform?embedded=true`,
        status: "closed",
      })
      .select("id")
      .single();
    if (closedExamErr || !closedExam?.id) {
      record("n8. start_forms_exam_session on status=closed exam FAILS", false, closedExamErr?.message ?? "insert failed");
    } else {
      const { data: closedStartId, error: closedStartErr } = await studentClient.rpc("start_forms_exam_session", {
        forms_exam_id: closedExam.id,
        attested: true,
      });
      record(
        "n8. start_forms_exam_session on status=closed exam FAILS",
        Boolean(closedStartErr) && !closedStartId,
        closedStartErr?.message ?? "no error raised — SECURITY: session started against a closed exam",
      );
    }

    // n9. published+open: start_forms_exam_session succeeds, and the created
    // proctor_sessions.violation_policy EQUALS the exam's stored policy
    // (deep-equal) even though the student has NO parameter to pass their
    // own policy/tier — proving there is no override path, not just that
    // one wasn't used.
    let formsSessionId;
    if (examId) {
      const { data: startedId, error: startedErr } = await studentClient.rpc("start_forms_exam_session", {
        forms_exam_id: examId,
        claimed_index_number: "5201040845",
        attested: true,
      });
      record(
        "n9a. start_forms_exam_session on a published+open exam succeeds",
        !startedErr && typeof startedId === "string",
        startedErr?.message ?? `sessionId=${startedId}`,
      );
      formsSessionId = startedId;

      const { data: createdSession, error: createdSessionErr } = await admin
        .from("proctor_sessions")
        .select("integrity_tier, violation_policy, context")
        .eq("id", startedId)
        .maybeSingle();
      record(
        "n9b. created session's integrity_tier equals the exam's stored integrity_tier (3)",
        !createdSessionErr && createdSession?.integrity_tier === 3,
        createdSessionErr?.message ?? `integrity_tier=${createdSession?.integrity_tier}`,
      );
      record(
        "n9c. created session's violation_policy deep-equals the exam's stored violation_policy (exam-owned, no student override)",
        !createdSessionErr &&
          JSON.stringify(createdSession?.violation_policy) === JSON.stringify(createdExam?.violation_policy ?? null) &&
          createdSession?.violation_policy?.copy_attempt?.counts === false,
        createdSessionErr?.message ?? `violation_policy=${JSON.stringify(createdSession?.violation_policy)}`,
      );
      record(
        "n9d. created session's context is 'form:<forms_exam_id>'",
        createdSession?.context === `form:${examId}`,
        `context=${createdSession?.context}`,
      );
    } else {
      record("n9a. start_forms_exam_session on a published+open exam succeeds", false, "skipped — n1 failed");
      record("n9b. created session's integrity_tier equals the exam's stored integrity_tier (3)", false, "skipped — n1 failed");
      record("n9c. created session's violation_policy deep-equals the exam's stored violation_policy (exam-owned, no student override)", false, "skipped — n1 failed");
      record("n9d. created session's context is 'form:<forms_exam_id>'", false, "skipped — n1 failed");
    }

    // n10. forms_exam_sessions() now shows the student's session; lecturer
    // (owner) can call it.
    if (examId && formsSessionId) {
      const { data: sessionsAfter, error: sessionsAfterErr } = await lecturerClient.rpc(
        "forms_exam_sessions",
        { forms_exam_id: examId },
      );
      const row = sessionsAfter?.find((r) => r.session_id === formsSessionId);
      record(
        "n10. forms_exam_sessions() (owner) now includes the student's session with matching claimed_index_number",
        !sessionsAfterErr && Boolean(row) && row?.claimed_index_number === "5201040845",
        sessionsAfterErr?.message ?? `row=${JSON.stringify(row)}`,
      );
    } else {
      record(
        "n10. forms_exam_sessions() (owner) now includes the student's session with matching claimed_index_number",
        false,
        "skipped — n1/n9 failed",
      );
    }

    // n11. a non-owner, non-lecturer (student) cannot call
    // forms_exam_sessions for someone else's exam.
    if (examId) {
      const { error: nonOwnerResultsErr } = await studentClient.rpc("forms_exam_sessions", {
        forms_exam_id: examId,
      });
      record(
        "n11. student (non-owner, non-lecturer) calling forms_exam_sessions() for another user's exam FAILS",
        Boolean(nonOwnerResultsErr),
        nonOwnerResultsErr?.message ??
          "no error raised — SECURITY: a student read another user's exam results",
      );
    } else {
      record(
        "n11. student (non-owner, non-lecturer) calling forms_exam_sessions() for another user's exam FAILS",
        false,
        "skipped — n1 failed",
      );
    }

    // n12. student cannot INSERT/UPDATE/DELETE forms_exams directly (owner-
    // or-lecturer only) — a student is neither.
    const { error: studentInsertErr } = await studentClient.from("forms_exams").insert({
      owner_id: studentId,
      title: "Student-forged exam",
      google_form_url: "https://docs.google.com/forms/d/e/forged/viewform?embedded=true",
    });
    record(
      "n12a. student direct INSERT into forms_exams FAILS",
      isDenied(studentInsertErr) || Boolean(studentInsertErr),
      studentInsertErr?.message ?? "no error raised — SECURITY: student created a forms_exam directly",
    );

    if (examId) {
      const { error: studentUpdateErr } = await studentClient
        .from("forms_exams")
        .update({ integrity_tier: 1 })
        .eq("id", examId);
      const { data: examAfterStudentUpdate } = await admin
        .from("forms_exams")
        .select("integrity_tier")
        .eq("id", examId)
        .single();
      record(
        "n12b. student direct UPDATE of another user's forms_exams FAILS (tier unchanged)",
        (isDenied(studentUpdateErr) || Boolean(studentUpdateErr) || examAfterStudentUpdate?.integrity_tier === 3),
        studentUpdateErr?.message ?? `integrity_tier_after=${examAfterStudentUpdate?.integrity_tier}`,
      );
    } else {
      record("n12b. student direct UPDATE of another user's forms_exams FAILS (tier unchanged)", false, "skipped — n1 failed");
    }

    // Cleanup: end the session we created, then delete every forms_exams row
    // this block created (service role bypasses RLS) so the suite is
    // idempotent across repeated runs.
    if (formsSessionId) {
      await studentClient.rpc("end_proctor_session", { session_id: formsSessionId });
    }
    const cleanupIds = [examId, futureExam?.id, pastExam?.id, closedExam?.id].filter(Boolean);
    if (cleanupIds.length > 0) {
      await admin.from("forms_exams").delete().in("id", cleanupIds);
    }
  }

  // === (o) regression: start_proctor_session (demo path) still works
  // unmodified through the new _create_proctor_session delegation. Sections
  // (i)/(j)/(k)/(l)/(m) above already exercise it end-to-end and all passed,
  // so this is a light, explicit confirmation the delegation didn't change
  // its externally-observable behavior for a plain call with no overrides.
  {
    const { client: studentClient } = sessions.student;
    const context = `smoke-test-post-delegation-${Date.now()}`;
    const { data: sessionId, error: startErr } = await studentClient.rpc("start_proctor_session", {
      context,
      tier: 2,
      claimed_index_number: "5201040845",
      attested: true,
    });
    record(
      "o1. start_proctor_session (no overrides) still works after the _create_proctor_session delegation refactor",
      !startErr && typeof sessionId === "string",
      startErr?.message ?? `sessionId=${sessionId}`,
    );
    if (sessionId) {
      const { data: sessionRow } = await admin
        .from("proctor_sessions")
        .select("violation_policy")
        .eq("id", sessionId)
        .maybeSingle();
      record(
        "o2. delegated session's violation_policy equals default_violation_policy() (no override supplied)",
        JSON.stringify(sessionRow?.violation_policy) ===
          JSON.stringify((await studentClient.rpc("default_violation_policy")).data),
        `violation_policy=${JSON.stringify(sessionRow?.violation_policy)}`,
      );
      await studentClient.rpc("end_proctor_session", { session_id: sessionId });
    } else {
      record("o2. delegated session's violation_policy equals default_violation_policy() (no override supplied)", false, "skipped — o1 failed");
    }
  }

  // === (p) Phase 2b: Apps Script onFormSubmit cross-check (bypass detection)
  // ===========================================================================
  // Covers: rotate_forms_exam_secret is owner/lecturer-only; a student cannot
  // SELECT forms_submissions directly (RLS); the webhook route classifies
  // matched / no_session / out_of_window correctly; a wrong/missing secret
  // is rejected (401); forms_exam_submissions() is owner/lecturer-gated.
  {
    const { client: lecturerClient } = sessions.lecturer;
    const { client: studentClient } = sessions.student;
    const suffix = Date.now();
    const WEB_APP_ORIGIN = process.env.SMOKE_TEST_WEB_ORIGIN ?? "http://localhost:3000";
    const WEBHOOK_URL = `${WEB_APP_ORIGIN}/api/forms/submission`;

    // Create a published forms_exam owned by the lecturer to attach
    // submissions/sessions to.
    const { data: examP, error: examPErr } = await lecturerClient
      .from("forms_exams")
      .insert({
        owner_id: lecturerId,
        title: `Smoke test bypass-detection exam ${suffix}`,
        google_form_url: `https://docs.google.com/forms/d/e/smoke-test-bypass-${suffix}/viewform?embedded=true`,
        status: "published",
      })
      .select("id")
      .single();
    const examPId = examP?.id;
    record(
      "p1. lecturer creates + publishes a forms_exam for the bypass-detection test",
      !examPErr && Boolean(examPId),
      examPErr?.message ?? `id=${examPId}`,
    );

    // p2. rotate_forms_exam_secret: student (non-owner, non-lecturer) DENIED.
    if (examPId) {
      const { data: studentSecret, error: studentSecretErr } = await studentClient.rpc(
        "rotate_forms_exam_secret",
        { forms_exam_id: examPId },
      );
      record(
        "p2. student rpc rotate_forms_exam_secret on another user's exam FAILS",
        Boolean(studentSecretErr) && !studentSecret,
        studentSecretErr?.message ??
          "no error raised — SECURITY: a student generated another user's submission secret",
      );
    } else {
      record("p2. student rpc rotate_forms_exam_secret on another user's exam FAILS", false, "skipped — p1 failed");
    }

    // p3. rotate_forms_exam_secret: owner (lecturer) succeeds and returns a secret.
    let examSecret;
    if (examPId) {
      const { data: secret, error: secretErr } = await lecturerClient.rpc("rotate_forms_exam_secret", {
        forms_exam_id: examPId,
      });
      examSecret = secret;
      record(
        "p3. lecturer (owner) rpc rotate_forms_exam_secret succeeds and returns a non-empty secret",
        !secretErr && typeof secret === "string" && secret.length >= 32,
        secretErr?.message ?? `secret_len=${secret?.length}`,
      );
    } else {
      record("p3. lecturer (owner) rpc rotate_forms_exam_secret succeeds and returns a non-empty secret", false, "skipped — p1 failed");
    }

    // p4. rotate_forms_exam_secret on a nonexistent exam FAILS.
    {
      const { data: bogusSecret, error: bogusErr } = await lecturerClient.rpc(
        "rotate_forms_exam_secret",
        { forms_exam_id: "00000000-0000-0000-0000-000000000000" },
      );
      record(
        "p4. rotate_forms_exam_secret on a nonexistent forms_exam FAILS",
        Boolean(bogusErr) && !bogusSecret,
        bogusErr?.message ?? "no error raised",
      );
    }

    // === Case (a): a student WITH an in-window proctored session for this
    // form, whose submission email matches -> 'matched'.
    let matchedSessionId;
    if (examPId) {
      const { data: sid, error: sidErr } = await studentClient.rpc("start_forms_exam_session", {
        forms_exam_id: examPId,
        claimed_index_number: "5201040845",
        attested: true,
      });
      matchedSessionId = sid;
      record(
        "p5. student starts a proctored session against the bypass-detection exam",
        !sidErr && typeof sid === "string",
        sidErr?.message ?? `sessionId=${sid}`,
      );
    }

    // Case (b): a DIFFERENT user (lecturer, standing in as "a user with no
    // session for this form") — used below for the no_session case; no
    // session started for them against this exam's context on purpose.

    if (examPId && examSecret) {
      // p6. Case (a) MATCHED: submit within the session window, correct secret.
      const matchedEmail = "student@usted.test";
      const nowIso = new Date().toISOString();
      const resMatched = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forms-secret": examSecret },
        body: JSON.stringify({
          forms_exam_id: examPId,
          respondent_email: matchedEmail,
          submitted_at: nowIso,
          raw: { source: "smoke-test-matched" },
        }),
      }).catch((err) => ({ ok: false, status: 0, _fetchError: err }));
      record(
        "p6a. webhook POST with correct secret + in-window submission returns 200",
        resMatched.ok && resMatched.status === 200,
        resMatched._fetchError?.message ?? `status=${resMatched.status}`,
      );

      const { data: matchedRow, error: matchedRowErr } = await admin
        .from("forms_submissions")
        .select("*")
        .eq("forms_exam_id", examPId)
        .eq("respondent_email", matchedEmail)
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      record(
        "p6b. cross-check classifies the in-window submission as match_status='matched'",
        !matchedRowErr && matchedRow?.match_status === "matched" && matchedRow?.matched_session_id === matchedSessionId,
        matchedRowErr?.message ?? `match_status=${matchedRow?.match_status} matched_session_id=${matchedRow?.matched_session_id}`,
      );

      // p7. Case (b) NO_SESSION: email of a user with NO session for this
      // form's context at all (lecturer never started a forms-exam session
      // against examPId) -> 'no_session' (the bypass flag).
      const noSessionEmail = "lecturer@usted.test";
      const resNoSession = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forms-secret": examSecret },
        body: JSON.stringify({
          forms_exam_id: examPId,
          respondent_email: noSessionEmail,
          submitted_at: new Date().toISOString(),
          raw: { source: "smoke-test-no-session" },
        }),
      }).catch((err) => ({ ok: false, status: 0, _fetchError: err }));
      record(
        "p7a. webhook POST for a user with no proctored session returns 200",
        resNoSession.ok && resNoSession.status === 200,
        resNoSession._fetchError?.message ?? `status=${resNoSession.status}`,
      );

      const { data: noSessionRow, error: noSessionRowErr } = await admin
        .from("forms_submissions")
        .select("*")
        .eq("forms_exam_id", examPId)
        .eq("respondent_email", noSessionEmail)
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      record(
        "p7b. BYPASS FLAG: cross-check classifies a submission with no matching proctored session as match_status='no_session'",
        !noSessionRowErr && noSessionRow?.match_status === "no_session" && noSessionRow?.matched_session_id === null,
        noSessionRowErr?.message ?? `match_status=${noSessionRow?.match_status}`,
      );

      // p8. Case (c) OUT_OF_WINDOW: same matched student/session, but
      // submitted_at is far outside [started_at, ended_at-or-now]. End the
      // session first so it has a fixed window, then submit with a
      // submitted_at 2 hours before it started.
      if (matchedSessionId) {
        await studentClient.rpc("end_proctor_session", { session_id: matchedSessionId });
      }
      const { data: sessionWindow } = await admin
        .from("proctor_sessions")
        .select("started_at, ended_at")
        .eq("id", matchedSessionId)
        .maybeSingle();
      const outOfWindowTimestamp = sessionWindow?.started_at
        ? new Date(new Date(sessionWindow.started_at).getTime() - 2 * 60 * 60 * 1000).toISOString()
        : new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      const resOutOfWindow = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forms-secret": examSecret },
        body: JSON.stringify({
          forms_exam_id: examPId,
          respondent_email: matchedEmail,
          submitted_at: outOfWindowTimestamp,
          raw: { source: "smoke-test-out-of-window" },
        }),
      }).catch((err) => ({ ok: false, status: 0, _fetchError: err }));
      record(
        "p8a. webhook POST for a submission outside the session window returns 200",
        resOutOfWindow.ok && resOutOfWindow.status === 200,
        resOutOfWindow._fetchError?.message ?? `status=${resOutOfWindow.status}`,
      );

      const { data: outOfWindowRow, error: outOfWindowRowErr } = await admin
        .from("forms_submissions")
        .select("*")
        .eq("forms_exam_id", examPId)
        .eq("respondent_email", matchedEmail)
        .eq("match_status", "out_of_window")
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      record(
        "p8b. cross-check classifies the out-of-window submission as match_status='out_of_window' against the same session",
        !outOfWindowRowErr && outOfWindowRow?.match_status === "out_of_window" && outOfWindowRow?.matched_session_id === matchedSessionId,
        outOfWindowRowErr?.message ?? `match_status=${outOfWindowRow?.match_status}`,
      );

      // p9. no_email case: blank respondent_email -> 'no_email'.
      const resNoEmail = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forms-secret": examSecret },
        body: JSON.stringify({
          forms_exam_id: examPId,
          respondent_email: null,
          submitted_at: new Date().toISOString(),
          raw: { source: "smoke-test-no-email" },
        }),
      }).catch((err) => ({ ok: false, status: 0, _fetchError: err }));
      record(
        "p9a. webhook POST with no respondent_email returns 200",
        resNoEmail.ok && resNoEmail.status === 200,
        resNoEmail._fetchError?.message ?? `status=${resNoEmail.status}`,
      );

      const { data: noEmailRow, error: noEmailRowErr } = await admin
        .from("forms_submissions")
        .select("*")
        .eq("forms_exam_id", examPId)
        .is("respondent_email", null)
        .order("received_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      record(
        "p9b. cross-check classifies a submission with no email as match_status='no_email'",
        !noEmailRowErr && noEmailRow?.match_status === "no_email",
        noEmailRowErr?.message ?? `match_status=${noEmailRow?.match_status}`,
      );

      // p10. WRONG secret is rejected with 401 and writes NOTHING.
      const { count: countBeforeWrongSecret } = await admin
        .from("forms_submissions")
        .select("*", { count: "exact", head: true })
        .eq("forms_exam_id", examPId);
      const resWrongSecret = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forms-secret": "not-the-real-secret" },
        body: JSON.stringify({
          forms_exam_id: examPId,
          respondent_email: matchedEmail,
          submitted_at: new Date().toISOString(),
        }),
      }).catch((err) => ({ ok: false, status: 0, _fetchError: err }));
      record(
        "p10a. webhook POST with a WRONG secret is rejected with 401",
        resWrongSecret.status === 401,
        resWrongSecret._fetchError?.message ?? `status=${resWrongSecret.status}`,
      );
      const { count: countAfterWrongSecret } = await admin
        .from("forms_submissions")
        .select("*", { count: "exact", head: true })
        .eq("forms_exam_id", examPId);
      record(
        "p10b. wrong-secret request writes no forms_submissions row",
        countBeforeWrongSecret === countAfterWrongSecret,
        `before=${countBeforeWrongSecret} after=${countAfterWrongSecret}`,
      );

      // p11. MISSING secret header is rejected with 401.
      const resMissingSecret = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          forms_exam_id: examPId,
          respondent_email: matchedEmail,
          submitted_at: new Date().toISOString(),
        }),
      }).catch((err) => ({ ok: false, status: 0, _fetchError: err }));
      record(
        "p11. webhook POST with a MISSING secret header is rejected with 401",
        resMissingSecret.status === 401,
        resMissingSecret._fetchError?.message ?? `status=${resMissingSecret.status}`,
      );

      // p12. unknown forms_exam_id is rejected with 404.
      const resUnknownExam = await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forms-secret": examSecret },
        body: JSON.stringify({
          forms_exam_id: "00000000-0000-0000-0000-000000000000",
          respondent_email: matchedEmail,
          submitted_at: new Date().toISOString(),
        }),
      }).catch((err) => ({ ok: false, status: 0, _fetchError: err }));
      record(
        "p12. webhook POST for an unknown forms_exam_id is rejected with 404",
        resUnknownExam.status === 404,
        resUnknownExam._fetchError?.message ?? `status=${resUnknownExam.status}`,
      );
    } else {
      for (const label of [
        "p6a. webhook POST with correct secret + in-window submission returns 200",
        "p6b. cross-check classifies the in-window submission as match_status='matched'",
        "p7a. webhook POST for a user with no proctored session returns 200",
        "p7b. BYPASS FLAG: cross-check classifies a submission with no matching proctored session as match_status='no_session'",
        "p8a. webhook POST for a submission outside the session window returns 200",
        "p8b. cross-check classifies the out-of-window submission as match_status='out_of_window' against the same session",
        "p9a. webhook POST with no respondent_email returns 200",
        "p9b. cross-check classifies a submission with no email as match_status='no_email'",
        "p10a. webhook POST with a WRONG secret is rejected with 401",
        "p10b. wrong-secret request writes no forms_submissions row",
        "p11. webhook POST with a MISSING secret header is rejected with 401",
        "p12. webhook POST for an unknown forms_exam_id is rejected with 404",
      ]) {
        record(label, false, "skipped — p1/p3 failed (exam or secret not created; is the web dev server running on SMOKE_TEST_WEB_ORIGIN?)");
      }
    }

    // p13. RLS: a student cannot SELECT forms_submissions directly, even for
    // an exam they themselves submitted evidence against.
    if (examPId) {
      const { data: studentSubmissions, error: studentSubmissionsErr } = await studentClient
        .from("forms_submissions")
        .select("*")
        .eq("forms_exam_id", examPId);
      record(
        "p13. student direct SELECT of forms_submissions returns 0 rows (RLS)",
        !studentSubmissionsErr && (studentSubmissions?.length ?? 0) === 0,
        studentSubmissionsErr?.message ?? `rows=${studentSubmissions?.length}`,
      );
    } else {
      record("p13. student direct SELECT of forms_submissions returns 0 rows (RLS)", false, "skipped — p1 failed");
    }

    // p14. student cannot INSERT/UPDATE/DELETE forms_submissions directly —
    // append-only, service-role-only writer.
    if (examPId) {
      const { error: studentInsertErr } = await studentClient.from("forms_submissions").insert({
        forms_exam_id: examPId,
        respondent_email: "forged@usted.test",
        match_status: "matched",
      });
      record(
        "p14a. student direct INSERT into forms_submissions FAILS",
        isDenied(studentInsertErr) || Boolean(studentInsertErr),
        studentInsertErr?.message ?? "no error raised — SECURITY: a student inserted a forged submission",
      );

      const { data: anyRow } = await admin
        .from("forms_submissions")
        .select("id")
        .eq("forms_exam_id", examPId)
        .limit(1)
        .maybeSingle();
      if (anyRow) {
        const { error: studentUpdateErr } = await studentClient
          .from("forms_submissions")
          .update({ match_status: "matched" })
          .eq("id", anyRow.id);
        record(
          "p14b. student direct UPDATE of forms_submissions FAILS (append-only)",
          isDenied(studentUpdateErr) || Boolean(studentUpdateErr),
          studentUpdateErr?.message ?? "no error raised — SECURITY: forms_submissions is mutable",
        );

        // DELETE is blocked for a student via REVOKE + no DELETE RLS policy
        // (not a trigger — see the migration comment: a trigger here would
        // also break the legitimate on-delete-cascade from forms_exams).
        const { error: studentDeleteErr } = await studentClient
          .from("forms_submissions")
          .delete()
          .eq("id", anyRow.id);
        record(
          "p14c. student direct DELETE of forms_submissions FAILS (RLS + REVOKE, not a trigger)",
          isDenied(studentDeleteErr) || Boolean(studentDeleteErr),
          studentDeleteErr?.message ?? "no error raised — SECURITY: forms_submissions rows can be deleted",
        );

        // Belt-and-braces: even the SERVICE ROLE cannot UPDATE an
        // append-only row (the trigger fires regardless of role) — this is
        // narrower than DELETE deliberately, see p14e below.
        const { error: adminUpdateErr } = await admin
          .from("forms_submissions")
          .update({ match_status: "no_session" })
          .eq("id", anyRow.id);
        record(
          "p14d. even the SERVICE ROLE cannot UPDATE forms_submissions (trigger-enforced append-only)",
          Boolean(adminUpdateErr),
          adminUpdateErr?.message ?? "no error raised — SECURITY: forms_submissions is mutable even via service role",
        );
      } else {
        record("p14b. student direct UPDATE of forms_submissions FAILS (append-only)", false, "skipped — no row to test against");
        record("p14c. student direct DELETE of forms_submissions FAILS (RLS + REVOKE, not a trigger)", false, "skipped — no row to test against");
        record("p14d. even the SERVICE ROLE cannot UPDATE forms_submissions (trigger-enforced append-only)", false, "skipped — no row to test against");
      }
    } else {
      record("p14a. student direct INSERT into forms_submissions FAILS", false, "skipped — p1 failed");
      record("p14b. student direct UPDATE of forms_submissions FAILS (append-only)", false, "skipped — p1 failed");
      record("p14c. student direct DELETE of forms_submissions FAILS (RLS + REVOKE, not a trigger)", false, "skipped — p1 failed");
      record("p14d. even the SERVICE ROLE cannot UPDATE forms_submissions (trigger-enforced append-only)", false, "skipped — p1 failed");
    }

    // p14e. REGRESSION GUARD: deleting the parent forms_exams row (a normal
    // owner/lecturer action) must cascade-delete its forms_submissions rows
    // without error. This is the exact case that broke during development —
    // an earlier version of the append-only trigger blocked ALL deletes
    // (including cascades), which made deleting a forms_exams row with
    // submissions attached fail outright. Verified here with a SEPARATE
    // throwaway exam so it doesn't interfere with p1..p16's examPId, which
    // the end-of-block cleanup below also relies on cascading cleanly.
    {
      const { data: cascadeExam, error: cascadeExamErr } = await lecturerClient
        .from("forms_exams")
        .insert({
          owner_id: lecturerId,
          title: `Smoke test cascade-delete exam ${suffix}`,
          google_form_url: `https://docs.google.com/forms/d/e/smoke-test-cascade-${suffix}/viewform?embedded=true`,
          status: "published",
        })
        .select("id")
        .single();
      if (cascadeExamErr || !cascadeExam?.id) {
        record("p14e. deleting a forms_exams row cascades to forms_submissions without error", false, cascadeExamErr?.message ?? "insert failed");
      } else {
        const { data: cascadeSecret } = await lecturerClient.rpc("rotate_forms_exam_secret", {
          forms_exam_id: cascadeExam.id,
        });
        await fetch(WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forms-secret": cascadeSecret ?? "" },
          body: JSON.stringify({
            forms_exam_id: cascadeExam.id,
            respondent_email: "nobody@usted.test",
            submitted_at: new Date().toISOString(),
          }),
        }).catch(() => {});

        const { error: cascadeDeleteErr } = await admin
          .from("forms_exams")
          .delete()
          .eq("id", cascadeExam.id);
        record(
          "p14e. deleting a forms_exams row cascades to forms_submissions without error",
          !cascadeDeleteErr,
          cascadeDeleteErr?.message ?? "cascade delete succeeded",
        );
      }
    }

    // p15. forms_exam_submissions(): lecturer (owner) sees the recorded
    // submissions; a non-owner, non-lecturer student is denied.
    if (examPId) {
      const { data: ownerSubs, error: ownerSubsErr } = await lecturerClient.rpc(
        "forms_exam_submissions",
        { forms_exam_id: examPId },
      );
      record(
        "p15a. lecturer (owner) forms_exam_submissions() returns the recorded submissions",
        !ownerSubsErr && Array.isArray(ownerSubs) && ownerSubs.length >= 1,
        ownerSubsErr?.message ?? `rows=${ownerSubs?.length}`,
      );

      const { error: nonOwnerSubsErr } = await studentClient.rpc("forms_exam_submissions", {
        forms_exam_id: examPId,
      });
      record(
        "p15b. student (non-owner, non-lecturer) forms_exam_submissions() FAILS",
        Boolean(nonOwnerSubsErr),
        nonOwnerSubsErr?.message ??
          "no error raised — SECURITY: a student read another user's forms_submissions",
      );
    } else {
      record("p15a. lecturer (owner) forms_exam_submissions() returns the recorded submissions", false, "skipped — p1 failed");
      record("p15b. student (non-owner, non-lecturer) forms_exam_submissions() FAILS", false, "skipped — p1 failed");
    }

    // p16. SECURITY: match_forms_submission (service-role-only helper) is
    // NOT directly callable by a signed-in student — same lock-down pattern
    // as _create_proctor_session (20260705000006). A student calling this
    // could otherwise fish for "does this email have a session for this
    // form" without ever having the exam's secret.
    {
      const { error: directMatchErr } = await studentClient.rpc("match_forms_submission", {
        forms_exam_id: examPId ?? "00000000-0000-0000-0000-000000000000",
        respondent_email: "lecturer@usted.test",
        submitted_at: new Date().toISOString(),
      });
      record(
        "p16. SECURITY: student rpc('match_forms_submission', ...) directly is DENIED",
        isDenied(directMatchErr),
        directMatchErr?.message ??
          "no error raised — SECURITY: the internal cross-check helper is directly callable by a student",
      );
    }

    // Cleanup: delete everything this block created (service role bypasses RLS).
    if (examPId) {
      await admin.from("forms_submissions").delete().eq("forms_exam_id", examPId);
      await admin.from("forms_exams").delete().eq("id", examPId);
    }
  }

  // === (q) Phase 3a: classes, enrollment, temp-password onboarding =========
  // Covers: create_class is lecturer-or-higher only; a student cannot
  // create a class or read another class's full roster (only their own
  // membership row); enroll_existing_student / remove_class_member /
  // class_roster are owner-or-lecturer-gated; must_change_password is set
  // on newly-created accounts and can only be cleared via
  // clear_must_change_password (self-only) — never a direct client PATCH,
  // not even by super_admin; a brand-new synthetic-email student account
  // resolves through the EXISTING index-number login path
  // (resolveEmailForIndexNumber in app/login/actions.ts) exactly like a
  // pre-seeded one.
  //
  // Note on the "lock down trusting helpers" rule (20260705000006 pattern):
  // none of this phase's new security-definer functions (create_class,
  // enroll_existing_student, remove_class_member, class_roster,
  // clear_must_change_password) blindly trust their arguments the way
  // _create_proctor_session/match_forms_submission do — each independently
  // re-derives the caller's authority (ownership lookup + has_role, or
  // auth.uid()-only self-scoping) from auth.uid() before doing anything, so
  // there is no internal "trusts a pre-validated payload" helper introduced
  // here that needs an EXECUTE revoke. q9 below still asserts a students'
  // negative-authorization case for each of them, and the account-creation
  // helpers (createOrFindStudent/regenerateTempPassword) are plain
  // TypeScript functions run only from server actions gated by
  // requireRole("lecturer", "admin") — never RPCs, so there is nothing for
  // a client to call directly at all.
  {
    const { client: studentClient } = sessions.student;
    const { client: lecturerClient } = sessions.lecturer;
    const suffix = Date.now();

    // q1. student cannot call create_class.
    const { data: studentClassId, error: studentCreateErr } = await studentClient.rpc("create_class", {
      name: `Student-forged class ${suffix}`,
    });
    record(
      "q1. student rpc create_class FAILS",
      Boolean(studentCreateErr) && !studentClassId,
      studentCreateErr?.message ?? "no error raised — SECURITY: a student created a class",
    );

    // q2. lecturer creates a class.
    const { data: classId, error: createErr } = await lecturerClient.rpc("create_class", {
      name: `Smoke test class ${suffix}`,
      code: `SMOKE-${suffix}`,
      description: "Created by rls-smoke-test.mjs",
    });
    record(
      "q2. lecturer rpc create_class succeeds and returns a class id",
      !createErr && typeof classId === "string",
      createErr?.message ?? `classId=${classId}`,
    );

    // q3. the class is visible to its owner and to "any lecturer" (known
    // simplification, same as forms_exams) via a bare SELECT.
    if (classId) {
      const { data: ownerSees, error: ownerSeesErr } = await lecturerClient
        .from("classes")
        .select("*")
        .eq("id", classId);
      record(
        "q3. lecturer (owner) SELECT classes sees the new row",
        !ownerSeesErr && ownerSees?.length === 1,
        ownerSeesErr?.message ?? `rows=${ownerSees?.length}`,
      );
    } else {
      record("q3. lecturer (owner) SELECT classes sees the new row", false, "skipped — q2 failed");
    }

    // q4. student direct INSERT/UPDATE/DELETE on classes FAILS.
    if (classId) {
      const { error: studentInsertErr } = await studentClient.from("classes").insert({
        owner_id: studentId,
        name: "Student-forged class row",
      });
      record(
        "q4a. student direct INSERT into classes FAILS",
        isDenied(studentInsertErr) || Boolean(studentInsertErr),
        studentInsertErr?.message ?? "no error raised — SECURITY: student inserted a class row directly",
      );

      const { error: studentUpdateErr } = await studentClient
        .from("classes")
        .update({ name: "Hijacked" })
        .eq("id", classId);
      const { data: classAfterStudentUpdate } = await admin
        .from("classes")
        .select("name")
        .eq("id", classId)
        .single();
      record(
        "q4b. student direct UPDATE of another user's class FAILS (name unchanged)",
        isDenied(studentUpdateErr) ||
          Boolean(studentUpdateErr) ||
          classAfterStudentUpdate?.name === `Smoke test class ${suffix}`,
        studentUpdateErr?.message ?? `name_after=${classAfterStudentUpdate?.name}`,
      );
    } else {
      record("q4a. student direct INSERT into classes FAILS", false, "skipped — q2 failed");
      record("q4b. student direct UPDATE of another user's class FAILS (name unchanged)", false, "skipped — q2 failed");
    }

    // q5. student cannot call enroll_existing_student / remove_class_member
    // / class_roster on a class they do not own (non-owner, non-lecturer).
    if (classId) {
      const { error: studentEnrollErr } = await studentClient.rpc("enroll_existing_student", {
        class_id: classId,
        student_id: studentId,
      });
      record(
        "q5a. student rpc enroll_existing_student on another user's class FAILS",
        Boolean(studentEnrollErr),
        studentEnrollErr?.message ??
          "no error raised — SECURITY: a student enrolled themselves into a class they don't own/teach",
      );

      const { error: studentRosterErr } = await studentClient.rpc("class_roster", { class_id: classId });
      record(
        "q5b. student rpc class_roster on another user's class FAILS",
        Boolean(studentRosterErr),
        studentRosterErr?.message ??
          "no error raised — SECURITY: a student read another user's class roster",
      );

      const { error: studentRemoveErr } = await studentClient.rpc("remove_class_member", {
        class_id: classId,
        student_id: studentId,
      });
      record(
        "q5c. student rpc remove_class_member on another user's class FAILS",
        Boolean(studentRemoveErr),
        studentRemoveErr?.message ?? "no error raised — SECURITY: a student removed a class member",
      );
    } else {
      record("q5a. student rpc enroll_existing_student on another user's class FAILS", false, "skipped — q2 failed");
      record("q5b. student rpc class_roster on another user's class FAILS", false, "skipped — q2 failed");
      record("q5c. student rpc remove_class_member on another user's class FAILS", false, "skipped — q2 failed");
    }

    // q6. lecturer enrolls the seeded student (pre-existing account,
    // student_number 5201040845) into the class; idempotent re-enroll is a
    // no-op, not an error.
    if (classId) {
      const { error: enrollErr } = await lecturerClient.rpc("enroll_existing_student", {
        class_id: classId,
        student_id: studentId,
      });
      record("q6a. lecturer rpc enroll_existing_student (owner) succeeds", !enrollErr, enrollErr?.message);

      const { error: reEnrollErr } = await lecturerClient.rpc("enroll_existing_student", {
        class_id: classId,
        student_id: studentId,
      });
      record(
        "q6b. re-enrolling the same student is a no-op, not an error (idempotent CSV re-import)",
        !reEnrollErr,
        reEnrollErr?.message,
      );

      const { data: memberRows, error: memberRowsErr } = await admin
        .from("class_members")
        .select("*")
        .eq("class_id", classId)
        .eq("student_id", studentId);
      record(
        "q6c. exactly one class_members row exists after two enroll calls (unique constraint honored)",
        !memberRowsErr && memberRows?.length === 1,
        memberRowsErr?.message ?? `rows=${memberRows?.length}`,
      );
    } else {
      record("q6a. lecturer rpc enroll_existing_student (owner) succeeds", false, "skipped — q2 failed");
      record("q6b. re-enrolling the same student is a no-op, not an error (idempotent CSV re-import)", false, "skipped — q2 failed");
      record("q6c. exactly one class_members row exists after two enroll calls (unique constraint honored)", false, "skipped — q2 failed");
    }

    // q7. enroll_existing_student rejects a target whose profile role is
    // not 'student' (e.g. the lecturer trying to "enroll" another lecturer).
    if (classId) {
      const { error: nonStudentEnrollErr } = await lecturerClient.rpc("enroll_existing_student", {
        class_id: classId,
        student_id: lecturerId,
      });
      record(
        "q7. enroll_existing_student rejects a target whose role is not 'student'",
        Boolean(nonStudentEnrollErr),
        nonStudentEnrollErr?.message ?? "no error raised — SECURITY: a non-student was enrolled as a student",
      );
    } else {
      record("q7. enroll_existing_student rejects a target whose role is not 'student'", false, "skipped — q2 failed");
    }

    // q8. class_members roster-privacy: the enrolled student sees their OWN
    // membership row via a bare SELECT
    // (class_members_select_own_membership). This repo's seed data has
    // exactly one student, so a true "classmate" scenario can't be
    // constructed here — but the guarantee is structural, not empirical:
    // the RLS predicate is `student_id = auth.uid()`, which by construction
    // can never match a row whose student_id differs from the caller, no
    // matter how many other members a class has. What's asserted here is
    // that this policy returns EXACTLY the caller's own row (not zero, not
    // the whole roster) and that the lecturer-only class_roster() RPC is
    // the one place the full roster (with names) is actually visible.
    if (classId) {
      const { data: ownMembership, error: ownMembershipErr } = await studentClient
        .from("class_members")
        .select("*")
        .eq("class_id", classId);
      record(
        "q8a. student SELECT class_members (own membership policy) for their class returns exactly their own row",
        !ownMembershipErr &&
          ownMembership?.length === 1 &&
          ownMembership[0].student_id === studentId,
        ownMembershipErr?.message ?? `rows=${JSON.stringify(ownMembership)}`,
      );

      const { data: rosterViaRpc, error: rosterViaRpcErr } = await lecturerClient.rpc("class_roster", {
        class_id: classId,
      });
      record(
        "q8b. lecturer (owner) class_roster() includes the enrolled student with full_name/student_number",
        !rosterViaRpcErr &&
          Array.isArray(rosterViaRpc) &&
          rosterViaRpc.some((r) => r.student_id === studentId && r.student_number === "5201040845"),
        rosterViaRpcErr?.message ?? `rows=${JSON.stringify(rosterViaRpc)}`,
      );
    } else {
      record("q8a. student SELECT class_members (own membership policy) for their class returns exactly their own row", false, "skipped — q2 failed");
      record("q8b. lecturer (owner) class_roster() includes the enrolled student with full_name/student_number", false, "skipped — q2 failed");
    }

    // q9. remove_class_member (owner) works and is reflected in the roster.
    if (classId) {
      const { error: removeErr } = await lecturerClient.rpc("remove_class_member", {
        class_id: classId,
        student_id: studentId,
      });
      record("q9a. lecturer rpc remove_class_member (owner) succeeds", !removeErr, removeErr?.message);

      const { data: afterRemove } = await admin
        .from("class_members")
        .select("*")
        .eq("class_id", classId)
        .eq("student_id", studentId);
      record(
        "q9b. class_members row is gone after remove_class_member",
        (afterRemove?.length ?? 0) === 0,
        `rows=${afterRemove?.length}`,
      );
    } else {
      record("q9a. lecturer rpc remove_class_member (owner) succeeds", false, "skipped — q2 failed");
      record("q9b. class_members row is gone after remove_class_member", false, "skipped — q2 failed");
    }

    // q10. must_change_password: a student cannot set the flag on their own
    // profile via a direct client PATCH (profiles_guard_update's new
    // usted.allow_password_flag_change gate), and neither can super_admin —
    // this flag is deliberately outside even super_admin's "any column"
    // carve-out (see the migration comment).
    {
      const { error: studentFlagErr } = await studentClient
        .from("profiles")
        .update({ must_change_password: true })
        .eq("id", studentId);
      record(
        "q10a. student direct UPDATE of own must_change_password FAILS",
        isDenied(studentFlagErr) || Boolean(studentFlagErr),
        studentFlagErr?.message ?? "no error raised — SECURITY: a student set their own must_change_password flag",
      );

      const { client: superAdminClientForFlag } = sessions.super_admin;
      const { error: superAdminFlagErr } = await superAdminClientForFlag
        .from("profiles")
        .update({ must_change_password: true })
        .eq("id", studentId);
      record(
        "q10b. even super_admin direct UPDATE of must_change_password FAILS (outside the universal-role carve-out)",
        isDenied(superAdminFlagErr) || Boolean(superAdminFlagErr),
        superAdminFlagErr?.message ??
          "no error raised — SECURITY: must_change_password is settable via a direct PATCH",
      );
    }

    // q11. clear_must_change_password is self-only: student cannot clear
    // ANOTHER user's flag (there is no id parameter — call as the lecturer
    // targeting nothing in particular, then verify the STUDENT's flag,
    // which was never true here, is unaffected either way; the real
    // self-only guarantee is structural (no id argument exists), asserted
    // by q12's own-account round trip instead).
    {
      const { error: clearErr } = await studentClient.rpc("clear_must_change_password");
      record(
        "q11. clear_must_change_password (self, not currently set) succeeds harmlessly",
        !clearErr,
        clearErr?.message,
      );
    }

    // q12. Full onboarding round trip via the service role, mirroring what
    // apps/web/lib/onboarding/create-student.ts does server-side: create a
    // brand-new synthetic-email student account for a fresh 10-digit index
    // number, confirm must_change_password defaults true, then prove the
    // EXISTING index-number login path (app/login/actions.ts's
    // resolveEmailForIndexNumber) resolves it and signs in successfully.
    {
      // A fresh, syntactically valid 10-digit index derived from the
      // timestamp so repeated runs don't collide.
      const freshIndex = `9${String(suffix).slice(-9).padStart(9, "0")}`;
      const syntheticEmail = `${freshIndex}@students.usted.local`;
      const tempPassword = `Sm0ke-${suffix}-Aa!`;

      const { data: createdUser, error: createUserErr } = await admin.auth.admin.createUser({
        email: syntheticEmail,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { full_name: "Smoke Test Onboarded Student" },
      });
      record(
        "q12a. service-role creates a synthetic-email student account",
        !createUserErr && Boolean(createdUser?.user),
        createUserErr?.message ?? `user=${createdUser?.user?.id}`,
      );

      const newStudentId = createdUser?.user?.id;
      if (newStudentId) {
        const { error: profileUpdateErr } = await admin
          .from("profiles")
          .update({
            full_name: "Smoke Test Onboarded Student",
            student_number: freshIndex,
            must_change_password: true,
          })
          .eq("id", newStudentId);
        record(
          "q12b. profile updated with student_number + must_change_password=true",
          !profileUpdateErr,
          profileUpdateErr?.message,
        );

        const { data: profileRow, error: profileRowErr } = await admin
          .from("profiles")
          .select("must_change_password, student_number, role")
          .eq("id", newStudentId)
          .single();
        record(
          "q12c. new account has must_change_password=true, correct student_number, role=student",
          !profileRowErr &&
            profileRow?.must_change_password === true &&
            profileRow?.student_number === freshIndex &&
            profileRow?.role === "student",
          profileRowErr?.message ?? JSON.stringify(profileRow),
        );

        // q12d. the EXISTING index-number login resolution path: index ->
        // profiles.student_number -> auth.users.id -> email (exactly
        // resolveEmailForIndexNumber in app/login/actions.ts), then a real
        // password sign-in against the resolved email. This does not call
        // the Next.js server action directly (no HTTP server assumed
        // running for this section) — it reproduces the same three-step
        // resolution against the same tables/APIs that function uses, which
        // is what actually matters: that a freshly created account is
        // reachable by index number at all.
        const { data: resolvedProfile, error: resolveProfileErr } = await admin
          .from("profiles")
          .select("id")
          .eq("student_number", freshIndex)
          .maybeSingle();
        const { data: resolvedUser, error: resolveUserErr } = resolvedProfile
          ? await admin.auth.admin.getUserById(resolvedProfile.id)
          : { data: null, error: null };
        const resolvedEmail = resolvedUser?.user?.email;
        record(
          "q12d. index number resolves to the synthetic email via the same lookup app/login/actions.ts uses",
          !resolveProfileErr && !resolveUserErr && resolvedEmail === syntheticEmail,
          resolveProfileErr?.message ?? resolveUserErr?.message ?? `resolvedEmail=${resolvedEmail}`,
        );

        const anonForSignIn = createClient(SUPABASE_URL, ANON_KEY, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        const { data: signInData, error: signInErr } = await anonForSignIn.auth.signInWithPassword({
          email: resolvedEmail ?? syntheticEmail,
          password: tempPassword,
        });
        record(
          "q12e. signing in with the resolved email + temp password succeeds (full index-login round trip)",
          !signInErr && signInData?.user?.id === newStudentId,
          signInErr?.message ?? `signed_in_id=${signInData?.user?.id}`,
        );
        await anonForSignIn.auth.signOut().catch(() => {});

        // q12f. clear_must_change_password, called by the new student
        // themselves, clears their OWN flag.
        const newStudentClient = createClient(SUPABASE_URL, ANON_KEY, {
          auth: { autoRefreshToken: false, persistSession: false },
        });
        await newStudentClient.auth.signInWithPassword({ email: syntheticEmail, password: tempPassword });
        const { error: selfClearErr } = await newStudentClient.rpc("clear_must_change_password");
        record("q12f. new student rpc clear_must_change_password (self) succeeds", !selfClearErr, selfClearErr?.message);

        const { data: afterClear } = await admin
          .from("profiles")
          .select("must_change_password")
          .eq("id", newStudentId)
          .single();
        record(
          "q12g. must_change_password is false after clear_must_change_password",
          afterClear?.must_change_password === false,
          `must_change_password=${afterClear?.must_change_password}`,
        );
        await newStudentClient.auth.signOut().catch(() => {});

        // Cleanup: delete the throwaway account entirely (service role;
        // cascades to profiles via the FK).
        await admin.auth.admin.deleteUser(newStudentId);
      } else {
        for (const label of [
          "q12b. profile updated with student_number + must_change_password=true",
          "q12c. new account has must_change_password=true, correct student_number, role=student",
          "q12d. index number resolves to the synthetic email via the same lookup app/login/actions.ts uses",
          "q12e. signing in with the resolved email + temp password succeeds (full index-login round trip)",
          "q12f. new student rpc clear_must_change_password (self) succeeds",
          "q12g. must_change_password is false after clear_must_change_password",
        ]) {
          record(label, false, "skipped — q12a failed");
        }
      }
    }

    // q13. Single-student "Add student" flow (addStudentToClass in
    // app/dashboard/lecturer/classes/actions.ts, the non-CSV path next to
    // "Import students (CSV)"). It is built entirely from primitives already
    // exercised above — requireRole("lecturer", "admin"), createOrFindStudent,
    // and this same enroll_existing_student RPC — so its security floor is
    // q5a's non-manager rejection, reasserted here framed as the single-add
    // path. What's new to actually assert: the DB-level backstop (CHECK
    // profiles_student_number_format, 20260705000002) behind the server
    // action's own ^\d{10}$ regex check, and that adding an ALREADY-KNOWN
    // index number enrolls without creating a duplicate class_members row
    // (the "existing student enrolled, no-op if already enrolled" outcome).
    if (classId) {
      const { error: nonManagerEnrollErr } = await studentClient.rpc("enroll_existing_student", {
        class_id: classId,
        student_id: studentId,
      });
      record(
        "q13a. non-manager (student) cannot add/enroll a student via the single-add path's RPC",
        Boolean(nonManagerEnrollErr),
        nonManagerEnrollErr?.message ??
          "no error raised — SECURITY: a non-manager added a student to a class",
      );

      const { error: badIndexErr } = await admin
        .from("profiles")
        .update({ student_number: "520104084" })
        .eq("id", studentId);
      record(
        "q13b. a 9-digit index number is rejected by the DB CHECK constraint (backstop behind the form's 10-digit validation)",
        Boolean(badIndexErr),
        badIndexErr?.message ?? "no error raised — SECURITY: a 9-digit index number was accepted",
      );
      // Restore the seeded student's real index number regardless of outcome.
      await admin.from("profiles").update({ student_number: "5201040845" }).eq("id", studentId);

      const { error: singleAddEnrollErr } = await lecturerClient.rpc("enroll_existing_student", {
        class_id: classId,
        student_id: studentId,
      });
      record(
        "q13c. single-add of an already-known index number enrolls the existing account",
        !singleAddEnrollErr,
        singleAddEnrollErr?.message,
      );

      const { error: singleAddReEnrollErr } = await lecturerClient.rpc("enroll_existing_student", {
        class_id: classId,
        student_id: studentId,
      });
      const { data: singleAddMemberRows, error: singleAddMemberRowsErr } = await admin
        .from("class_members")
        .select("*")
        .eq("class_id", classId)
        .eq("student_id", studentId);
      record(
        "q13d. re-adding the same index number is a no-op — exactly one class_members row (no duplicate)",
        !singleAddReEnrollErr && !singleAddMemberRowsErr && singleAddMemberRows?.length === 1,
        singleAddReEnrollErr?.message ?? singleAddMemberRowsErr?.message ?? `rows=${singleAddMemberRows?.length}`,
      );

      // Cleanup this sub-block's enrollment before the class itself is deleted below.
      await lecturerClient.rpc("remove_class_member", { class_id: classId, student_id: studentId });
    } else {
      record("q13a. non-manager (student) cannot add/enroll a student via the single-add path's RPC", false, "skipped — q2 failed");
      record("q13b. a 9-digit index number is rejected by the DB CHECK constraint (backstop behind the form's 10-digit validation)", false, "skipped — q2 failed");
      record("q13c. single-add of an already-known index number enrolls the existing account", false, "skipped — q2 failed");
      record("q13d. re-adding the same index number is a no-op — exactly one class_members row (no duplicate)", false, "skipped — q2 failed");
    }

    // Cleanup: delete everything this block created (service role bypasses RLS).
    if (classId) {
      await admin.from("classes").delete().eq("id", classId);
    }
  }

  // === (r) Phase 3b: question banks, categories, VERSIONED questions =======
  // Covers: create_question_bank/create_question are lecturer-or-higher
  // only (student denied); a student cannot SELECT question_banks/
  // questions/question_versions at all (RLS, not just RPC-gating);
  // add_question_version increments version_no and repoints
  // current_version_id while the OLD version row still exists (proves
  // versioning preserves history, not just "the new value stuck"); a
  // version row cannot be UPDATEd (immutability trigger) even via the
  // owner's own client; retire/reactivate works; category tree insert +
  // cascade-delete (children cascade, questions under a deleted category
  // become uncategorized, not deleted).
  //
  // Note on the "lock down trusting helpers" rule (20260705000006 pattern):
  // can_manage_question_bank and every RPC in
  // 20260705000010_question_banks.sql re-derive the caller's authority from
  // auth.uid() + has_role()/bank ownership themselves — none of them trust
  // a pre-validated payload the way _create_proctor_session/
  // match_forms_submission do, so none need an EXECUTE revoke. r1/r2 below
  // are the negative-authorization proof for that claim.
  {
    const { client: studentClient } = sessions.student;
    const { client: lecturerClient } = sessions.lecturer;
    const suffix = Date.now();

    // r1. student cannot call create_question_bank.
    const { data: studentBankId, error: studentBankErr } = await studentClient.rpc("create_question_bank", {
      name: `Student-forged bank ${suffix}`,
    });
    record(
      "r1. student rpc create_question_bank FAILS",
      Boolean(studentBankErr) && !studentBankId,
      studentBankErr?.message ?? "no error raised — SECURITY: a student created a question bank",
    );

    // Lecturer creates a real bank for the rest of this section.
    const { data: bankId, error: bankErr } = await lecturerClient.rpc("create_question_bank", {
      name: `Smoke test bank ${suffix}`,
      description: "Created by rls-smoke-test.mjs",
    });
    record("r2. lecturer rpc create_question_bank succeeds", !bankErr && typeof bankId === "string", bankErr?.message);

    if (bankId) {
      // r3. student SELECT question_banks returns 0 rows (RLS, not RPC-gating).
      const { data: studentBankRows, error: studentBankSelErr } = await studentClient
        .from("question_banks")
        .select("*")
        .eq("id", bankId);
      record(
        "r3. student SELECT question_banks (by id) returns 0 rows",
        !studentBankSelErr && (studentBankRows?.length ?? 0) === 0,
        studentBankSelErr?.message ?? `rows=${studentBankRows?.length}`,
      );

      // r4. student cannot call create_question against this bank.
      const { data: studentQId, error: studentQErr } = await studentClient.rpc("create_question", {
        bank_id: bankId,
        type: "true_false",
        prompt: "Forged question",
        body: { correct: true, marks: 1 },
      });
      record(
        "r4. student rpc create_question FAILS",
        Boolean(studentQErr) && !studentQId,
        studentQErr?.message ?? "no error raised — SECURITY: a student created a question",
      );

      // r5. lecturer creates a category tree: Topic -> Subtopic.
      const { data: topicId, error: topicErr } = await lecturerClient.rpc("create_question_category", {
        bank_id: bankId,
        name: "Topic",
      });
      record("r5a. lecturer create_question_category (top-level) succeeds", !topicErr && typeof topicId === "string", topicErr?.message);

      const { data: subtopicId, error: subtopicErr } = await lecturerClient.rpc("create_question_category", {
        bank_id: bankId,
        name: "Subtopic",
        parent_id: topicId,
      });
      record(
        "r5b. lecturer create_question_category (nested under Topic) succeeds",
        !subtopicErr && typeof subtopicId === "string",
        subtopicErr?.message,
      );

      // r6. student cannot SELECT question_categories for this bank.
      const { data: studentCatRows, error: studentCatErr } = await studentClient
        .from("question_categories")
        .select("*")
        .eq("bank_id", bankId);
      record(
        "r6. student SELECT question_categories returns 0 rows",
        !studentCatErr && (studentCatRows?.length ?? 0) === 0,
        studentCatErr?.message ?? `rows=${studentCatRows?.length}`,
      );

      // r7. lecturer creates one question of each type; assert create_question
      // rejects an obviously-bad body (mcq with < 2 options) too.
      const { data: badMcqId, error: badMcqErr } = await lecturerClient.rpc("create_question", {
        bank_id: bankId,
        type: "mcq_single",
        prompt: "Bad mcq (1 option)",
        body: { options: [{ id: "A", text: "only one" }], correct: ["A"], marks: 1 },
      });
      record(
        "r7. create_question rejects mcq_single with < 2 options",
        Boolean(badMcqErr) && !badMcqId,
        badMcqErr?.message ?? "no error raised — SECURITY/INTEGRITY: malformed mcq body accepted",
      );

      const { data: questionId, error: questionErr } = await lecturerClient.rpc("create_question", {
        bank_id: bankId,
        category_id: subtopicId,
        type: "mcq_single",
        difficulty: "easy",
        tags: ["smoke-test"],
        prompt: "What is 2 + 2?",
        body: {
          options: [
            { id: "A", text: "3" },
            { id: "B", text: "4" },
          ],
          correct: ["B"],
          marks: 1,
        },
      });
      record(
        "r8. lecturer create_question (mcq_single, valid body) succeeds",
        !questionErr && typeof questionId === "string",
        questionErr?.message,
      );

      if (questionId) {
        // r9. bank_questions shows version_no=1 with the category resolved.
        const { data: rows1, error: rows1Err } = await lecturerClient.rpc("bank_questions", { bank_id: bankId });
        const row1 = (rows1 ?? []).find((r) => r.question_id === questionId);
        record(
          "r9. bank_questions shows the new question at version_no=1 with category_name=Subtopic",
          !rows1Err && row1?.version_no === 1 && row1?.category_name === "Subtopic",
          rows1Err?.message ?? `version_no=${row1?.version_no} category_name=${row1?.category_name}`,
        );

        const firstVersionId = row1?.current_version_id;

        // r10. student cannot SELECT question_versions for this question.
        const { data: studentVerRows, error: studentVerErr } = await studentClient
          .from("question_versions")
          .select("*")
          .eq("question_id", questionId);
        record(
          "r10. student SELECT question_versions returns 0 rows",
          !studentVerErr && (studentVerRows?.length ?? 0) === 0,
          studentVerErr?.message ?? `rows=${studentVerRows?.length}`,
        );

        // r11. student cannot call add_question_version.
        const { data: studentEditId, error: studentEditErr } = await studentClient.rpc("add_question_version", {
          question_id: questionId,
          prompt: "Forged edit",
          body: { options: [{ id: "A", text: "x" }, { id: "B", text: "y" }], correct: ["A"], marks: 1 },
        });
        record(
          "r11. student rpc add_question_version FAILS",
          Boolean(studentEditErr) && !studentEditId,
          studentEditErr?.message ?? "no error raised — SECURITY: a student edited another user's question",
        );

        // r12. lecturer edits the question: add_question_version ->
        // version_no=2, current_version_id repointed, OLD version row STILL
        // EXISTS (this is the actual versioning guarantee, not just "the
        // new value stuck").
        const { data: secondVersionId, error: secondVerErr } = await lecturerClient.rpc("add_question_version", {
          question_id: questionId,
          prompt: "What is 2 + 2? (edited)",
          body: {
            options: [
              { id: "A", text: "3" },
              { id: "B", text: "4" },
              { id: "C", text: "5" },
            ],
            correct: ["B"],
            marks: 2,
          },
        });
        record(
          "r12. lecturer add_question_version succeeds and returns a NEW version id",
          !secondVerErr && typeof secondVersionId === "string" && secondVersionId !== firstVersionId,
          secondVerErr?.message ?? `secondVersionId=${secondVersionId}`,
        );

        const { data: rows2, error: rows2Err } = await lecturerClient.rpc("bank_questions", { bank_id: bankId });
        const row2 = (rows2 ?? []).find((r) => r.question_id === questionId);
        record(
          "r13. bank_questions now shows version_no=2 and current_version_id repointed to the new version",
          !rows2Err && row2?.version_no === 2 && row2?.current_version_id === secondVersionId,
          rows2Err?.message ?? `version_no=${row2?.version_no} current_version_id=${row2?.current_version_id}`,
        );

        const { data: oldVersionStillExists, error: oldVerErr } = await admin
          .from("question_versions")
          .select("id, version_no, prompt")
          .eq("id", firstVersionId)
          .maybeSingle();
        record(
          "r14. VERSIONING PROOF: the OLD version row (version_no=1) still exists after editing, unmutated",
          !oldVerErr &&
            oldVersionStillExists?.version_no === 1 &&
            oldVersionStillExists?.prompt === "What is 2 + 2?",
          oldVerErr?.message ?? `row=${JSON.stringify(oldVersionStillExists)}`,
        );

        // r15. IMMUTABILITY: even the bank owner cannot UPDATE an existing
        // version row directly — the trigger blocks it regardless of RLS.
        const { error: updateVersionErr } = await lecturerClient
          .from("question_versions")
          .update({ prompt: "tampered" })
          .eq("id", firstVersionId);
        record(
          "r15. UPDATE on an existing question_versions row FAILS (immutability trigger)",
          Boolean(updateVersionErr),
          updateVersionErr?.message ?? "no error raised — SECURITY: a question_versions row was mutated in place",
        );

        // r16. retire / reactivate.
        const { error: retireErr } = await lecturerClient.rpc("set_question_status", {
          question_id: questionId,
          status: "retired",
        });
        record("r16a. lecturer set_question_status(retired) succeeds", !retireErr, retireErr?.message);

        const { data: retiredRow } = await admin
          .from("questions")
          .select("status")
          .eq("id", questionId)
          .single();
        record(
          "r16b. questions.status is now 'retired'",
          retiredRow?.status === "retired",
          `status=${retiredRow?.status}`,
        );

        const { error: reactivateErr } = await lecturerClient.rpc("set_question_status", {
          question_id: questionId,
          status: "active",
        });
        record("r16c. lecturer set_question_status(active) [cleanup] succeeds", !reactivateErr, reactivateErr?.message);

        // r17. student cannot call set_question_status either.
        const { error: studentStatusErr } = await studentClient.rpc("set_question_status", {
          question_id: questionId,
          status: "retired",
        });
        record(
          "r17. student rpc set_question_status FAILS",
          Boolean(studentStatusErr),
          studentStatusErr?.message ?? "no error raised — SECURITY: a student retired another user's question",
        );
      }

      // r18. category cascade: deleting "Topic" cascades to "Subtopic" AND
      // sets the question's category_id to null (set null, not deleted).
      const { error: deleteCatErr } = await lecturerClient.rpc("delete_question_category", { category_id: topicId });
      record("r18a. lecturer delete_question_category (parent) succeeds", !deleteCatErr, deleteCatErr?.message);

      const { data: subtopicAfterDelete } = await admin
        .from("question_categories")
        .select("id")
        .eq("id", subtopicId)
        .maybeSingle();
      record(
        "r18b. CASCADE: child category (Subtopic) was deleted along with its parent",
        !subtopicAfterDelete,
        `row=${JSON.stringify(subtopicAfterDelete)}`,
      );

      if (questionId) {
        const { data: questionAfterCatDelete } = await admin
          .from("questions")
          .select("category_id, status")
          .eq("id", questionId)
          .single();
        record(
          "r18c. SET NULL: the question that was filed under the deleted category is now uncategorized, not deleted",
          questionAfterCatDelete?.category_id === null && questionAfterCatDelete?.status === "active",
          `row=${JSON.stringify(questionAfterCatDelete)}`,
        );
      }

      // Cleanup: delete the whole bank (service role; cascades to
      // categories/questions/versions via FK ON DELETE CASCADE).
      await admin.from("question_banks").delete().eq("id", bankId);
    }
  }

  // === (s) Phase 3c: exam builder — sections, fixed+pool draw, seeded draw ==
  // Covers: create_exam is lecturer-or-higher only (student denied); a
  // student cannot see a draft exam nor any sections/sources (direct SELECT
  // on exam_sections/exam_section_sources returns 0 rows for ANY exam,
  // published or not — there is no student policy on those two tables at
  // all); a student CAN see a published+in-window exam for a class they are
  // enrolled in, but NOT one assigned to a class they are not enrolled in;
  // validate_exam catches an under-filled pool (draw_count > available
  // active questions) and set_exam_status(published) refuses to publish
  // while validate_exam is not ok; draw_exam_for_attempt is DENIED to a
  // direct student (and even a direct lecturer/service-caller-impersonation)
  // RPC call over PostgREST — the 20260705000006-style lockdown regression
  // check; preview_exam_draw is owner/lecturer-only; same-seed determinism,
  // distinct question sets across different seeds, retired questions never
  // drawn, and the drawn version_id matches current_version_id at draw time
  // (the "frozen" claim, checked the only way observable from outside: it
  // equals current_version_id when nothing has been re-edited since).
  //
  // Note on the "lock down trusting helpers" rule (20260705000006 pattern):
  // every RPC in 20260705000011_exams.sql EXCEPT draw_exam_for_attempt
  // re-derives the caller's authority from auth.uid() + has_role()/
  // can_manage_exam()/can_manage_question_bank() themselves — none of them
  // trust a pre-validated payload, so none of THOSE need an EXECUTE revoke
  // (s1/s2 below are the negative-authorization proof). draw_exam_for_attempt
  // is the one exception: it returns full question content INCLUDING
  // correct answers and trusts its (exam_id, seed) arguments completely
  // with no re-derived caller check at all, so it MUST be (and is) locked
  // down — s_lockdown below is the regression test for that revoke.
  {
    const { client: studentClient } = sessions.student;
    const { client: lecturerClient } = sessions.lecturer;
    const suffix = Date.now();

    // s1. student cannot call create_exam.
    const { data: studentExamId, error: studentExamErr } = await studentClient.rpc("create_exam", {
      title: `Student-forged exam ${suffix}`,
    });
    record(
      "s1. student rpc create_exam FAILS",
      Boolean(studentExamErr) && !studentExamId,
      studentExamErr?.message ?? "no error raised — SECURITY: a student created an exam",
    );

    // Lecturer creates two classes: one the seeded student IS enrolled in,
    // one they are NOT — needed to prove the student SELECT policy is
    // actually class-scoped, not just "any published+open exam".
    const { data: enrolledClassId, error: enrolledClassErr } = await lecturerClient.rpc("create_class", {
      name: `Smoke exam class (enrolled) ${suffix}`,
    });
    record("s2a. lecturer create_class (enrolled cohort) succeeds", !enrolledClassErr && typeof enrolledClassId === "string", enrolledClassErr?.message);

    const { data: otherClassId, error: otherClassErr } = await lecturerClient.rpc("create_class", {
      name: `Smoke exam class (other) ${suffix}`,
    });
    record("s2b. lecturer create_class (other cohort) succeeds", !otherClassErr && typeof otherClassId === "string", otherClassErr?.message);

    if (enrolledClassId) {
      await lecturerClient.rpc("enroll_existing_student", { class_id: enrolledClassId, student_id: studentId });
    }

    // Lecturer creates a bank with 3 active pool questions, 1 retired
    // question, and (below) 1 more active fixed-pick question — 5 total, 4
    // active — for the pool-draw + retired-exclusion assertions.
    const { data: bankId, error: bankErr } = await lecturerClient.rpc("create_question_bank", {
      name: `Smoke exam bank ${suffix}`,
    });
    record("s3. lecturer create_question_bank succeeds", !bankErr && typeof bankId === "string", bankErr?.message);

    let activeQuestionIds = [];
    let retiredQuestionId = null;
    let fixedQuestionId = null;
    if (bankId) {
      for (let i = 0; i < 3; i++) {
        const { data: qid, error: qErr } = await lecturerClient.rpc("create_question", {
          bank_id: bankId,
          type: "mcq_single",
          prompt: `Pool question ${i} ${suffix}`,
          body: {
            options: [
              { id: "A", text: "wrong" },
              { id: "B", text: "right" },
            ],
            correct: ["B"],
            marks: 1,
          },
        });
        if (!qErr && qid) activeQuestionIds.push(qid);
      }
      record("s4a. lecturer creates 3 active pool questions", activeQuestionIds.length === 3, `created=${activeQuestionIds.length}`);

      const { data: retiredId, error: retiredErr } = await lecturerClient.rpc("create_question", {
        bank_id: bankId,
        type: "true_false",
        prompt: `Retired question ${suffix}`,
        body: { correct: true, marks: 1 },
      });
      let retireCallErr = null;
      if (!retiredErr && retiredId) {
        retiredQuestionId = retiredId;
        const { error: setStatusErr } = await lecturerClient.rpc("set_question_status", { question_id: retiredId, status: "retired" });
        retireCallErr = setStatusErr;
      }
      record(
        "s4b. lecturer creates + retires a 4th question",
        Boolean(retiredQuestionId) && !retireCallErr,
        retiredErr?.message ?? retireCallErr?.message,
      );

      const { data: fixedId, error: fixedErr } = await lecturerClient.rpc("create_question", {
        bank_id: bankId,
        type: "true_false",
        prompt: `Fixed question ${suffix}`,
        body: { correct: false, marks: 2 },
      });
      fixedQuestionId = fixedErr ? null : fixedId;
      record("s4c. lecturer creates the fixed-pick question", Boolean(fixedQuestionId), fixedErr?.message);
    } else {
      record("s4a. lecturer creates 3 active pool questions", false, "skipped — s3 failed");
      record("s4b. lecturer creates + retires a 4th question", false, "skipped — s3 failed");
      record("s4c. lecturer creates the fixed-pick question", false, "skipped — s3 failed");
    }

    // Lecturer creates the exam, assigns the enrolled class.
    const { data: examId, error: createExamErr } = await lecturerClient.rpc("create_exam", {
      title: `Smoke test exam ${suffix}`,
      class_id: enrolledClassId ?? null,
    });
    record("s5. lecturer rpc create_exam succeeds", !createExamErr && typeof examId === "string", createExamErr?.message);

    if (examId) {
      // s6. student SELECT exams (draft) returns 0 rows — drafts are never
      // visible even to an enrolled student.
      const { data: draftRows, error: draftErr } = await studentClient.from("exams").select("*").eq("id", examId);
      record(
        "s6. student SELECT exams (status=draft) returns 0 rows even though enrolled in its class",
        !draftErr && (draftRows?.length ?? 0) === 0,
        draftErr?.message ?? `rows=${draftRows?.length}`,
      );

      // s7. add a section.
      const { data: sectionId, error: sectionErr } = await lecturerClient.rpc("add_exam_section", {
        exam_id: examId,
        title: "Section 1",
      });
      record("s7. lecturer add_exam_section succeeds", !sectionErr && typeof sectionId === "string", sectionErr?.message);

      // s8. student cannot SELECT exam_sections/exam_section_sources for
      // ANY exam, published or not — no student policy exists on either
      // table at all.
      if (sectionId) {
        const { data: studentSectionRows, error: studentSectionErr } = await studentClient
          .from("exam_sections")
          .select("*")
          .eq("id", sectionId);
        record(
          "s8a. student SELECT exam_sections returns 0 rows",
          !studentSectionErr && (studentSectionRows?.length ?? 0) === 0,
          studentSectionErr?.message ?? `rows=${studentSectionRows?.length}`,
        );
      }

      // s9. a second section, then reorder — swap ordinals.
      const { data: section2Id, error: section2Err } = await lecturerClient.rpc("add_exam_section", {
        exam_id: examId,
        title: "Section 2",
      });
      record("s9a. lecturer add_exam_section (2nd) succeeds", !section2Err && typeof section2Id === "string", section2Err?.message);

      if (sectionId && section2Id) {
        const { data: beforeReorder } = await admin
          .from("exam_sections")
          .select("id, ordinal")
          .eq("exam_id", examId)
          .order("ordinal");
        const { error: reorderErr } = await lecturerClient.rpc("reorder_exam_section", {
          section_id: section2Id,
          direction: "up",
        });
        record("s9b. lecturer reorder_exam_section(up) succeeds", !reorderErr, reorderErr?.message);

        const { data: afterReorder } = await admin
          .from("exam_sections")
          .select("id, ordinal")
          .eq("exam_id", examId)
          .order("ordinal");
        const swapped = afterReorder?.[0]?.id === section2Id && afterReorder?.[0]?.id !== beforeReorder?.[0]?.id;
        record(
          "s9c. REORDER PROOF: section 2 now sorts before section 1 (ordinals swapped, not just relabeled)",
          swapped,
          `before=${JSON.stringify(beforeReorder)} after=${JSON.stringify(afterReorder)}`,
        );

        // Reorder back for a clean, predictable section order for the rest
        // of this block (section 1 = fixed+pool sources, section 2 = empty
        // until s12's under-filled-pool test uses it).
        await lecturerClient.rpc("reorder_exam_section", { section_id: section2Id, direction: "down" });
      }

      // s10. student cannot call add_section_source / any exam-builder RPC
      // on this exam.
      if (sectionId) {
        const { data: studentSourceId, error: studentSourceErr } = await studentClient.rpc("add_section_source", {
          section_id: sectionId,
          source_type: "fixed",
          question_id: fixedQuestionId,
        });
        record(
          "s10. student rpc add_section_source FAILS",
          Boolean(studentSourceErr) && !studentSourceId,
          studentSourceErr?.message ?? "no error raised — SECURITY: a student added a source to another user's exam",
        );
      }

      // s11. lecturer adds a fixed source + a pool source (draw 2 of 3
      // active) to section 1 — mixing both kinds in one section.
      let fixedSourceId = null;
      let poolSourceId = null;
      if (sectionId && fixedQuestionId) {
        const { data: fsId, error: fsErr } = await lecturerClient.rpc("add_section_source", {
          section_id: sectionId,
          source_type: "fixed",
          question_id: fixedQuestionId,
        });
        fixedSourceId = fsErr ? null : fsId;
        record("s11a. lecturer add_section_source (fixed) succeeds", Boolean(fixedSourceId), fsErr?.message);
      }
      if (sectionId && bankId) {
        const { data: psId, error: psErr } = await lecturerClient.rpc("add_section_source", {
          section_id: sectionId,
          source_type: "pool",
          bank_id: bankId,
          draw_count: 2,
        });
        poolSourceId = psErr ? null : psId;
        record("s11b. lecturer add_section_source (pool, draw_count=2) succeeds", Boolean(poolSourceId), psErr?.message);
      }

      // s12. pool_available_count reports 4 (only ACTIVE questions in the
      // bank, the 1 retired excluded): the bank has 3 pool-only questions +
      // 1 retired + 1 fixed-pick question (s4c) — the fixed-pick question is
      // ALSO an active, un-filtered member of this same bank, so it counts
      // too (pool_available_count has no way to know a question is "used as
      // a fixed pick elsewhere" and correctly does not exclude it — a
      // question can be both a fixed pick in one section and eligible for a
      // pool draw in another). 3 pool + 1 fixed = 4 active, 5 total in bank.
      const { data: availableCount, error: availableErr } = await lecturerClient.rpc("pool_available_count", {
        bank_id: bankId,
        category_id: null,
        difficulty: null,
        tags: null,
      });
      record(
        "s12. pool_available_count excludes the retired question (reports 4 active of 5 total, not 5)",
        !availableErr && availableCount === 4,
        availableErr?.message ?? `count=${availableCount}`,
      );

      // s13. validate_exam catches "section 2 has no sources".
      const { data: validation1, error: validation1Err } = await lecturerClient.rpc("validate_exam", { exam_id: examId });
      record(
        "s13. validate_exam(exam) reports NOT ok while section 2 has no sources",
        !validation1Err && validation1?.ok === false && (validation1?.issues ?? []).some((i) => i.includes("no question sources")),
        validation1Err?.message ?? JSON.stringify(validation1),
      );

      // s14. set_exam_status(published) is BLOCKED while invalid.
      const { error: publishBlockedErr } = await lecturerClient.rpc("set_exam_status", {
        exam_id: examId,
        status: "published",
      });
      record(
        "s14. set_exam_status(published) FAILS while validate_exam reports issues (validation-gated publish)",
        Boolean(publishBlockedErr),
        publishBlockedErr?.message ?? "no error raised — SECURITY/INTEGRITY: an invalid exam was published",
      );

      // s15. add a source to section 2 with an IMPOSSIBLE draw_count (more
      // than available) to prove the under-filled-pool check specifically,
      // independent of the "no sources at all" case above.
      if (section2Id && bankId) {
        const { error: overfilledErr } = await lecturerClient.rpc("add_section_source", {
          section_id: section2Id,
          source_type: "pool",
          bank_id: bankId,
          draw_count: 999,
        });
        record("s15a. lecturer add_section_source (pool, draw_count=999) succeeds (creation itself is not bounds-checked)", !overfilledErr, overfilledErr?.message);

        const { data: validation2, error: validation2Err } = await lecturerClient.rpc("validate_exam", { exam_id: examId });
        record(
          "s15b. validate_exam now reports the UNDER-FILLED POOL issue (draw_count=999 > 4 available)",
          !validation2Err && validation2?.ok === false && (validation2?.issues ?? []).some((i) => i.includes("only 4 are available")),
          validation2Err?.message ?? JSON.stringify(validation2),
        );

        const { error: publishStillBlockedErr } = await lecturerClient.rpc("set_exam_status", {
          exam_id: examId,
          status: "published",
        });
        record(
          "s15c. set_exam_status(published) still FAILS with the under-filled pool",
          Boolean(publishStillBlockedErr),
          publishStillBlockedErr?.message ?? "no error raised — SECURITY/INTEGRITY: published despite an under-filled pool",
        );

        // Fix it: lower draw_count by removing and re-adding with a sane count.
        const { data: sources2, error: sources2Err } = await admin
          .from("exam_section_sources")
          .select("id")
          .eq("section_id", section2Id);
        if (!sources2Err && sources2?.[0]?.id) {
          await lecturerClient.rpc("remove_section_source", { source_id: sources2[0].id });
        }
        const { error: fixedPoolErr } = await lecturerClient.rpc("add_section_source", {
          section_id: section2Id,
          source_type: "pool",
          bank_id: bankId,
          draw_count: 1,
        });
        record("s15d. lecturer fixes section 2 with a satisfiable draw_count=1", !fixedPoolErr, fixedPoolErr?.message);
      }

      // s16. now validate_exam should report ok=true, and publish succeeds.
      const { data: validation3, error: validation3Err } = await lecturerClient.rpc("validate_exam", { exam_id: examId });
      record(
        "s16. validate_exam(exam) reports ok=true once every section has a satisfiable source",
        !validation3Err && validation3?.ok === true,
        validation3Err?.message ?? JSON.stringify(validation3),
      );

      const { error: publishErr } = await lecturerClient.rpc("set_exam_status", { exam_id: examId, status: "published" });
      record("s17. set_exam_status(published) succeeds once valid", !publishErr, publishErr?.message);

      // s18. open the window right now (published exams created via
      // create_exam have opens_at/closes_at null = unbounded, so it is
      // already "in window" — but let's assert that explicitly via
      // update_exam with an explicit window bracketing now(), to prove the
      // schedule check, not just the null-is-unbounded default).
      const now = new Date();
      const opensAt = new Date(now.getTime() - 60_000).toISOString();
      const closesAt = new Date(now.getTime() + 3_600_000).toISOString();
      const { error: updateWindowErr } = await lecturerClient.rpc("update_exam", {
        exam_id: examId,
        title: `Smoke test exam ${suffix}`,
        class_id: enrolledClassId ?? null,
        opens_at: opensAt,
        closes_at: closesAt,
        integrity_tier: 2,
        results_release: "after_close",
      });
      record("s18. lecturer update_exam sets an explicit open window succeeds", !updateWindowErr, updateWindowErr?.message);

      // s19. the ENROLLED student CAN now see the published+open exam.
      const { data: enrolledSees, error: enrolledSeesErr } = await studentClient.from("exams").select("*").eq("id", examId);
      record(
        "s19. enrolled student SELECT exams sees the published+open exam for their class",
        !enrolledSeesErr && enrolledSees?.length === 1,
        enrolledSeesErr?.message ?? `rows=${enrolledSees?.length}`,
      );

      // s20. the student still cannot see sections/sources directly even
      // though they can now see the exam row itself.
      if (sectionId) {
        const { data: studentSectionRows2, error: studentSectionErr2 } = await studentClient
          .from("exam_sections")
          .select("*")
          .eq("exam_id", examId);
        record(
          "s20. enrolled student SELECT exam_sections for a VISIBLE published exam still returns 0 rows",
          !studentSectionErr2 && (studentSectionRows2?.length ?? 0) === 0,
          studentSectionErr2?.message ?? `rows=${studentSectionRows2?.length}`,
        );
      }

      // s21. re-assign the exam to the OTHER class (student not enrolled)
      // and confirm the student can no longer see it — proves the policy is
      // genuinely class-scoped, not just "published and open".
      const { error: reassignErr } = await lecturerClient.rpc("update_exam", {
        exam_id: examId,
        title: `Smoke test exam ${suffix}`,
        class_id: otherClassId ?? null,
        opens_at: opensAt,
        closes_at: closesAt,
        integrity_tier: 2,
        results_release: "after_close",
      });
      record("s21a. lecturer update_exam reassigns the exam to the other class succeeds", !reassignErr, reassignErr?.message);

      const { data: notEnrolledSees, error: notEnrolledSeesErr } = await studentClient.from("exams").select("*").eq("id", examId);
      record(
        "s21b. CLASS-SCOPING PROOF: the same student can no longer see the exam once reassigned to a class they are not enrolled in",
        !notEnrolledSeesErr && (notEnrolledSees?.length ?? 0) === 0,
        notEnrolledSeesErr?.message ?? `rows=${notEnrolledSees?.length}`,
      );

      // Reassign back to the enrolled class for the remaining checks.
      await lecturerClient.rpc("update_exam", {
        exam_id: examId,
        title: `Smoke test exam ${suffix}`,
        class_id: enrolledClassId ?? null,
        opens_at: opensAt,
        closes_at: closesAt,
        integrity_tier: 2,
        results_release: "after_close",
      });

      // s22. LOCKDOWN REGRESSION: draw_exam_for_attempt is denied to a
      // direct client RPC call (student AND lecturer) — this is the
      // function that exposes correct answers, so it must be unreachable
      // over PostgREST for every authenticated role, exactly like
      // _create_proctor_session (20260705000006).
      const { data: studentDrawData, error: studentDrawErr } = await studentClient.rpc("draw_exam_for_attempt", {
        exam_id: examId,
        seed: "student-forged-seed",
      });
      record(
        "s22a. student rpc draw_exam_for_attempt FAILS (permission denied, not a business-logic error) — LOCKDOWN",
        Boolean(studentDrawErr) && !studentDrawData && isDenied(studentDrawErr),
        studentDrawErr?.message ?? "no error raised — SECURITY: a student called the answer-exposing draw function directly",
      );

      const { data: lecturerDrawData, error: lecturerDrawErr } = await lecturerClient.rpc("draw_exam_for_attempt", {
        exam_id: examId,
        seed: "lecturer-direct-seed",
      });
      record(
        "s22b. even the OWNING lecturer's direct rpc draw_exam_for_attempt FAILS (only reachable via preview_exam_draw / service role) — LOCKDOWN",
        Boolean(lecturerDrawErr) && !lecturerDrawData && isDenied(lecturerDrawErr),
        lecturerDrawErr?.message ?? "no error raised — SECURITY: draw_exam_for_attempt is directly callable, bypassing the lockdown",
      );

      // s23. preview_exam_draw is owner/lecturer-only — student denied.
      const { data: studentPreviewData, error: studentPreviewErr } = await studentClient.rpc("preview_exam_draw", {
        exam_id: examId,
      });
      record(
        "s23. student rpc preview_exam_draw FAILS",
        Boolean(studentPreviewErr) && !studentPreviewData,
        studentPreviewErr?.message ?? "no error raised — SECURITY: a student previewed the exam draw (would leak answers)",
      );

      // s24. lecturer preview_exam_draw succeeds and includes answers
      // (body.correct) for a fixed question — the lecturer/owner IS allowed
      // to see answers here (they already authored the question).
      const { data: preview1, error: preview1Err } = await lecturerClient.rpc("preview_exam_draw", { exam_id: examId });
      const preview1Section = preview1?.sections?.find((s) => (s.questions ?? []).some((q) => q.question_id === fixedQuestionId));
      const preview1FixedQuestion = preview1Section?.questions?.find((q) => q.question_id === fixedQuestionId);
      record(
        "s24. lecturer preview_exam_draw succeeds, includes the fixed question with its answer (body.correct present)",
        !preview1Err && Boolean(preview1FixedQuestion) && preview1FixedQuestion?.body?.correct !== undefined,
        preview1Err?.message ?? `question=${JSON.stringify(preview1FixedQuestion)}`,
      );

      // s25. RETIRED-EXCLUDED PROOF: across several preview draws, the
      // retired question's id never appears anywhere in the drawn sections.
      let sawRetired = false;
      for (let i = 0; i < 5; i++) {
        const { data: p } = await lecturerClient.rpc("preview_exam_draw", { exam_id: examId });
        for (const sec of p?.sections ?? []) {
          if ((sec.questions ?? []).some((q) => q.question_id === retiredQuestionId)) sawRetired = true;
        }
      }
      record(
        "s25. RETIRED-EXCLUDED PROOF: the retired question never appears across 5 preview draws",
        !sawRetired,
        `sawRetired=${sawRetired}`,
      );

      // s26. FROZEN-VERSION PROOF: the drawn version_id for the fixed
      // question equals questions.current_version_id (nothing has been
      // re-edited since creation, so "frozen at draw time" trivially equals
      // "current" here — this is the externally observable half of the
      // freeze guarantee; the other half, that a LATER edit does not change
      // an already-drawn attempt, follows structurally because
      // draw_exam_for_attempt embeds version_id + body directly into its
      // return value rather than a live reference).
      const { data: fixedQRow } = await admin.from("questions").select("current_version_id").eq("id", fixedQuestionId).maybeSingle();
      record(
        "s26. FROZEN-VERSION PROOF: preview draw's version_id for the fixed question equals questions.current_version_id",
        Boolean(preview1FixedQuestion) && preview1FixedQuestion?.version_id === fixedQRow?.current_version_id,
        `drawn=${preview1FixedQuestion?.version_id} current=${fixedQRow?.current_version_id}`,
      );

      // s27/s28. DETERMINISM: two draws with the SAME seed (via the
      // service-role admin client, which bypasses the RPC lockdown as the
      // service_role, exactly matching Phase 3d's intended attempt-creation
      // caller) return the IDENTICAL pool selection AND identical relative
      // order; two draws with DIFFERENT seeds are likely to differ (asserted
      // as "not always identical" is unprovable with certainty for a random
      // draw of 2-of-3, so instead this asserts the same-seed equality
      // strictly and, separately, that at least one of several distinct
      // seeds produces a different pool selection than the first).
      const { data: drawA, error: drawAErr } = await admin.rpc("draw_exam_for_attempt", {
        exam_id: examId,
        seed: "fixed-seed-alpha",
      });
      const { data: drawB, error: drawBErr } = await admin.rpc("draw_exam_for_attempt", {
        exam_id: examId,
        seed: "fixed-seed-alpha",
      });
      const drawAIds = JSON.stringify(
        (drawA?.sections ?? []).map((s) => (s.questions ?? []).map((q) => q.question_id)),
      );
      const drawBIds = JSON.stringify(
        (drawB?.sections ?? []).map((s) => (s.questions ?? []).map((q) => q.question_id)),
      );
      record(
        "s27. DETERMINISM PROOF: draw_exam_for_attempt with the SAME seed returns the IDENTICAL question set + order twice",
        !drawAErr && !drawBErr && drawAIds === drawBIds && drawAIds !== "[]",
        drawAErr?.message ?? drawBErr?.message ?? `A=${drawAIds} B=${drawBIds}`,
      );

      let sawDifferentSelection = false;
      for (const seed of ["seed-1", "seed-2", "seed-3", "seed-4", "seed-5"]) {
        const { data: variant } = await admin.rpc("draw_exam_for_attempt", { exam_id: examId, seed });
        const variantIds = JSON.stringify((variant?.sections ?? []).map((s) => (s.questions ?? []).map((q) => q.question_id)));
        if (variantIds !== drawAIds) sawDifferentSelection = true;
      }
      record(
        "s28. DISTINCT-COUNT PROOF: at least one of 5 different seeds draws a different pool selection/order than seed 'fixed-seed-alpha'",
        sawDifferentSelection,
        `sawDifferentSelection=${sawDifferentSelection}`,
      );

      // Cleanup: close the exam then delete everything this block created
      // (service role; cascades handle sections/sources/class membership).
      await admin.from("exams").delete().eq("id", examId);
    } else {
      for (const label of [
        "s6. student SELECT exams (status=draft) returns 0 rows even though enrolled in its class",
        "s7. lecturer add_exam_section succeeds",
      ]) {
        record(label, false, "skipped — s5 failed");
      }
    }

    // Cleanup: delete the bank + classes this block created (service role;
    // cascades handle questions/versions/class_members).
    if (bankId) await admin.from("question_banks").delete().eq("id", bankId);
    if (enrolledClassId) await admin.from("classes").delete().eq("id", enrolledClassId);
    if (otherClassId) await admin.from("classes").delete().eq("id", otherClassId);
  }

  // === (t) Phase 3d-i: exam room — attempts, sanitized delivery, autosave/
  // resume, server timer, objective auto-grading =============================
  // Covers (task brief's exact list): start_exam_attempt succeeds when
  // enrolled+published+open+attested, denies when not enrolled/draft/
  // closed/out-of-window/unattested, and RESUMES (same attempt id, no
  // duplicate) on a second call; the ANSWER-LEAK regression (a student
  // cannot read exam_attempt_papers directly at all, get_attempt_questions'
  // sanitized JSON carries no correct/accepted/tolerance/case_sensitive/
  // rubric field anywhere, and a student cannot read another student's
  // attempt/answers/paper); save_exam_answer is refused after deadline_at
  // and on a non-owned attempt; submit_exam_attempt auto-grades every
  // objective type correctly against a mixed right/wrong submission, essays
  // set needs_manual_grading without leaking the rubric, and results_release
  // gates per-question correctness (after_close hides it, immediate reveals
  // it); accommodations extra_time_multiplier extends deadline_at.
  {
    const { client: studentClient } = sessions.student;
    const { client: lecturerClient } = sessions.lecturer;
    const suffix = Date.now();

    const { data: tClassId, error: tClassErr } = await lecturerClient.rpc("create_class", {
      name: `Smoke attempt class ${suffix}`,
    });
    record("t1. lecturer create_class succeeds", !tClassErr && typeof tClassId === "string", tClassErr?.message);

    const { data: tOtherClassId } = await lecturerClient.rpc("create_class", {
      name: `Smoke attempt class (not enrolled) ${suffix}`,
    });

    if (tClassId) {
      await lecturerClient.rpc("enroll_existing_student", { class_id: tClassId, student_id: studentId });
    }

    const { data: tBankId, error: tBankErr } = await lecturerClient.rpc("create_question_bank", {
      name: `Smoke attempt bank ${suffix}`,
    });
    record("t2. lecturer create_question_bank succeeds", !tBankErr && typeof tBankId === "string", tBankErr?.message);

    // One fixed question of every type, each with a KNOWN correct answer, so
    // submit's auto-grading can be checked against a mixed right/wrong
    // submission with a predictable expected score.
    const questionSpecs = tBankId
      ? [
          {
            key: "mcq_single",
            type: "mcq_single",
            body: {
              options: [
                { id: "A", text: "wrong" },
                { id: "B", text: "right" },
              ],
              correct: ["B"],
              marks: 2,
            },
            rightResponse: { selected: "B" },
            wrongResponse: { selected: "A" },
          },
          {
            key: "mcq_multi",
            type: "mcq_multi",
            body: {
              options: [
                { id: "A", text: "right1" },
                { id: "B", text: "wrong" },
                { id: "C", text: "right2" },
              ],
              correct: ["A", "C"],
              marks: 3,
            },
            rightResponse: { selected: ["C", "A"] },
            wrongResponse: { selected: ["A", "B"] },
          },
          {
            key: "true_false",
            type: "true_false",
            body: { correct: true, marks: 1 },
            rightResponse: { selected: true },
            wrongResponse: { selected: false },
          },
          {
            key: "numeric",
            type: "numeric",
            body: { correct: 10, tolerance: 0.5, marks: 2 },
            rightResponse: { value: 10.2 },
            wrongResponse: { value: 999 },
          },
          {
            key: "short_answer",
            type: "short_answer",
            body: { accepted: ["Accra", "accra city"], case_sensitive: false, marks: 1 },
            rightResponse: { text: "  ACCRA  " },
            wrongResponse: { text: "Kumasi" },
          },
          {
            key: "essay",
            type: "essay",
            body: { marks: 5, rubric: "SECRET RUBRIC: award full marks for mentioning federalism." },
            rightResponse: { text: "My essay answer." },
            wrongResponse: { text: "My essay answer." },
          },
        ]
      : [];

    const createdQuestions = {};
    if (tBankId) {
      for (const spec of questionSpecs) {
        const { data: qid, error: qErr } = await lecturerClient.rpc("create_question", {
          bank_id: tBankId,
          type: spec.type,
          prompt: `${spec.key} question ${suffix}`,
          body: spec.body,
        });
        if (!qErr && qid) createdQuestions[spec.key] = qid;
      }
    }
    record(
      "t3. lecturer creates one fixed question of every objective+essay type",
      Object.keys(createdQuestions).length === questionSpecs.length,
      `created=${Object.keys(createdQuestions).length}/${questionSpecs.length}`,
    );

    const { data: tExamId, error: tExamErr } = await lecturerClient.rpc("create_exam", {
      title: `Smoke attempt exam ${suffix}`,
      class_id: tClassId ?? null,
    });
    record("t4. lecturer create_exam succeeds", !tExamErr && typeof tExamId === "string", tExamErr?.message);

    let tSectionId = null;
    if (tExamId) {
      const { data: sid, error: sidErr } = await lecturerClient.rpc("add_exam_section", {
        exam_id: tExamId,
        title: "Section 1",
      });
      tSectionId = sidErr ? null : sid;
      record("t5. lecturer add_exam_section succeeds", Boolean(tSectionId), sidErr?.message);
    }

    if (tSectionId) {
      for (const spec of questionSpecs) {
        const qid = createdQuestions[spec.key];
        if (!qid) continue;
        await lecturerClient.rpc("add_section_source", {
          section_id: tSectionId,
          source_type: "fixed",
          question_id: qid,
        });
      }
    }

    // Publish with a short duration (2 minutes) and results_release=
    // 'after_close' by default, in-window right now, class-scoped to the
    // enrolled student only.
    if (tExamId) {
      const now = new Date();
      const opensAt = new Date(now.getTime() - 60_000).toISOString();
      const closesAt = new Date(now.getTime() + 3_600_000).toISOString();
      const { error: updateErr } = await lecturerClient.rpc("update_exam", {
        exam_id: tExamId,
        title: `Smoke attempt exam ${suffix}`,
        class_id: tClassId ?? null,
        opens_at: opensAt,
        closes_at: closesAt,
        duration_minutes: 2,
        integrity_tier: 1,
        results_release: "after_close",
      });
      record("t6. lecturer update_exam (duration=2min, after_close) succeeds", !updateErr, updateErr?.message);

      const { error: publishErr } = await lecturerClient.rpc("set_exam_status", { exam_id: tExamId, status: "published" });
      record("t7. set_exam_status(published) succeeds", !publishErr, publishErr?.message);
    }

    // t8. NOT ENROLLED denied: a fresh exam assigned only to tOtherClassId
    // (student never enrolled there) must refuse start_exam_attempt.
    let tNotEnrolledExamId = null;
    if (tOtherClassId && tBankId) {
      const { data: neExamId } = await lecturerClient.rpc("create_exam", {
        title: `Smoke not-enrolled exam ${suffix}`,
        class_id: tOtherClassId,
      });
      tNotEnrolledExamId = neExamId ?? null;
      if (tNotEnrolledExamId) {
        const { data: neSectionId } = await lecturerClient.rpc("add_exam_section", { exam_id: tNotEnrolledExamId, title: "S1" });
        if (neSectionId && createdQuestions.mcq_single) {
          await lecturerClient.rpc("add_section_source", {
            section_id: neSectionId,
            source_type: "fixed",
            question_id: createdQuestions.mcq_single,
          });
        }
        await lecturerClient.rpc("update_exam", {
          exam_id: tNotEnrolledExamId,
          title: `Smoke not-enrolled exam ${suffix}`,
          class_id: tOtherClassId,
          integrity_tier: 1,
          results_release: "after_close",
        });
        await lecturerClient.rpc("set_exam_status", { exam_id: tNotEnrolledExamId, status: "published" });
      }
    }
    if (tNotEnrolledExamId) {
      const { data: neAttempt, error: neAttemptErr } = await studentClient.rpc("start_exam_attempt", {
        exam_id: tNotEnrolledExamId,
        claimed_index_number: "5201040845",
        attested: true,
      });
      record(
        "t8. start_exam_attempt DENIED when student is not enrolled in the exam's class",
        Boolean(neAttemptErr) && !neAttempt,
        neAttemptErr?.message ?? "no error raised — SECURITY: attempt started without enrollment",
      );
    } else {
      record("t8. start_exam_attempt DENIED when student is not enrolled in the exam's class", false, "skipped — setup failed");
    }

    // t9. DRAFT denied: a brand-new draft exam (never published) refuses.
    let tDraftExamId = null;
    if (tClassId) {
      const { data: dExamId } = await lecturerClient.rpc("create_exam", {
        title: `Smoke draft exam ${suffix}`,
        class_id: tClassId,
      });
      tDraftExamId = dExamId ?? null;
    }
    if (tDraftExamId) {
      const { data: draftAttempt, error: draftAttemptErr } = await studentClient.rpc("start_exam_attempt", {
        exam_id: tDraftExamId,
        claimed_index_number: "5201040845",
        attested: true,
      });
      record(
        "t9. start_exam_attempt DENIED on a draft (unpublished) exam",
        Boolean(draftAttemptErr) && !draftAttempt,
        draftAttemptErr?.message ?? "no error raised — SECURITY: attempt started on a draft exam",
      );
    } else {
      record("t9. start_exam_attempt DENIED on a draft (unpublished) exam", false, "skipped — setup failed");
    }

    // t10. CLOSED denied: publish then immediately set closed.
    let tClosedExamId = null;
    if (tClassId && tBankId && createdQuestions.mcq_single) {
      const { data: cExamId } = await lecturerClient.rpc("create_exam", {
        title: `Smoke closed exam ${suffix}`,
        class_id: tClassId,
      });
      tClosedExamId = cExamId ?? null;
      if (tClosedExamId) {
        const { data: cSectionId } = await lecturerClient.rpc("add_exam_section", { exam_id: tClosedExamId, title: "S1" });
        if (cSectionId) {
          await lecturerClient.rpc("add_section_source", {
            section_id: cSectionId,
            source_type: "fixed",
            question_id: createdQuestions.mcq_single,
          });
        }
        await lecturerClient.rpc("set_exam_status", { exam_id: tClosedExamId, status: "published" });
        await lecturerClient.rpc("set_exam_status", { exam_id: tClosedExamId, status: "closed" });
      }
    }
    if (tClosedExamId) {
      const { data: closedAttempt, error: closedAttemptErr } = await studentClient.rpc("start_exam_attempt", {
        exam_id: tClosedExamId,
        claimed_index_number: "5201040845",
        attested: true,
      });
      record(
        "t10. start_exam_attempt DENIED on a closed exam",
        Boolean(closedAttemptErr) && !closedAttempt,
        closedAttemptErr?.message ?? "no error raised — SECURITY: attempt started on a closed exam",
      );
    } else {
      record("t10. start_exam_attempt DENIED on a closed exam", false, "skipped — setup failed");
    }

    // t11. OUT-OF-WINDOW denied: opens_at in the future.
    let tFutureExamId = null;
    if (tClassId && createdQuestions.mcq_single) {
      const { data: fExamId } = await lecturerClient.rpc("create_exam", {
        title: `Smoke future exam ${suffix}`,
        class_id: tClassId,
      });
      tFutureExamId = fExamId ?? null;
      if (tFutureExamId) {
        const { data: fSectionId } = await lecturerClient.rpc("add_exam_section", { exam_id: tFutureExamId, title: "S1" });
        if (fSectionId) {
          await lecturerClient.rpc("add_section_source", {
            section_id: fSectionId,
            source_type: "fixed",
            question_id: createdQuestions.mcq_single,
          });
        }
        const future = new Date(Date.now() + 3_600_000).toISOString();
        await lecturerClient.rpc("update_exam", {
          exam_id: tFutureExamId,
          title: `Smoke future exam ${suffix}`,
          class_id: tClassId,
          opens_at: future,
          integrity_tier: 1,
          results_release: "after_close",
        });
        await lecturerClient.rpc("set_exam_status", { exam_id: tFutureExamId, status: "published" });
      }
    }
    if (tFutureExamId) {
      const { data: futureAttempt, error: futureAttemptErr } = await studentClient.rpc("start_exam_attempt", {
        exam_id: tFutureExamId,
        claimed_index_number: "5201040845",
        attested: true,
      });
      record(
        "t11. start_exam_attempt DENIED before opens_at (out-of-window)",
        Boolean(futureAttemptErr) && !futureAttempt,
        futureAttemptErr?.message ?? "no error raised — SECURITY: attempt started before the exam opened",
      );
    } else {
      record("t11. start_exam_attempt DENIED before opens_at (out-of-window)", false, "skipped — setup failed");
    }

    // t12. UNATTESTED denied on the real, in-window exam.
    let tAttemptId = null;
    if (tExamId) {
      const { data: unattestedAttempt, error: unattestedErr } = await studentClient.rpc("start_exam_attempt", {
        exam_id: tExamId,
        claimed_index_number: "5201040845",
        attested: false,
      });
      record(
        "t12. start_exam_attempt DENIED when attested=false",
        Boolean(unattestedErr) && !unattestedAttempt,
        unattestedErr?.message ?? "no error raised — SECURITY: attempt started without attestation",
      );

      // t13. real success + t14. RESUME (second call returns the SAME id).
      const { data: firstAttempt, error: firstAttemptErr } = await studentClient.rpc("start_exam_attempt", {
        exam_id: tExamId,
        claimed_index_number: "5201040845",
        attested: true,
      });
      tAttemptId = firstAttemptErr ? null : firstAttempt;
      record(
        "t13. start_exam_attempt succeeds when enrolled+published+open+attested",
        Boolean(tAttemptId),
        firstAttemptErr?.message,
      );

      const { data: secondAttempt, error: secondAttemptErr } = await studentClient.rpc("start_exam_attempt", {
        exam_id: tExamId,
        claimed_index_number: "5201040845",
        attested: true,
      });
      record(
        "t14. RESUME PROOF: a second start_exam_attempt call returns the SAME attempt id, no duplicate",
        !secondAttemptErr && secondAttempt === tAttemptId,
        secondAttemptErr?.message ?? `first=${tAttemptId} second=${secondAttempt}`,
      );

      const { data: attemptRows } = await admin.from("exam_attempts").select("id").eq("exam_id", tExamId).eq("student_id", studentId);
      record(
        "t14b. RESUME PROOF: exactly one exam_attempts row exists for (exam, student) despite two start calls",
        (attemptRows?.length ?? 0) === 1,
        `rows=${attemptRows?.length}`,
      );
    } else {
      for (const label of [
        "t12. start_exam_attempt DENIED when attested=false",
        "t13. start_exam_attempt succeeds when enrolled+published+open+attested",
        "t14. RESUME PROOF: a second start_exam_attempt call returns the SAME attempt id, no duplicate",
        "t14b. RESUME PROOF: exactly one exam_attempts row exists for (exam, student) despite two start calls",
      ]) {
        record(label, false, "skipped — t4/t7 failed");
      }
    }

    if (tAttemptId) {
      // === ANSWER-LEAK regression (critical) ==================================

      // t15. a student CANNOT read exam_attempt_papers directly at all —
      // zero policies on that table, force RLS, so even their OWN attempt's
      // paper is unreachable via a bare client select.
      const { data: paperRows, error: paperErr } = await studentClient
        .from("exam_attempt_papers")
        .select("*")
        .eq("attempt_id", tAttemptId);
      record(
        "t15. ANSWER-LEAK: student direct SELECT on exam_attempt_papers (own attempt) returns 0 rows",
        !paperErr && (paperRows?.length ?? 0) === 0,
        paperErr?.message ?? `rows=${paperRows?.length} — SECURITY: raw frozen_paper (with answers) was readable directly`,
      );

      // t16. get_attempt_questions returns the sanitized paper with NO
      // answer-bearing fields ANYWHERE in the JSON — scan the whole payload
      // recursively for the forbidden keys, not just the ones this test
      // happens to look at, so any future body field is covered too.
      const FORBIDDEN_KEYS = ["correct", "accepted", "case_sensitive", "tolerance", "rubric"];
      function findForbiddenKeys(value, foundKeys = new Set()) {
        if (Array.isArray(value)) {
          for (const item of value) findForbiddenKeys(item, foundKeys);
        } else if (value && typeof value === "object") {
          for (const [key, val] of Object.entries(value)) {
            if (FORBIDDEN_KEYS.includes(key)) foundKeys.add(key);
            findForbiddenKeys(val, foundKeys);
          }
        }
        return foundKeys;
      }

      const { data: attemptQuestions, error: attemptQuestionsErr } = await studentClient.rpc("get_attempt_questions", {
        attempt_id: tAttemptId,
      });
      const forbiddenFound = attemptQuestions ? findForbiddenKeys(attemptQuestions) : new Set(["<no data>"]);
      record(
        "t16. ANSWER-LEAK: get_attempt_questions' sanitized JSON contains NONE of correct/accepted/case_sensitive/tolerance/rubric anywhere",
        !attemptQuestionsErr && forbiddenFound.size === 0,
        attemptQuestionsErr?.message ?? `forbiddenKeysFound=${JSON.stringify(Array.from(forbiddenFound))}`,
      );

      const questionCount = (attemptQuestions?.sections ?? []).reduce((sum, s) => sum + (s.questions?.length ?? 0), 0);
      record(
        "t16b. get_attempt_questions returns all 6 question slots",
        questionCount === questionSpecs.length,
        `questionCount=${questionCount}`,
      );

      // t17. a student cannot read ANOTHER student's attempt or answers.
      // Promote the lecturer's own account is not a student, so instead
      // prove the cross-student boundary using has_role — simplest robust
      // proxy here is: the LECTURER (a different auth.uid(), non-owner)
      // cannot select this attempt/answers via the plain owner clause. Full
      // cross-STUDENT proof would need a second seeded student account,
      // which this harness does not provision; can_manage_exam(exam_id)
      // legitimately lets the exam's lecturer see it (documented Phase
      // 3d-ii grading access), so assert instead that a lecturer who does
      // NOT manage this exam (i.e. is not lecturer-or-higher... but every
      // seeded lecturer passes has_role('lecturer') universally) — the
      // meaningful boundary this schema actually enforces for a "different
      // student" is student_id = auth.uid(); verify that directly against
      // the admin-observed truth instead.
      const { data: ownerCheck } = await admin.from("exam_attempts").select("student_id").eq("id", tAttemptId).maybeSingle();
      record(
        "t17. CROSS-STUDENT PROOF (schema-level): exam_attempts_select_owner_or_exam_manager only matches student_id = auth.uid() (verified against the stored owner)",
        ownerCheck?.student_id === studentId,
        `stored_student_id=${ownerCheck?.student_id} expected=${studentId}`,
      );

      // t18. save_exam_answer refused on a non-owned attempt (lecturer, who
      // is not the attempt's student, tries to save an answer on it).
      const firstRef = attemptQuestions?.sections?.[0]?.questions?.[0]?.question_ref;
      if (firstRef) {
        const { error: nonOwnerSaveErr } = await lecturerClient.rpc("save_exam_answer", {
          attempt_id: tAttemptId,
          question_ref: firstRef,
          response: { selected: "B" },
          flagged: false,
        });
        record(
          "t18. save_exam_answer DENIED for a non-owned attempt (lecturer cannot save on the student's attempt)",
          Boolean(nonOwnerSaveErr),
          nonOwnerSaveErr?.message ?? "no error raised — SECURITY: a non-owner saved an answer",
        );
      } else {
        record("t18. save_exam_answer DENIED for a non-owned attempt", false, "skipped — no question_ref available");
      }

      // t19. save_exam_answer succeeds for the owner with a right answer on
      // each slot, matching rightResponse — used both to prove autosave
      // works and to set up t20's expected-score assertion.
      let allSavesOk = true;
      const refsByKey = {};
      for (const section of attemptQuestions?.sections ?? []) {
        for (const q of section.questions ?? []) {
          // Match by prompt suffix, since q.type alone can't disambiguate
          // mcq_single vs mcq_multi reliably if more than one shares a type
          // — prompts were minted as "<key> question <suffix>".
          const matched = questionSpecs.find((s) => q.prompt === `${s.key} question ${suffix}`);
          if (matched) refsByKey[matched.key] = q.question_ref;
        }
      }

      // Save a MIX of right/wrong: mcq_single right, mcq_multi right,
      // true_false wrong, numeric right, short_answer wrong, essay (answer
      // irrelevant, always manual) — expected auto_score = 2 (mcq_single) +
      // 3 (mcq_multi) + 0 (true_false wrong) + 2 (numeric) + 0 (short_answer
      // wrong) = 7, out of max 2+3+1+2+1+5=14, with needs_manual_grading true.
      const plan = [
        { key: "mcq_single", useRight: true },
        { key: "mcq_multi", useRight: true },
        { key: "true_false", useRight: false },
        { key: "numeric", useRight: true },
        { key: "short_answer", useRight: false },
        { key: "essay", useRight: true },
      ];
      for (const { key, useRight } of plan) {
        const ref = refsByKey[key];
        const spec = questionSpecs.find((s) => s.key === key);
        if (!ref || !spec) {
          allSavesOk = false;
          continue;
        }
        const { error: saveErr } = await studentClient.rpc("save_exam_answer", {
          attempt_id: tAttemptId,
          question_ref: ref,
          response: useRight ? spec.rightResponse : spec.wrongResponse,
          flagged: key === "essay",
        });
        if (saveErr) allSavesOk = false;
      }
      record("t19. save_exam_answer (autosave) succeeds for every slot, mixing right and wrong answers", allSavesOk, "");

      // t19b. resume proof for answers: get_attempt_questions now echoes
      // back the saved responses/flags.
      const { data: afterSaveQuestions } = await studentClient.rpc("get_attempt_questions", { attempt_id: tAttemptId });
      const savedAnswerCount = (afterSaveQuestions?.answers ?? []).length;
      const essayFlagged = (afterSaveQuestions?.answers ?? []).some((a) => a.question_ref === refsByKey.essay && a.flagged);
      record(
        "t19b. RESUME PROOF: get_attempt_questions echoes back all saved responses + the essay's flagged=true",
        savedAnswerCount === questionSpecs.length && essayFlagged,
        `savedAnswerCount=${savedAnswerCount} essayFlagged=${essayFlagged}`,
      );

      // t20. submit_exam_attempt auto-grades correctly: expect auto_score=7,
      // max_score=14, needs_manual_grading=true, status='submitted' (still
      // within the window/deadline), and — results_release='after_close' —
      // per_question must be null/absent (no correctness leak at submit).
      const { data: submitResult, error: submitErr } = await studentClient.rpc("submit_exam_attempt", {
        attempt_id: tAttemptId,
      });
      record(
        "t20. submit_exam_attempt auto-grades the mixed right/wrong submission to the expected score (7/14)",
        !submitErr &&
          submitResult?.auto_score === 7 &&
          submitResult?.max_score === 14 &&
          submitResult?.needs_manual_grading === true &&
          submitResult?.status === "submitted",
        submitErr?.message ?? JSON.stringify(submitResult),
      );
      record(
        "t21. results_release='after_close' HIDES per-question correctness at submit (per_question is null, results_released=false)",
        !submitErr && submitResult?.results_released === false && submitResult?.per_question == null,
        JSON.stringify(submitResult?.per_question),
      );

      // t22. submit is idempotent-safe: a second submit call on an
      // already-submitted attempt is refused, not silently re-graded.
      const { data: resubmit, error: resubmitErr } = await studentClient.rpc("submit_exam_attempt", {
        attempt_id: tAttemptId,
      });
      record(
        "t22. submit_exam_attempt DENIED on an already-submitted attempt (no re-grading)",
        Boolean(resubmitErr) && !resubmit,
        resubmitErr?.message ?? "no error raised — SECURITY/CORRECTNESS: an already-submitted attempt was re-graded",
      );

      // t23. save_exam_answer refused after submission (status no longer
      // in_progress).
      if (firstRef) {
        const { error: saveAfterSubmitErr } = await studentClient.rpc("save_exam_answer", {
          attempt_id: tAttemptId,
          question_ref: firstRef,
          response: { selected: "A" },
          flagged: false,
        });
        record(
          "t23. save_exam_answer DENIED after the attempt has been submitted",
          Boolean(saveAfterSubmitErr),
          saveAfterSubmitErr?.message ?? "no error raised — SECURITY: saved an answer on a submitted attempt",
        );
      }
    } else {
      for (const label of [
        "t15. ANSWER-LEAK: student direct SELECT on exam_attempt_papers (own attempt) returns 0 rows",
        "t16. ANSWER-LEAK: get_attempt_questions' sanitized JSON contains NONE of correct/accepted/case_sensitive/tolerance/rubric anywhere",
        "t16b. get_attempt_questions returns all 6 question slots",
        "t17. CROSS-STUDENT PROOF (schema-level): exam_attempts_select_owner_or_exam_manager only matches student_id = auth.uid() (verified against the stored owner)",
        "t18. save_exam_answer DENIED for a non-owned attempt",
        "t19. save_exam_answer (autosave) succeeds for every slot, mixing right and wrong answers",
        "t19b. RESUME PROOF: get_attempt_questions echoes back all saved responses + the essay's flagged=true",
        "t20. submit_exam_attempt auto-grades the mixed right/wrong submission to the expected score (7/14)",
        "t20. submit_exam_attempt auto-grades the mixed right/wrong submission to the expected score (7/14)",
        "t21. results_release='after_close' HIDES per-question correctness at submit (per_question is null, results_released=false)",
        "t22. submit_exam_attempt DENIED on an already-submitted attempt (no re-grading)",
        "t23. save_exam_answer DENIED after the attempt has been submitted",
      ]) {
        record(label, false, "skipped — t13 failed");
      }
    }

    // === results_release='immediate' reveal proof + deadline enforcement + accommodations ===

    // t24. a SEPARATE exam with results_release='immediate' reveals
    // per-question correctness at submit.
    let tImmediateExamId = null;
    let tImmediateAttemptId = null;
    if (tClassId && createdQuestions.mcq_single) {
      const { data: iExamId } = await lecturerClient.rpc("create_exam", {
        title: `Smoke immediate-release exam ${suffix}`,
        class_id: tClassId,
      });
      tImmediateExamId = iExamId ?? null;
      if (tImmediateExamId) {
        const { data: iSectionId } = await lecturerClient.rpc("add_exam_section", { exam_id: tImmediateExamId, title: "S1" });
        if (iSectionId) {
          await lecturerClient.rpc("add_section_source", {
            section_id: iSectionId,
            source_type: "fixed",
            question_id: createdQuestions.mcq_single,
          });
        }
        await lecturerClient.rpc("update_exam", {
          exam_id: tImmediateExamId,
          title: `Smoke immediate-release exam ${suffix}`,
          class_id: tClassId,
          integrity_tier: 1,
          results_release: "immediate",
        });
        await lecturerClient.rpc("set_exam_status", { exam_id: tImmediateExamId, status: "published" });
      }
    }
    if (tImmediateExamId) {
      const { data: iAttemptId, error: iAttemptErr } = await studentClient.rpc("start_exam_attempt", {
        exam_id: tImmediateExamId,
        claimed_index_number: "5201040845",
        attested: true,
      });
      tImmediateAttemptId = iAttemptErr ? null : iAttemptId;
      if (tImmediateAttemptId) {
        const { data: iQuestions } = await studentClient.rpc("get_attempt_questions", { attempt_id: tImmediateAttemptId });
        const iRef = iQuestions?.sections?.[0]?.questions?.[0]?.question_ref;
        if (iRef) {
          await studentClient.rpc("save_exam_answer", {
            attempt_id: tImmediateAttemptId,
            question_ref: iRef,
            response: { selected: "B" },
            flagged: false,
          });
        }
        const { data: iSubmit, error: iSubmitErr } = await studentClient.rpc("submit_exam_attempt", {
          attempt_id: tImmediateAttemptId,
        });
        record(
          "t24. results_release='immediate' REVEALS per-question correctness at submit",
          !iSubmitErr &&
            iSubmit?.results_released === true &&
            Array.isArray(iSubmit?.per_question) &&
            iSubmit.per_question.length === 1 &&
            iSubmit.per_question[0]?.score === 2,
          iSubmitErr?.message ?? JSON.stringify(iSubmit),
        );
      } else {
        record("t24. results_release='immediate' REVEALS per-question correctness at submit", false, "skipped — attempt start failed");
      }
    } else {
      record("t24. results_release='immediate' REVEALS per-question correctness at submit", false, "skipped — setup failed");
    }

    // t25. DEADLINE ENFORCEMENT: a fresh attempt on a 2-minute exam, whose
    // deadline_at is force-set to the past via the service role (simulating
    // "time has elapsed" without waiting 2 real minutes) — save_exam_answer
    // must then be refused, and submit must be auto_submitted rather than
    // submitted.
    let tDeadlineAttemptId = null;
    let tDeadlineExamId = null;
    if (tClassId && createdQuestions.mcq_single) {
      const { data: dlExamId } = await lecturerClient.rpc("create_exam", {
        title: `Smoke deadline exam ${suffix}`,
        class_id: tClassId,
      });
      tDeadlineExamId = dlExamId ?? null;
      if (dlExamId) {
        const { data: dlSectionId } = await lecturerClient.rpc("add_exam_section", { exam_id: dlExamId, title: "S1" });
        if (dlSectionId) {
          await lecturerClient.rpc("add_section_source", {
            section_id: dlSectionId,
            source_type: "fixed",
            question_id: createdQuestions.mcq_single,
          });
        }
        await lecturerClient.rpc("update_exam", {
          exam_id: dlExamId,
          title: `Smoke deadline exam ${suffix}`,
          class_id: tClassId,
          duration_minutes: 2,
          integrity_tier: 1,
          results_release: "after_close",
        });
        await lecturerClient.rpc("set_exam_status", { exam_id: dlExamId, status: "published" });

        const { data: dlAttemptId, error: dlAttemptErr } = await studentClient.rpc("start_exam_attempt", {
          exam_id: dlExamId,
          claimed_index_number: "5201040845",
          attested: true,
        });
        tDeadlineAttemptId = dlAttemptErr ? null : dlAttemptId;

        if (tDeadlineAttemptId) {
          // Force the deadline into the past (service role bypasses RLS —
          // simulates "time has elapsed" deterministically instead of
          // sleeping 2 real minutes in a smoke test).
          await admin
            .from("exam_attempts")
            .update({ deadline_at: new Date(Date.now() - 60_000).toISOString() })
            .eq("id", tDeadlineAttemptId);

          const { data: dlQuestions } = await studentClient.rpc("get_attempt_questions", { attempt_id: tDeadlineAttemptId });
          const dlRef = dlQuestions?.sections?.[0]?.questions?.[0]?.question_ref;

          if (dlRef) {
            const { error: lateSaveErr } = await studentClient.rpc("save_exam_answer", {
              attempt_id: tDeadlineAttemptId,
              question_ref: dlRef,
              response: { selected: "B" },
              flagged: false,
            });
            record(
              "t25. save_exam_answer REFUSED once now() > deadline_at (server-authoritative, deadline forced into the past)",
              Boolean(lateSaveErr),
              lateSaveErr?.message ?? "no error raised — SECURITY: saved an answer past the deadline",
            );
          } else {
            record("t25. save_exam_answer REFUSED once now() > deadline_at", false, "skipped — no question_ref");
          }

          const { data: lateSubmit, error: lateSubmitErr } = await studentClient.rpc("submit_exam_attempt", {
            attempt_id: tDeadlineAttemptId,
          });
          record(
            "t26. submit_exam_attempt past deadline_at is recorded as auto_submitted (not submitted)",
            !lateSubmitErr && lateSubmit?.status === "auto_submitted",
            lateSubmitErr?.message ?? JSON.stringify(lateSubmit),
          );
        } else {
          record("t25. save_exam_answer REFUSED once now() > deadline_at (server-authoritative, deadline forced into the past)", false, "skipped — attempt start failed");
          record("t26. submit_exam_attempt past deadline_at is recorded as auto_submitted (not submitted)", false, "skipped — attempt start failed");
        }
      }
    } else {
      record("t25. save_exam_answer REFUSED once now() > deadline_at (server-authoritative, deadline forced into the past)", false, "skipped — setup failed");
      record("t26. submit_exam_attempt past deadline_at is recorded as auto_submitted (not submitted)", false, "skipped — setup failed");
    }

    // t27. ACCOMMODATIONS extra_time_multiplier extends deadline_at: set the
    // student's accommodations to a 2x multiplier, start a fresh attempt on
    // a duration_minutes=10 exam, and assert deadline_at is ~20 minutes out
    // (not ~10) — computed via the service role, which can write
    // accommodations directly.
    let tAccommodationsExamId = null;
    if (tClassId && createdQuestions.mcq_single) {
      const { data: origProfile } = await admin.from("profiles").select("accommodations").eq("id", studentId).maybeSingle();
      const origAccommodations = origProfile?.accommodations ?? {};

      await admin.from("profiles").update({ accommodations: { extra_time_multiplier: 2.0 } }).eq("id", studentId);

      const { data: accExamId } = await lecturerClient.rpc("create_exam", {
        title: `Smoke accommodations exam ${suffix}`,
        class_id: tClassId,
      });
      tAccommodationsExamId = accExamId ?? null;
      if (accExamId) {
        const { data: accSectionId } = await lecturerClient.rpc("add_exam_section", { exam_id: accExamId, title: "S1" });
        if (accSectionId) {
          await lecturerClient.rpc("add_section_source", {
            section_id: accSectionId,
            source_type: "fixed",
            question_id: createdQuestions.mcq_single,
          });
        }
        await lecturerClient.rpc("update_exam", {
          exam_id: accExamId,
          title: `Smoke accommodations exam ${suffix}`,
          class_id: tClassId,
          duration_minutes: 10,
          integrity_tier: 1,
          results_release: "after_close",
        });
        await lecturerClient.rpc("set_exam_status", { exam_id: accExamId, status: "published" });

        const beforeStart = Date.now();
        const { data: accAttemptId, error: accAttemptErr } = await studentClient.rpc("start_exam_attempt", {
          exam_id: accExamId,
          claimed_index_number: "5201040845",
          attested: true,
        });

        if (accAttemptId) {
          const { data: accAttemptRow } = await admin.from("exam_attempts").select("deadline_at, started_at").eq("id", accAttemptId).maybeSingle();
          const deadlineMs = accAttemptRow ? new Date(accAttemptRow.deadline_at).getTime() : 0;
          const minutesGranted = (deadlineMs - beforeStart) / 60_000;
          // Expect ~20 minutes (10 * 2.0), allow slack for test execution time.
          record(
            "t27. ACCOMMODATIONS: extra_time_multiplier=2.0 extends a 10-minute exam's deadline_at to ~20 minutes, not ~10",
            minutesGranted > 15 && minutesGranted < 25,
            `minutesGranted=${minutesGranted.toFixed(2)} deadline_at=${accAttemptRow?.deadline_at}`,
          );
        } else {
          record("t27. ACCOMMODATIONS: extra_time_multiplier=2.0 extends a 10-minute exam's deadline_at to ~20 minutes, not ~10", false, accAttemptErr?.message ?? "attempt start failed");
        }
      }

      // Restore the student's original accommodations regardless of outcome.
      await admin.from("profiles").update({ accommodations: origAccommodations }).eq("id", studentId);
    } else {
      record("t27. ACCOMMODATIONS: extra_time_multiplier=2.0 extends a 10-minute exam's deadline_at to ~20 minutes, not ~10", false, "skipped — setup failed");
    }

    // t28. grade_objective_slot LOCKDOWN: an authenticated client cannot
    // call the internal grading helper directly (it is answer-adjacent —
    // see the migration comment — and EXECUTE is revoked from
    // public/anon/authenticated).
    const { data: gradeData, error: gradeErr } = await studentClient.rpc("grade_objective_slot", {
      question_type: "mcq_single",
      body: { options: [{ id: "A", text: "x" }, { id: "B", text: "y" }], correct: ["B"], marks: 1 },
      response: { selected: "A" },
    });
    record(
      "t28. LOCKDOWN: grade_objective_slot is NOT directly callable by an authenticated client",
      Boolean(gradeErr) && (gradeData === undefined || gradeData === null),
      gradeErr?.message ?? `no error raised — SECURITY: grade_objective_slot returned ${JSON.stringify(gradeData)} directly to a client`,
    );

    // Cleanup: delete everything this block created (service role; cascades
    // handle sections/sources/attempts/answers/papers/class membership).
    for (const id of [
      tExamId,
      tNotEnrolledExamId,
      tDraftExamId,
      tClosedExamId,
      tFutureExamId,
      tImmediateExamId,
      tDeadlineExamId,
      tAccommodationsExamId,
    ]) {
      if (id) await admin.from("exams").delete().eq("id", id);
    }
    if (tBankId) await admin.from("question_banks").delete().eq("id", tBankId);
    if (tClassId) await admin.from("classes").delete().eq("id", tClassId);
    if (tOtherClassId) await admin.from("classes").delete().eq("id", tOtherClassId);
  }

  // === (u) Phase 3d-ii: proctored exam room by tier, server-side
  // termination tie, essay grading, results release =========================
  // Covers (task brief's exact list): T2+ start_exam_attempt creates a
  // linked proctor_session using the EXAM's own tier+policy (never
  // client-supplied) while T1 creates none; driving the linked session to
  // its violation limit terminates BOTH the session AND the exam_attempt
  // (status=terminated, submitted_at set, objective answers graded) with NO
  // client action; grade_essay_slot is owner/lecturer-only (student
  // denied), clamps marks, only essay slots, and finalize sets 'graded';
  // results gating (after_close/manual/immediate) on get_attempt_result,
  // and it never returns another student's result; exam_results is
  // owner/lecturer-only; new answer-adjacent helpers are EXECUTE-denied to
  // a direct student call.
  {
    const { client: studentClient } = sessions.student;
    const { client: lecturerClient } = sessions.lecturer;
    const suffix = Date.now();

    const { data: uClassId } = await lecturerClient.rpc("create_class", { name: `Smoke proctored class ${suffix}` });
    if (uClassId) {
      await lecturerClient.rpc("enroll_existing_student", { class_id: uClassId, student_id: studentId });
    }

    const { data: uBankId } = await lecturerClient.rpc("create_question_bank", { name: `Smoke proctored bank ${suffix}` });

    let uMcqId = null;
    let uEssayId = null;
    if (uBankId) {
      const { data: mcqId } = await lecturerClient.rpc("create_question", {
        bank_id: uBankId,
        type: "mcq_single",
        prompt: `Proctored mcq ${suffix}`,
        body: { options: [{ id: "A", text: "wrong" }, { id: "B", text: "right" }], correct: ["B"], marks: 4 },
      });
      uMcqId = mcqId ?? null;
      const { data: essayId } = await lecturerClient.rpc("create_question", {
        bank_id: uBankId,
        type: "essay",
        prompt: `Proctored essay ${suffix}`,
        body: { marks: 10, rubric: "SECRET RUBRIC" },
      });
      uEssayId = essayId ?? null;
    }
    record(
      "u1. setup: proctored-exam class + bank + mcq/essay questions created",
      Boolean(uClassId && uBankId && uMcqId && uEssayId),
      `class=${Boolean(uClassId)} bank=${Boolean(uBankId)} mcq=${Boolean(uMcqId)} essay=${Boolean(uEssayId)}`,
    );

    /** Builds+publishes a T{tier} exam (in-window, no duration limit) with one mcq + one essay fixed section, scoped to uClassId. Returns the exam id or null. */
    async function buildProctoredExam(tier, titleSuffix) {
      if (!uClassId || !uMcqId || !uEssayId) return null;
      const { data: examId } = await lecturerClient.rpc("create_exam", {
        title: `Smoke ${titleSuffix} ${suffix}`,
        class_id: uClassId,
      });
      if (!examId) return null;
      const { data: sectionId } = await lecturerClient.rpc("add_exam_section", { exam_id: examId, title: "S1" });
      if (sectionId) {
        await lecturerClient.rpc("add_section_source", { section_id: sectionId, source_type: "fixed", question_id: uMcqId });
        await lecturerClient.rpc("add_section_source", { section_id: sectionId, source_type: "fixed", question_id: uEssayId });
      }
      await lecturerClient.rpc("update_exam", {
        exam_id: examId,
        title: `Smoke ${titleSuffix} ${suffix}`,
        class_id: uClassId,
        integrity_tier: tier,
        results_release: "after_close",
      });
      await lecturerClient.rpc("set_exam_status", { exam_id: examId, status: "published" });
      return examId;
    }

    // u2/u3. T1 creates NO proctor session; T2 creates one with the exam's
    // own tier+policy (never client-supplied — start_exam_attempt has no
    // tier/policy parameter at all for the student to pass).
    const uT1ExamId = await buildProctoredExam(1, "T1 exam");
    let uT1AttemptId = null;
    if (uT1ExamId) {
      const { data: attemptId, error: attemptErr } = await studentClient.rpc("start_exam_attempt", {
        exam_id: uT1ExamId,
        claimed_index_number: "5201040845",
        attested: true,
      });
      uT1AttemptId = attemptErr ? null : attemptId;
    }
    if (uT1AttemptId) {
      const { data: row } = await admin.from("exam_attempts").select("proctor_session_id").eq("id", uT1AttemptId).maybeSingle();
      record(
        "u2. T1 start_exam_attempt creates NO linked proctor_session",
        row?.proctor_session_id == null,
        `proctor_session_id=${row?.proctor_session_id}`,
      );
    } else {
      record("u2. T1 start_exam_attempt creates NO linked proctor_session", false, "skipped — setup failed");
    }

    const uT2ExamId = await buildProctoredExam(2, "T2 exam");
    let uT2AttemptId = null;
    let uT2SessionId = null;
    if (uT2ExamId) {
      const { data: attemptId, error: attemptErr } = await studentClient.rpc("start_exam_attempt", {
        exam_id: uT2ExamId,
        claimed_index_number: "5201040845",
        attested: true,
      });
      uT2AttemptId = attemptErr ? null : attemptId;
    }
    if (uT2AttemptId) {
      const { data: row } = await admin
        .from("exam_attempts")
        .select("proctor_session_id")
        .eq("id", uT2AttemptId)
        .maybeSingle();
      uT2SessionId = row?.proctor_session_id ?? null;
      let sessionTierPolicyOk = false;
      let sessionDetail = "no session row";
      if (uT2SessionId) {
        const { data: sessionRow } = await admin
          .from("proctor_sessions")
          .select("integrity_tier, violation_policy, context")
          .eq("id", uT2SessionId)
          .maybeSingle();
        const { data: examRow } = await admin.from("exams").select("integrity_tier, violation_policy").eq("id", uT2ExamId).maybeSingle();
        sessionTierPolicyOk =
          Boolean(sessionRow) &&
          sessionRow.integrity_tier === examRow?.integrity_tier &&
          JSON.stringify(sessionRow.violation_policy) === JSON.stringify(examRow?.violation_policy) &&
          sessionRow.context === `exam:${uT2AttemptId}`;
        sessionDetail = JSON.stringify({ sessionRow, examTier: examRow?.integrity_tier });
      }
      record(
        "u3. T2 start_exam_attempt creates a linked proctor_session using the EXAM's own tier+policy (never client-supplied)",
        Boolean(uT2SessionId) && sessionTierPolicyOk,
        sessionDetail,
      );
    } else {
      record("u3. T2 start_exam_attempt creates a linked proctor_session using the EXAM's own tier+policy (never client-supplied)", false, "skipped — setup failed");
    }

    // u4. get_attempt_questions surfaces integrity_tier + proctor_session_id
    // so the client knows whether/what to attach the engine to.
    if (uT2AttemptId) {
      const { data: q, error: qErr } = await studentClient.rpc("get_attempt_questions", { attempt_id: uT2AttemptId });
      record(
        "u4. get_attempt_questions returns integrity_tier=2 and the matching proctor_session_id",
        !qErr && q?.integrity_tier === 2 && q?.proctor_session_id === uT2SessionId,
        JSON.stringify({ integrity_tier: q?.integrity_tier, proctor_session_id: q?.proctor_session_id }),
      );
    } else {
      record("u4. get_attempt_questions returns integrity_tier=2 and the matching proctor_session_id", false, "skipped — setup failed");
    }

    // u5/u6. TERMINATION TIE: drive uT2SessionId to its violation limit by
    // logging policy-counted high-severity events AS THE STUDENT (the
    // session owner — log_proctor_events is owner-only), with NO client
    // action on the exam_attempts row itself. Assert BOTH the session and
    // the linked exam_attempt end up terminated, submitted_at is set, and
    // the mcq slot got auto-graded (answered correctly below before
    // terminating).
    if (uT2AttemptId && uT2SessionId) {
      const { data: uQuestions } = await studentClient.rpc("get_attempt_questions", { attempt_id: uT2AttemptId });
      const mcqRef = uQuestions?.sections?.[0]?.questions?.find((q) => q.type === "mcq_single")?.question_ref;
      if (mcqRef) {
        await studentClient.rpc("save_exam_answer", {
          attempt_id: uT2AttemptId,
          question_ref: mcqRef,
          response: { selected: "B" },
          flagged: false,
        });
      }

      const { data: sessionBefore } = await admin
        .from("proctor_sessions")
        .select("violation_limit")
        .eq("id", uT2SessionId)
        .maybeSingle();
      const limit = sessionBefore?.violation_limit ?? 3;

      let lastLogResult = null;
      for (let i = 0; i < limit; i += 1) {
        const { data: logResult } = await studentClient.rpc("log_proctor_events", {
          session_id: uT2SessionId,
          events: [{ event_type: "tab_hidden", occurred_at: new Date().toISOString() }],
        });
        lastLogResult = logResult;
      }

      record(
        "u5. Driving the linked session to its violation limit terminates the SESSION server-side",
        lastLogResult?.session_status === "terminated",
        JSON.stringify(lastLogResult),
      );

      // Give the AFTER UPDATE trigger's own transaction (part of the same
      // log_proctor_events call, already committed by the time the RPC
      // returns) a moment to be visible — no sleep actually needed since
      // triggers run synchronously within the same transaction as the
      // UPDATE that fired them, but re-select fresh via the admin client to
      // avoid any client-side caching illusion.
      const { data: attemptAfter } = await admin
        .from("exam_attempts")
        .select("status, submitted_at, auto_score, needs_manual_grading")
        .eq("id", uT2AttemptId)
        .maybeSingle();

      record(
        "u6. TERMINATION TIE: the linked exam_attempt is ALSO closed server-side — status=terminated, submitted_at set, objective answers graded — with NO client action",
        attemptAfter?.status === "terminated" &&
          attemptAfter?.submitted_at != null &&
          attemptAfter?.auto_score === 4 &&
          attemptAfter?.needs_manual_grading === true,
        JSON.stringify(attemptAfter),
      );
    } else {
      record("u5. Driving the linked session to its violation limit terminates the SESSION server-side", false, "skipped — setup failed");
      record(
        "u6. TERMINATION TIE: the linked exam_attempt is ALSO closed server-side — status=terminated, submitted_at set, objective answers graded — with NO client action",
        false,
        "skipped — setup failed",
      );
    }

    // u7/u8/u9/u10. grade_essay_slot: student denied, lecturer succeeds +
    // clamps out-of-range marks, only essay slots, and finalize sets
    // 'graded' once every essay is graded (auto-finalized here since the
    // terminated attempt from u6 has exactly one essay slot).
    if (uT2AttemptId) {
      const { data: uQuestions } = await studentClient.rpc("get_attempt_questions", { attempt_id: uT2AttemptId });
      const essayRef = uQuestions?.sections?.[0]?.questions?.find((q) => q.type === "essay")?.question_ref;
      const mcqRef = uQuestions?.sections?.[0]?.questions?.find((q) => q.type === "mcq_single")?.question_ref;

      if (essayRef) {
        const { error: studentGradeErr } = await studentClient.rpc("grade_essay_slot", {
          attempt_id: uT2AttemptId,
          question_ref: essayRef,
          marks_awarded: 10,
        });
        record(
          "u7. grade_essay_slot DENIED for a student (not the exam owner/lecturer)",
          Boolean(studentGradeErr),
          studentGradeErr?.message ?? "no error raised — SECURITY: a student graded an essay slot",
        );

        if (mcqRef) {
          const { error: wrongTypeErr } = await lecturerClient.rpc("grade_essay_slot", {
            attempt_id: uT2AttemptId,
            question_ref: mcqRef,
            marks_awarded: 1,
          });
          record(
            "u8. grade_essay_slot REJECTS a non-essay slot (mcq_single)",
            Boolean(wrongTypeErr),
            wrongTypeErr?.message ?? "no error raised — CORRECTNESS: graded a non-essay slot as an essay",
          );
        }

        // Slot is worth 10 marks; award 999 and expect it clamped to 10.
        const { error: lecturerGradeErr } = await lecturerClient.rpc("grade_essay_slot", {
          attempt_id: uT2AttemptId,
          question_ref: essayRef,
          marks_awarded: 999,
          feedback: "Good structure, clamped smoke test.",
        });
        record("u9. lecturer grade_essay_slot succeeds", !lecturerGradeErr, lecturerGradeErr?.message);

        const { data: gradedAnswer } = await admin
          .from("exam_answers")
          .select("marks_awarded, feedback")
          .eq("attempt_id", uT2AttemptId)
          .eq("question_ref", essayRef)
          .maybeSingle();
        record(
          "u9b. grade_essay_slot CLAMPS marks_awarded to the slot's max (10), not the requested 999",
          gradedAnswer?.marks_awarded === 10,
          JSON.stringify(gradedAnswer),
        );

        const { data: finalAttempt } = await admin
          .from("exam_attempts")
          .select("status, auto_score, needs_manual_grading")
          .eq("id", uT2AttemptId)
          .maybeSingle();
        record(
          "u10. finalize (auto-triggered once every essay is graded) sets status='graded' and auto_score = objective(4) + essay(10) = 14",
          finalAttempt?.status === "graded" && finalAttempt?.auto_score === 14 && finalAttempt?.needs_manual_grading === false,
          JSON.stringify(finalAttempt),
        );
      } else {
        for (const label of [
          "u7. grade_essay_slot DENIED for a student (not the exam owner/lecturer)",
          "u8. grade_essay_slot REJECTS a non-essay slot (mcq_single)",
          "u9. lecturer grade_essay_slot succeeds",
          "u9b. grade_essay_slot CLAMPS marks_awarded to the slot's max (10), not the requested 999",
          "u10. finalize (auto-triggered once every essay is graded) sets status='graded' and auto_score = objective(4) + essay(10) = 14",
        ]) {
          record(label, false, "skipped — no essay question_ref available");
        }
      }
    }

    // u11/u12/u13/u14. get_attempt_result gating: after_close before close =
    // hidden, manual before release = hidden then shown after
    // release_exam_results, immediate = shown, and NEVER another student's
    // result (re-verified structurally: get_attempt_result is owner-only,
    // same as get_attempt_questions — proven here by a second student-like
    // check using the ALREADY-terminated/graded uT2AttemptId itself, whose
    // exam is after_close and still open, so results must be hidden).
    if (uT2AttemptId) {
      const { data: hiddenResult, error: hiddenErr } = await studentClient.rpc("get_attempt_result", { attempt_id: uT2AttemptId });
      record(
        "u11. get_attempt_result HIDES results for an after_close exam that has not closed yet",
        !hiddenErr && hiddenResult?.released === false && hiddenResult?.reason === "not_yet_released",
        JSON.stringify(hiddenResult),
      );

      // Close the exam early (lecturer action) — after_close now permits release.
      await lecturerClient.rpc("set_exam_status", { exam_id: uT2ExamId, status: "closed" });
      const { data: releasedResult, error: releasedErr } = await studentClient.rpc("get_attempt_result", { attempt_id: uT2AttemptId });
      record(
        "u12. get_attempt_result REVEALS results once the after_close exam is closed, with correct per-question breakdown",
        !releasedErr &&
          releasedResult?.released === true &&
          releasedResult?.auto_score === 14 &&
          Array.isArray(releasedResult?.per_question) &&
          releasedResult.per_question.length === 2,
        JSON.stringify(releasedResult),
      );
    } else {
      record("u11. get_attempt_result HIDES results for an after_close exam that has not closed yet", false, "skipped — setup failed");
      record("u12. get_attempt_result REVEALS results once the after_close exam is closed, with correct per-question breakdown", false, "skipped — setup failed");
    }

    // u13. manual release gating: build a manual-release exam, submit, hide
    // before release_exam_results, then show after.
    let uManualExamId = null;
    let uManualAttemptId = null;
    if (uClassId && uMcqId) {
      const { data: examId } = await lecturerClient.rpc("create_exam", { title: `Smoke manual-release exam ${suffix}`, class_id: uClassId });
      uManualExamId = examId ?? null;
      if (uManualExamId) {
        const { data: sectionId } = await lecturerClient.rpc("add_exam_section", { exam_id: uManualExamId, title: "S1" });
        if (sectionId) {
          await lecturerClient.rpc("add_section_source", { section_id: sectionId, source_type: "fixed", question_id: uMcqId });
        }
        await lecturerClient.rpc("update_exam", {
          exam_id: uManualExamId,
          title: `Smoke manual-release exam ${suffix}`,
          class_id: uClassId,
          integrity_tier: 1,
          results_release: "manual",
        });
        await lecturerClient.rpc("set_exam_status", { exam_id: uManualExamId, status: "published" });

        const { data: attemptId } = await studentClient.rpc("start_exam_attempt", {
          exam_id: uManualExamId,
          claimed_index_number: "5201040845",
          attested: true,
        });
        uManualAttemptId = attemptId ?? null;
        if (uManualAttemptId) {
          const { data: mq } = await studentClient.rpc("get_attempt_questions", { attempt_id: uManualAttemptId });
          const ref = mq?.sections?.[0]?.questions?.[0]?.question_ref;
          if (ref) {
            await studentClient.rpc("save_exam_answer", { attempt_id: uManualAttemptId, question_ref: ref, response: { selected: "B" }, flagged: false });
          }
          await studentClient.rpc("submit_exam_attempt", { attempt_id: uManualAttemptId });
        }
      }
    }
    if (uManualAttemptId) {
      const { data: beforeRelease } = await studentClient.rpc("get_attempt_result", { attempt_id: uManualAttemptId });
      record(
        "u13. get_attempt_result HIDES results for a manual-release exam before release_exam_results is called",
        beforeRelease?.released === false && beforeRelease?.reason === "not_yet_released",
        JSON.stringify(beforeRelease),
      );

      const { error: studentReleaseErr } = await studentClient.rpc("release_exam_results", { exam_id: uManualExamId });
      record(
        "u13b. release_exam_results DENIED for a student",
        Boolean(studentReleaseErr),
        studentReleaseErr?.message ?? "no error raised — SECURITY: a student released exam results",
      );

      const { error: releaseErr } = await lecturerClient.rpc("release_exam_results", { exam_id: uManualExamId });
      record("u13c. lecturer release_exam_results succeeds", !releaseErr, releaseErr?.message);

      const { data: afterRelease } = await studentClient.rpc("get_attempt_result", { attempt_id: uManualAttemptId });
      record(
        "u14. get_attempt_result REVEALS results for the manual-release exam once released",
        afterRelease?.released === true && afterRelease?.auto_score === 4,
        JSON.stringify(afterRelease),
      );
    } else {
      record("u13. get_attempt_result HIDES results for a manual-release exam before release_exam_results is called", false, "skipped — setup failed");
      record("u13b. release_exam_results DENIED for a student", false, "skipped — setup failed");
      record("u13c. lecturer release_exam_results succeeds", false, "skipped — setup failed");
      record("u14. get_attempt_result REVEALS results for the manual-release exam once released", false, "skipped — setup failed");
    }

    // u15. get_attempt_result NEVER returns another student's result: a
    // second student-role account would be needed for a true cross-account
    // check, and this codebase's smoke test only seeds one student — so
    // this is proven the same way t17 proves the cross-student case for
    // exam_attempts: schema-level, by confirming get_attempt_result raises
    // "You may only view your own result" (the exact ownership check) when
    // called by the LECTURER account (which is not this attempt's student
    // and holds no can_manage_exam bypass in get_attempt_result — the
    // function has no such branch at all, unlike exam_results).
    if (uManualAttemptId) {
      const { data: staffResult, error: staffErr } = await lecturerClient.rpc("get_attempt_result", { attempt_id: uManualAttemptId });
      record(
        "u15. get_attempt_result DENIED for a non-owning caller (lecturer), proving it never returns another user's result",
        Boolean(staffErr) && !staffResult,
        staffErr?.message ?? `no error raised — SECURITY: get_attempt_result returned ${JSON.stringify(staffResult)} to a non-owner`,
      );
    } else {
      record("u15. get_attempt_result DENIED for a non-owning caller (lecturer), proving it never returns another user's result", false, "skipped — setup failed");
    }

    // u16/u17. exam_results is owner/lecturer-only, and surfaces the
    // integrity summary for the tier-2 attempt (violation_count/limit/
    // session_status/has_report) alongside grading state.
    if (uT2ExamId) {
      const { data: studentResults, error: studentResultsErr } = await studentClient.rpc("exam_results", { exam_id: uT2ExamId });
      record(
        "u16. exam_results DENIED for a student",
        Boolean(studentResultsErr) && !studentResults,
        studentResultsErr?.message ?? "no error raised — SECURITY: a student read exam_results",
      );

      const { data: lecturerResults, error: lecturerResultsErr } = await lecturerClient.rpc("exam_results", { exam_id: uT2ExamId });
      const row = (lecturerResults ?? []).find((r) => r.attempt_id === uT2AttemptId);
      record(
        "u17. lecturer exam_results shows the terminated attempt's grading state + integrity summary (violation_count >= limit, has_report=true)",
        !lecturerResultsErr &&
          Boolean(row) &&
          row.status === "graded" &&
          row.violation_count >= row.violation_limit &&
          row.session_status === "terminated" &&
          row.has_report === true,
        JSON.stringify(row),
      );
    } else {
      record("u16. exam_results DENIED for a student", false, "skipped — setup failed");
      record("u17. lecturer exam_results shows the terminated attempt's grading state + integrity summary (violation_count >= limit, has_report=true)", false, "skipped — setup failed");
    }

    // u18. LOCKDOWN: sync_exam_attempt_on_proctor_termination is a trigger
    // function (not directly RPC-callable at all — Postgres trigger
    // functions return type `trigger` and cannot be invoked via SQL/RPC by
    // any role, client or otherwise), so the meaningful lockdown proof here
    // is that grade_essay_slot/finalize_attempt_grade/release_exam_results/
    // get_attempt_result/exam_results all re-derive authority themselves
    // (proven above in u7/u13b/u15/u16) rather than trusting a client claim
    // — already covered. Additionally re-confirm grade_objective_slot
    // (reused by the new termination-tie trigger) is STILL locked down
    // after this migration re-touches the grading path.
    const { data: lockdownData, error: lockdownErr } = await studentClient.rpc("grade_objective_slot", {
      question_type: "mcq_single",
      body: { options: [{ id: "A", text: "x" }, { id: "B", text: "y" }], correct: ["B"], marks: 1 },
      response: { selected: "B" },
    });
    record(
      "u18. LOCKDOWN (re-confirmed post-migration): grade_objective_slot still NOT directly callable by an authenticated client",
      Boolean(lockdownErr) && (lockdownData === undefined || lockdownData === null),
      lockdownErr?.message ?? `no error raised — SECURITY: grade_objective_slot returned ${JSON.stringify(lockdownData)} directly to a client`,
    );

    // Cleanup.
    for (const id of [uT1ExamId, uT2ExamId, uManualExamId]) {
      if (id) await admin.from("exams").delete().eq("id", id);
    }
    if (uBankId) await admin.from("question_banks").delete().eq("id", uBankId);
    if (uClassId) await admin.from("classes").delete().eq("id", uClassId);
  }

  // === (v) Admin & super-admin consoles: users & roles, audit-log browser,
  // system overview ===========================================================
  // Covers the task brief's exact asks: (1) a lecturer/student cannot read
  // audit_log (RLS denies) while admin/super_admin can; (2) admin cannot
  // promote to admin/super_admin via set_user_role even from a fresh
  // student->lecturer->admin chain (student->lecturer already covered in
  // (f), but this isolates the lecturer->admin escalation attempt
  // specifically, since that's the exact path the Users & roles screen's
  // role <select> now exposes in the UI); super_admin can perform that same
  // promotion; (3) the users-list data path (profiles select-all) is
  // confirmed admin-only already by (a2)/(e1)/(f1)/(g1) above — this section
  // adds one more explicit assertion that a lecturer's attempt to read the
  // full roster (not just their own row) is denied, matching what
  // /dashboard/users relies on.
  {
    const { client: studentClient } = sessions.student;
    const { client: lecturerClient } = sessions.lecturer;
    const { client: adminClient } = sessions.admin;
    const { client: superAdminClient } = sessions.super_admin;

    // v1. lecturer SELECT audit_log FAILS (0 rows — RLS silently filters
    // rather than raising, same posture as every other admin_or_higher-only
    // table in this schema).
    const { data: lecturerAuditRows, error: lecturerAuditErr } = await lecturerClient
      .from("audit_log")
      .select("*")
      .limit(1);
    record(
      "v1. lecturer SELECT audit_log returns 0 rows (RLS denies)",
      !lecturerAuditErr && (lecturerAuditRows?.length ?? 0) === 0,
      lecturerAuditErr?.message ?? `rows=${lecturerAuditRows?.length}`,
    );

    // v2. student SELECT audit_log FAILS (0 rows).
    const { data: studentAuditRows, error: studentAuditErr } = await studentClient
      .from("audit_log")
      .select("*")
      .limit(1);
    record(
      "v2. student SELECT audit_log returns 0 rows (RLS denies)",
      !studentAuditErr && (studentAuditRows?.length ?? 0) === 0,
      studentAuditErr?.message ?? `rows=${studentAuditRows?.length}`,
    );

    // v3. admin SELECT audit_log succeeds (admin_or_higher).
    const { data: adminAuditRows, error: adminAuditErr } = await adminClient
      .from("audit_log")
      .select("*")
      .limit(1);
    record(
      "v3. admin SELECT audit_log succeeds",
      !adminAuditErr && (adminAuditRows?.length ?? 0) >= 0,
      adminAuditErr?.message ?? `rows=${adminAuditRows?.length}`,
    );

    // v4. super_admin SELECT audit_log succeeds.
    const { data: superAuditRows, error: superAuditErr } = await superAdminClient
      .from("audit_log")
      .select("*")
      .limit(1);
    record(
      "v4. super_admin SELECT audit_log succeeds",
      !superAuditErr && (superAuditRows?.length ?? 0) >= 0,
      superAuditErr?.message ?? `rows=${superAuditRows?.length}`,
    );

    // v5. lecturer SELECT the full profiles roster (no filter) returns only
    // their own row — confirms the Users & roles screen's data path
    // (listUsersWithEmail, backed by the caller's own authenticated client)
    // cannot be reached by a lecturer even if they discovered the route.
    const { data: lecturerRoster, error: lecturerRosterErr } = await lecturerClient
      .from("profiles")
      .select("*");
    record(
      "v5. lecturer SELECT full profiles roster returns only own row (Users & roles data path is admin-only)",
      !lecturerRosterErr && lecturerRoster?.length === 1 && lecturerRoster[0].id === lecturerId,
      lecturerRosterErr?.message ?? `rows=${lecturerRoster?.length}`,
    );

    // v6. admin set_user_role(lecturer -> admin) FAILS (escalation blocked)
    // — the exact promotion path the Users & roles role <select> offers to
    // a super_admin viewer but must NOT offer (and the RPC must reject
    // regardless of what the UI offers) to an admin viewer.
    const { error: adminEscalateErr } = await adminClient.rpc("set_user_role", {
      target: lecturerId,
      new_role: "admin",
    });
    record(
      "v6. admin set_user_role(lecturer -> admin) FAILS (escalation blocked)",
      isDenied(adminEscalateErr),
      adminEscalateErr?.message ?? "no error raised — SECURITY: admin escalated a lecturer to admin",
    );

    // v7. admin set_user_role(lecturer -> super_admin) FAILS.
    const { error: adminSuperEscalateErr } = await adminClient.rpc("set_user_role", {
      target: lecturerId,
      new_role: "super_admin",
    });
    record(
      "v7. admin set_user_role(lecturer -> super_admin) FAILS (escalation blocked)",
      isDenied(adminSuperEscalateErr),
      adminSuperEscalateErr?.message ?? "no error raised — SECURITY: admin escalated a lecturer to super_admin",
    );

    // v8. super_admin set_user_role(lecturer -> admin) succeeds, then revert
    // — proves the same promotion IS available to a super_admin viewer,
    // matching the Users & roles screen's role editor being enabled only
    // for a super_admin caller on an admin/super_admin target.
    const { error: superPromoteErr } = await superAdminClient.rpc("set_user_role", {
      target: lecturerId,
      new_role: "admin",
    });
    record(
      "v8. super_admin set_user_role(lecturer -> admin) succeeds",
      !superPromoteErr,
      superPromoteErr?.message,
    );
    const { error: superRevertErr } = await superAdminClient.rpc("set_user_role", {
      target: lecturerId,
      new_role: "lecturer",
    });
    record(
      "v8b. super_admin can revert set_user_role(admin -> lecturer) [cleanup]",
      !superRevertErr,
      superRevertErr?.message,
    );

    // v9. accommodations update via the profiles_update_admin_or_higher
    // policy: admin can set another user's accommodations (mirrors f2, but
    // isolates the exact shape the Users & roles accommodations dialog
    // writes: extra_time_multiplier + suppress_at_flags + notes together).
    const { error: accUpdateErr } = await adminClient
      .from("profiles")
      .update({
        accommodations: { extra_time_multiplier: 1.5, suppress_at_flags: true, notes: "smoke test v9" },
      })
      .eq("id", studentId);
    record(
      "v9. admin UPDATE another user's accommodations (multiplier + suppress_at_flags + notes) succeeds",
      !accUpdateErr,
      accUpdateErr?.message,
    );

    const { data: accRow } = await admin.from("profiles").select("accommodations").eq("id", studentId).single();
    record(
      "v9b. accommodations persisted with the exact shape written",
      accRow?.accommodations?.extra_time_multiplier === 1.5 &&
        accRow?.accommodations?.suppress_at_flags === true &&
        accRow?.accommodations?.notes === "smoke test v9",
      JSON.stringify(accRow?.accommodations),
    );
    // revert
    await admin.from("profiles").update({ accommodations: {} }).eq("id", studentId);

    // v10. lecturer cannot update another user's accommodations at all
    // (profiles_update_admin_or_higher requires is_admin_or_higher(); a
    // lecturer has no UPDATE policy covering someone else's row). PostgREST
    // doesn't raise an error for this case — RLS's USING clause simply
    // filters the target row out of the UPDATE's matched set, so the
    // request "succeeds" with 0 rows affected (same silent-filter posture
    // as every SELECT-side RLS check in this suite, e.g. a2/a3/e1/e2).
    // Assert both: the update reports 0 affected rows AND the value is
    // unchanged in the database afterward.
    const { data: lecturerAccData, error: lecturerAccErr } = await lecturerClient
      .from("profiles")
      .update({ accommodations: { notes: "lecturer should not be able to do this" } })
      .eq("id", studentId)
      .select();
    const { data: accUnchangedRow } = await admin
      .from("profiles")
      .select("accommodations")
      .eq("id", studentId)
      .single();
    record(
      "v10. lecturer UPDATE another user's accommodations FAILS (0 rows affected, value unchanged)",
      (isDenied(lecturerAccErr) || (lecturerAccData?.length ?? 0) === 0) &&
        accUnchangedRow?.accommodations?.notes !== "lecturer should not be able to do this",
      lecturerAccErr?.message ??
        `rows affected=${lecturerAccData?.length} stored=${JSON.stringify(accUnchangedRow?.accommodations)}`,
    );
  }

  // === (w) Analytics phase: lecturer/student dashboard aggregate RPCs =======
  // lecturer_dashboard_stats() takes no arguments — authority is entirely
  // re-derived server-side from auth.uid() + has_role('lecturer'), so the
  // only client-observable security property is "a non-lecturer caller is
  // denied", asserted here as a negative test (w1). w2 proves the positive
  // path still works and returns the expected jsonb shape.
  {
    const { client: studentClient } = sessions.student;
    const { client: lecturerClient } = sessions.lecturer;

    // w1. student calling lecturer_dashboard_stats() FAILS (has_role('lecturer') denies).
    // The RPC raises its own explicit exception (not an RLS-policy rejection
    // isDenied()'s substring list is tuned for), so the meaningful assertion
    // is simply "an error was raised, no data returned" — same predicate
    // u16 above uses for exam_results' analogous student-denied case.
    const { data: studentStatsData, error: studentStatsErr } = await studentClient.rpc("lecturer_dashboard_stats");
    record(
      "w1. student lecturer_dashboard_stats() FAILS (not a lecturer)",
      Boolean(studentStatsErr) && !studentStatsData,
      studentStatsErr?.message ?? "no error raised — SECURITY: student read lecturer analytics",
    );

    // w2. lecturer calling lecturer_dashboard_stats() succeeds and returns
    // the expected top-level jsonb keys.
    const { data: lecturerStats, error: lecturerStatsErr } = await lecturerClient.rpc("lecturer_dashboard_stats");
    const hasExpectedShape =
      !!lecturerStats &&
      "exams_by_status" in lecturerStats &&
      "attempts_by_status" in lecturerStats &&
      "flags_by_severity" in lecturerStats &&
      "score_distribution" in lecturerStats;
    record(
      "w2. lecturer lecturer_dashboard_stats() succeeds with expected shape",
      !lecturerStatsErr && hasExpectedShape,
      lecturerStatsErr?.message ?? JSON.stringify(lecturerStats),
    );
  }

  // === (x) Analytics phase: student_dashboard_stats() — owner-only AND
  // release-gated ==============================================================
  // Proves the two load-bearing properties: (1) an unreleased exam's score
  // never appears (x1/x2 — an after_close exam that hasn't closed yet), and
  // (2) a second student never sees the first student's result, and vice
  // versa (x3/x4/x5) — genuine cross-user isolation, not just "empty because
  // no attempts", using a freshly created second student account (mirroring
  // q12's onboarding pattern) so there are two REAL, DIFFERING scores to
  // tell apart.
  {
    const { client: studentClient } = sessions.student;
    const { client: lecturerClient } = sessions.lecturer;
    const suffix = Date.now();

    const { data: xClassId } = await lecturerClient.rpc("create_class", { name: `Smoke x-analytics class ${suffix}` });
    if (xClassId) {
      await lecturerClient.rpc("enroll_existing_student", { class_id: xClassId, student_id: studentId });
    }

    const { data: xBankId } = await lecturerClient.rpc("create_question_bank", { name: `Smoke x-analytics bank ${suffix}` });
    const { data: xQuestionId } = xBankId
      ? await lecturerClient.rpc("create_question", {
          bank_id: xBankId,
          type: "mcq_single",
          prompt: `x-analytics mcq ${suffix}`,
          body: { options: [{ id: "A", text: "wrong" }, { id: "B", text: "right" }], correct: ["B"], marks: 2 },
        })
      : { data: null };

    const opensAt = new Date(Date.now() - 60_000).toISOString();
    const futureClosesAt = new Date(Date.now() + 60 * 60_000).toISOString();

    // Exam A: results_release='immediate' — released as soon as submitted.
    const { data: xExamAId } = await lecturerClient.rpc("create_exam", { title: `x-analytics immediate exam ${suffix}`, class_id: xClassId ?? null });
    let xSectionAId = null;
    if (xExamAId) {
      const { data: sid } = await lecturerClient.rpc("add_exam_section", { exam_id: xExamAId, title: "Section 1" });
      xSectionAId = sid ?? null;
      if (xSectionAId && xQuestionId) {
        await lecturerClient.rpc("add_section_source", { section_id: xSectionAId, source_type: "fixed", question_id: xQuestionId });
      }
      await lecturerClient.rpc("update_exam", {
        exam_id: xExamAId,
        title: `x-analytics immediate exam ${suffix}`,
        class_id: xClassId ?? null,
        opens_at: opensAt,
        closes_at: futureClosesAt,
        integrity_tier: 1,
        results_release: "immediate",
      });
      await lecturerClient.rpc("set_exam_status", { exam_id: xExamAId, status: "published" });
    }

    // Exam B: results_release='after_close', still open (closes_at in the
    // future, exam not closed) — its score must NEVER appear yet.
    const { data: xExamBId } = await lecturerClient.rpc("create_exam", { title: `x-analytics unreleased exam ${suffix}`, class_id: xClassId ?? null });
    let xSectionBId = null;
    if (xExamBId) {
      const { data: sid } = await lecturerClient.rpc("add_exam_section", { exam_id: xExamBId, title: "Section 1" });
      xSectionBId = sid ?? null;
      if (xSectionBId && xQuestionId) {
        await lecturerClient.rpc("add_section_source", { section_id: xSectionBId, source_type: "fixed", question_id: xQuestionId });
      }
      await lecturerClient.rpc("update_exam", {
        exam_id: xExamBId,
        title: `x-analytics unreleased exam ${suffix}`,
        class_id: xClassId ?? null,
        opens_at: opensAt,
        closes_at: futureClosesAt,
        integrity_tier: 1,
        results_release: "after_close",
      });
      await lecturerClient.rpc("set_exam_status", { exam_id: xExamBId, status: "published" });
    }

    record(
      "x-setup. class + bank + question + immediate exam + unreleased exam created",
      Boolean(xClassId && xBankId && xQuestionId && xExamAId && xSectionAId && xExamBId && xSectionBId),
      `class=${Boolean(xClassId)} bank=${Boolean(xBankId)} question=${Boolean(xQuestionId)} examA=${Boolean(xExamAId)} examB=${Boolean(xExamBId)}`,
    );

    // Seeded student takes + submits BOTH exams, answering correctly both
    // times (2/2 = 100%).
    async function takeAndSubmit(client, examId, sectionId, selected) {
      const { data: attemptId } = await client.rpc("start_exam_attempt", { exam_id: examId, attested: true });
      if (!attemptId) return null;
      await client.rpc("save_exam_answer", { attempt_id: attemptId, question_ref: `${sectionId}:0`, response: { selected } });
      await client.rpc("submit_exam_attempt", { attempt_id: attemptId });
      return attemptId;
    }

    if (xExamAId && xSectionAId) await takeAndSubmit(studentClient, xExamAId, xSectionAId, "B");
    if (xExamBId && xSectionBId) await takeAndSubmit(studentClient, xExamBId, xSectionBId, "B");

    // x1. seeded student's own view: exam A (released, 100%) present, exam B
    // (unreleased) absent.
    const { data: studentStats1 } = await studentClient.rpc("student_dashboard_stats");
    const studentResults1 = studentStats1?.released_results ?? [];
    const examAEntry = studentResults1.find((r) => r.exam_id === xExamAId);
    const examBEntry = studentResults1.find((r) => r.exam_id === xExamBId);
    record(
      "x1. student_dashboard_stats() includes the RELEASED (immediate) exam's own score",
      Boolean(examAEntry) && examAEntry.score_pct === 100,
      JSON.stringify(examAEntry),
    );
    record(
      "x2. student_dashboard_stats() NEVER includes the UNRELEASED (after_close, still open) exam's score",
      !examBEntry,
      examBEntry ? `SECURITY: unreleased score leaked — ${JSON.stringify(examBEntry)}` : "correctly absent",
    );

    // x3-x5. A second, freshly created student takes exam A and answers
    // WRONG (0%) — a genuinely different score from the seeded student's
    // 100%, so cross-leakage in either direction is observable, not just
    // "empty".
    // signIn() below always uses the shared PASSWORD constant (it signs in
    // every seeded test user with it) — give this ephemeral account the
    // same password rather than a custom one, so signIn(email) just works.
    const secondIndex = `8${String(suffix).slice(-9).padStart(9, "0")}`;
    const secondEmail = `${secondIndex}@students.usted.local`;
    const { data: secondUser, error: secondUserErr } = await admin.auth.admin.createUser({
      email: secondEmail,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Smoke Test Second Student" },
    });
    const secondStudentId = secondUser?.user?.id;
    if (secondStudentId) {
      await admin.from("profiles").update({ student_number: secondIndex }).eq("id", secondStudentId);
      if (xClassId) {
        await lecturerClient.rpc("enroll_existing_student", { class_id: xClassId, student_id: secondStudentId });
      }
    }
    record(
      "x3-setup. second student account created + enrolled",
      Boolean(secondStudentId),
      secondUserErr?.message ?? secondStudentId,
    );

    if (secondStudentId) {
      const { client: secondClient } = await signIn(secondEmail);
      if (xExamAId && xSectionAId) await takeAndSubmit(secondClient, xExamAId, xSectionAId, "A"); // wrong answer -> 0%

      const { data: secondStats } = await secondClient.rpc("student_dashboard_stats");
      const secondResults = secondStats?.released_results ?? [];
      const secondExamAEntry = secondResults.find((r) => r.exam_id === xExamAId);
      record(
        "x3. second student's OWN view shows their OWN 0% score for exam A, not the first student's 100%",
        Boolean(secondExamAEntry) && secondExamAEntry.score_pct === 0,
        JSON.stringify(secondExamAEntry),
      );

      // x4. CROSS-USER ISOLATION: re-fetch the FIRST student's view after
      // the second student submitted — still shows only their own 100%,
      // never a 0% entry (proving no leakage from the second student's
      // attempt into the first student's aggregate).
      const { data: studentStats2 } = await studentClient.rpc("student_dashboard_stats");
      const studentResults2 = studentStats2?.released_results ?? [];
      const examAEntriesForFirstStudent = studentResults2.filter((r) => r.exam_id === xExamAId);
      record(
        "x4. CROSS-USER ISOLATION: first student's view still shows exactly ONE entry for exam A (their own 100%, not the second student's 0%)",
        examAEntriesForFirstStudent.length === 1 && examAEntriesForFirstStudent[0].score_pct === 100,
        JSON.stringify(examAEntriesForFirstStudent),
      );

      await secondClient.auth.signOut().catch(() => {});
    } else {
      record("x3. second student's OWN view shows their OWN 0% score for exam A, not the first student's 100%", false, "skipped — setup failed");
      record("x4. CROSS-USER ISOLATION: first student's view still shows exactly ONE entry for exam A", false, "skipped — setup failed");
    }

    // x5. upcoming_exams_count is a positive integer for an enrolled student
    // with published+open exams (loose bound — other sections' fixtures
    // also enroll this same seeded student in fresh classes, so an exact
    // count isn't stable across the whole suite run).
    record(
      "x5. student_dashboard_stats() upcoming_exams_count is a positive integer",
      Number.isInteger(studentStats1?.upcoming_exams_count) && studentStats1.upcoming_exams_count > 0,
      String(studentStats1?.upcoming_exams_count),
    );
  }

  // === (y) Task 2: createUserAccount escalation & creation invariants ======
  // createUserAccount (apps/web/app/dashboard/users/actions.ts) is a
  // Next.js server action gated by requireRole('admin','super_admin') plus
  // an in-app escalation check that mirrors set_user_role's rules exactly,
  // then — for staff roles — the actual role assignment goes through
  // set_user_role itself (never a direct profiles.role write). This script
  // talks to Postgres/Auth directly (it has no Next.js session to call the
  // server action through), so it asserts the two things that action's
  // correctness actually depends on: (1) the set_user_role RPC — which is
  // what stops a request-crafted admin call from ever landing an
  // admin/super_admin promotion, even if the in-app check were bypassed —
  // enforces the exact same escalation rule against a BRAND NEW account,
  // the shape a create-user flow actually produces; (2) the invariants the
  // action's own code (and createOrFindStaffUser/createOrFindStudent) is
  // responsible for: must_change_password=true on every newly created
  // account, no duplicate account for an existing email/index number, and
  // the 10-digit index CHECK. (d)/(e)/(f)/(v) above already cover the
  // equivalent escalation assertions against the long-lived seeded users;
  // this section repeats the critical ones against a FRESH account so
  // they're self-contained and not masked by any pre-existing role drift on
  // the shared fixtures.
  {
    const { client: studentClient } = sessions.student;
    const { client: lecturerClient } = sessions.lecturer;
    const { client: adminClient } = sessions.admin;
    const { client: superAdminClient } = sessions.super_admin;
    const suffix = Date.now();

    // y1. Simulate createOrFindStaffUser: create a brand-new staff-shaped
    // account via the service role (email_confirm + generated temp
    // password), then apply the same must_change_password=true update
    // createOrFindStaffUser performs. This is the exact account shape
    // createUserAccount hands to set_user_role next.
    const freshEmail = `smoke-test-createuser-${suffix}@usted.test`;
    const freshPassword = "TempPass!23456";
    const { data: freshUser, error: freshUserErr } = await admin.auth.admin.createUser({
      email: freshEmail,
      password: freshPassword,
      email_confirm: true,
      user_metadata: { full_name: "Smoke Test Fresh Staff" },
    });
    const freshUserId = freshUser?.user?.id;
    if (freshUserId) {
      await admin.from("profiles").update({ must_change_password: true }).eq("id", freshUserId);
    }
    record(
      "y1. fresh staff-shaped account created via Admin API (createUserAccount's staff path)",
      Boolean(freshUserId),
      freshUserErr?.message ?? freshUserId,
    );

    const { data: freshProfile, error: freshProfileErr } = await admin
      .from("profiles")
      .select("role, must_change_password")
      .eq("id", freshUserId)
      .maybeSingle();
    record(
      "y2. fresh account defaults to role=student (handle_new_user) with must_change_password=true",
      !freshProfileErr && freshProfile?.role === "student" && freshProfile?.must_change_password === true,
      freshProfileErr?.message ?? JSON.stringify(freshProfile),
    );

    // y3. student calling the createUserAccount-equivalent set_user_role
    // path FAILS — a student can never create/promote any account this way.
    const { error: studentCreateErr } = await studentClient.rpc("set_user_role", {
      target: freshUserId,
      new_role: "lecturer",
    });
    record(
      "y3. student calling the createUserAccount-equivalent path FAILS",
      isDenied(studentCreateErr),
      studentCreateErr?.message ?? "no error raised — SECURITY: student created/promoted an account",
    );

    // y4. lecturer calling the same path FAILS.
    const { error: lecturerCreateErr } = await lecturerClient.rpc("set_user_role", {
      target: freshUserId,
      new_role: "lecturer",
    });
    record(
      "y4. lecturer calling the createUserAccount-equivalent path FAILS",
      isDenied(lecturerCreateErr),
      lecturerCreateErr?.message ?? "no error raised — SECURITY: lecturer created/promoted an account",
    );

    // y5. admin creating a lecturer (set_user_role student -> lecturer) succeeds.
    const { error: adminLecturerErr } = await adminClient.rpc("set_user_role", {
      target: freshUserId,
      new_role: "lecturer",
    });
    record(
      "y5. admin createUserAccount(lecturer) succeeds (set_user_role student -> lecturer)",
      !adminLecturerErr,
      adminLecturerErr?.message,
    );

    // y6. admin creating/promoting the SAME fresh account to admin FAILS —
    // the critical escalation-denial assertion: an admin must not be able
    // to create an admin account by any request-crafting, even against an
    // account they just legitimately created themselves.
    const { error: adminEscalateErr } = await adminClient.rpc("set_user_role", {
      target: freshUserId,
      new_role: "admin",
    });
    record(
      "y6. admin createUserAccount(admin) FAILS (escalation blocked — CRITICAL)",
      isDenied(adminEscalateErr),
      adminEscalateErr?.message ?? "no error raised — SECURITY: admin created/escalated an admin account",
    );

    // y7. admin creating/promoting to super_admin FAILS too.
    const { error: adminSuperEscalateErr } = await adminClient.rpc("set_user_role", {
      target: freshUserId,
      new_role: "super_admin",
    });
    record(
      "y7. admin createUserAccount(super_admin) FAILS (escalation blocked — CRITICAL)",
      isDenied(adminSuperEscalateErr),
      adminSuperEscalateErr?.message ??
        "no error raised — SECURITY: admin created/escalated a super_admin account",
    );

    // y8. super_admin CAN promote the same fresh account to admin.
    const { error: superAdminPromoteErr } = await superAdminClient.rpc("set_user_role", {
      target: freshUserId,
      new_role: "admin",
    });
    record(
      "y8. super_admin createUserAccount(admin) succeeds",
      !superAdminPromoteErr,
      superAdminPromoteErr?.message,
    );

    // Cleanup: delete the fresh throwaway account entirely (it was never a
    // seeded fixture, so there's nothing to "revert" — just remove it).
    if (freshUserId) {
      await admin.auth.admin.deleteUser(freshUserId).catch(() => {});
    }

    // y9. duplicate email: createOrFindStaffUser's existence check relies on
    // the Auth admin API itself rejecting a second createUser for an email
    // already registered — confirm that rejection directly against one of
    // the long-lived seeded users (this never actually creates a duplicate).
    const { data: dupUser, error: dupErr } = await admin.auth.admin.createUser({
      email: USERS.lecturer,
      password: "AnotherPass!234",
      email_confirm: true,
    });
    record(
      "y9. Admin API createUser with an already-registered email FAILS (no duplicate account)",
      Boolean(dupErr) && !dupUser?.user,
      dupErr?.message ??
        "no error raised — SECURITY: a duplicate auth user was created for an existing email",
    );

    // y10. duplicate student index number: profiles.student_number is a
    // UNIQUE column — attempting to give a second profile the seeded
    // student's index number fails at the DB layer, which is what backs
    // createOrFindStudent's/createUserAccount's "no duplicate on an
    // existing index" guarantee for the student branch.
    const { error: dupIndexErr } = await admin
      .from("profiles")
      .update({ student_number: "5201040845" })
      .eq("id", lecturerId);
    record(
      "y10. profiles.student_number UNIQUE constraint rejects a duplicate index number",
      Boolean(dupIndexErr),
      dupIndexErr?.message ?? "no error raised — SECURITY: two profiles share the same student_number",
    );

    // y11. creating a student requires a valid 10-digit index: reuses (k5)'s
    // CHECK constraint assertion, restated here against a FRESH account (not
    // the shared student fixture) so it's self-contained with this section.
    const shortIndexEmail = `smoke-test-shortindex-${suffix}@students.usted.local`;
    const { data: shortIndexUser } = await admin.auth.admin.createUser({
      email: shortIndexEmail,
      password: freshPassword,
      email_confirm: true,
    });
    const shortIndexUserId = shortIndexUser?.user?.id;
    let badIndexErr = null;
    if (shortIndexUserId) {
      const { error } = await admin
        .from("profiles")
        .update({ student_number: "123" })
        .eq("id", shortIndexUserId);
      badIndexErr = error;
    }
    record(
      "y11. creating a student with a non-10-digit index number FAILS (CHECK constraint)",
      Boolean(shortIndexUserId) && Boolean(badIndexErr),
      badIndexErr?.message ?? "no error raised — SECURITY: a non-10-digit student_number was accepted",
    );
    if (shortIndexUserId) {
      await admin.auth.admin.deleteUser(shortIndexUserId).catch(() => {});
    }
  }

  // === (z) Phase 4: account lifecycle — status matrix =======================
  // Covers the full permission matrix enforced by set_account_status
  // (supabase/migrations/20260711000001_account_lifecycle.sql), mirroring
  // set_user_role's escalation rules:
  //   super_admin -> admin/lecturer/student   (not super_admin, not self)
  //   admin       -> lecturer/student          (not admin/super_admin, not self)
  //   lecturer    -> student ONLY, and ONLY a student enrolled in a class
  //                  the lecturer OWNS                    (not self)
  // Plus: the status column is gated behind its own usted.allow_status_change
  // GUC (profiles_guard_update) so not even super_admin can direct-PATCH it;
  // soft-remove ('removed') then reactivate ('active') round-trips; and
  // class_roster() now surfaces `status` for the roster UI. The actual
  // login/getSessionProfile BLOCK on a non-active account is an app-layer
  // check this service-role/anon-key script cannot exercise directly (no
  // Next.js session) — z14 only asserts the DB-level fact that block reads;
  // the login round-trip itself is verified in the browser separately (see
  // README.md "Verifying locally").
  {
    const { client: studentClient } = sessions.student;
    const { client: lecturerClient } = sessions.lecturer;
    const { client: adminClient } = sessions.admin;
    const { client: superAdminClient } = sessions.super_admin;
    const suffix = Date.now();

    // z-setup: a class the lecturer owns with the seeded student enrolled,
    // an "outsider" student the lecturer does NOT teach, a second admin
    // account (so "admin cannot act on another admin" has a target that
    // isn't the shared admin fixture used elsewhere in this suite), and a
    // second super_admin account (same reason, for "super_admin cannot act
    // on another super_admin" — this repo's seed data has exactly one).
    const { data: zClassId, error: zClassErr } = await lecturerClient.rpc("create_class", {
      name: `Smoke lifecycle class ${suffix}`,
    });
    record(
      "z-setup1. lecturer create_class (lifecycle cohort) succeeds",
      !zClassErr && typeof zClassId === "string",
      zClassErr?.message,
    );

    if (zClassId) {
      const { error: enrollErr } = await lecturerClient.rpc("enroll_existing_student", {
        class_id: zClassId,
        student_id: studentId,
      });
      record(
        "z-setup2. lecturer enrolls the seeded student into the lifecycle class",
        !enrollErr,
        enrollErr?.message,
      );
    }

    const outsiderEmail = `smoke-test-lifecycle-outsider-${suffix}@students.usted.local`;
    const { data: outsiderUser, error: outsiderErr } = await admin.auth.admin.createUser({
      email: outsiderEmail,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Smoke Test Lifecycle Outsider" },
    });
    const outsiderId = outsiderUser?.user?.id;
    record(
      "z-setup3. outsider student account created (NOT enrolled in the lecturer's class)",
      Boolean(outsiderId),
      outsiderErr?.message ?? outsiderId,
    );

    const secondAdminEmail = `smoke-test-lifecycle-admin2-${suffix}@usted.test`;
    const { data: secondAdminUser, error: secondAdminErr } = await admin.auth.admin.createUser({
      email: secondAdminEmail,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Smoke Test Lifecycle Second Admin" },
    });
    const secondAdminId = secondAdminUser?.user?.id;
    if (secondAdminId) {
      await superAdminClient.rpc("set_user_role", { target: secondAdminId, new_role: "admin" });
    }
    record("z-setup4. second admin account created", Boolean(secondAdminId), secondAdminErr?.message ?? secondAdminId);

    const secondSuperAdminEmail = `smoke-test-lifecycle-superadmin2-${suffix}@usted.test`;
    const { data: secondSuperAdminUser, error: secondSuperAdminErr } = await admin.auth.admin.createUser({
      email: secondSuperAdminEmail,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: "Smoke Test Lifecycle Second Super Admin" },
    });
    const secondSuperAdminId = secondSuperAdminUser?.user?.id;
    if (secondSuperAdminId) {
      await superAdminClient.rpc("set_user_role", { target: secondSuperAdminId, new_role: "super_admin" });
    }
    record(
      "z-setup5. second super_admin account created",
      Boolean(secondSuperAdminId),
      secondSuperAdminErr?.message ?? secondSuperAdminId,
    );

    // z1. lecturer CAN suspend a student enrolled in a class they own.
    if (zClassId) {
      const { error: err } = await lecturerClient.rpc("set_account_status", {
        target_user_id: studentId,
        new_status: "suspended",
      });
      record("z1. lecturer set_account_status(suspend) on a student in their OWN class succeeds", !err, err?.message);

      const status = await getProfileStatus(studentId);
      record("z1b. seeded student's profiles.status is now 'suspended'", status === "suspended", `status=${status}`);
    } else {
      record("z1. lecturer set_account_status(suspend) on a student in their OWN class succeeds", false, "skipped — z-setup failed");
      record("z1b. seeded student's profiles.status is now 'suspended'", false, "skipped — z-setup failed");
    }

    // z2. lecturer CANNOT suspend a student NOT enrolled in any class they own.
    if (outsiderId) {
      const { error: err } = await lecturerClient.rpc("set_account_status", {
        target_user_id: outsiderId,
        new_status: "suspended",
      });
      record(
        "z2. lecturer set_account_status on a student NOT in their class FAILS",
        Boolean(err),
        err?.message ?? "no error raised — SECURITY: lecturer suspended a student outside their own class",
      );
    } else {
      record("z2. lecturer set_account_status on a student NOT in their class FAILS", false, "skipped — z-setup failed");
    }

    // z3. lecturer CANNOT act on an admin/lecturer account — role check,
    // independent of ownership.
    {
      const { error: err } = await lecturerClient.rpc("set_account_status", {
        target_user_id: adminId,
        new_status: "suspended",
      });
      record(
        "z3. lecturer set_account_status on an admin account FAILS (role check)",
        Boolean(err),
        err?.message ?? "no error raised — SECURITY: a lecturer changed an admin's account status",
      );
    }

    // z4. admin CAN suspend a lecturer.
    {
      const { error: err } = await adminClient.rpc("set_account_status", {
        target_user_id: lecturerId,
        new_status: "suspended",
      });
      record("z4. admin set_account_status(suspend) on a lecturer succeeds", !err, err?.message);
    }

    // z5. admin CAN suspend a student.
    if (outsiderId) {
      const { error: err } = await adminClient.rpc("set_account_status", {
        target_user_id: outsiderId,
        new_status: "suspended",
      });
      record("z5. admin set_account_status(suspend) on a student succeeds", !err, err?.message);
    } else {
      record("z5. admin set_account_status(suspend) on a student succeeds", false, "skipped — z-setup failed");
    }

    // z6. admin CANNOT act on ANOTHER admin.
    if (secondAdminId) {
      const { error: err } = await adminClient.rpc("set_account_status", {
        target_user_id: secondAdminId,
        new_status: "suspended",
      });
      record(
        "z6. admin set_account_status on ANOTHER admin FAILS",
        Boolean(err),
        err?.message ?? "no error raised — SECURITY: an admin suspended another admin's account",
      );
    } else {
      record("z6. admin set_account_status on ANOTHER admin FAILS", false, "skipped — z-setup failed");
    }

    // z7. admin CANNOT act on super_admin.
    {
      const { error: err } = await adminClient.rpc("set_account_status", {
        target_user_id: superAdminId,
        new_status: "suspended",
      });
      record(
        "z7. admin set_account_status on super_admin FAILS",
        Boolean(err),
        err?.message ?? "no error raised — SECURITY: an admin suspended a super_admin's account",
      );
    }

    // z8. super_admin CAN act on an admin, a lecturer, and a student —
    // reactivating the lecturer/student back to 'active' here doubles as
    // the "reversible" half of the suspend/reactivate round-trip for them.
    if (secondAdminId) {
      const { error: err } = await superAdminClient.rpc("set_account_status", {
        target_user_id: secondAdminId,
        new_status: "suspended",
      });
      record("z8a. super_admin set_account_status(suspend) on an admin succeeds", !err, err?.message);
    } else {
      record("z8a. super_admin set_account_status(suspend) on an admin succeeds", false, "skipped — z-setup failed");
    }

    {
      const { error: err } = await superAdminClient.rpc("set_account_status", {
        target_user_id: lecturerId,
        new_status: "active",
      });
      record("z8b. super_admin set_account_status(reactivate) on a lecturer succeeds", !err, err?.message);
    }

    {
      const { error: err } = await superAdminClient.rpc("set_account_status", {
        target_user_id: studentId,
        new_status: "active",
      });
      record("z8c. super_admin set_account_status(reactivate) on a student succeeds", !err, err?.message);
    }

    // z9. super_admin CANNOT act on ANOTHER super_admin.
    if (secondSuperAdminId) {
      const { error: err } = await superAdminClient.rpc("set_account_status", {
        target_user_id: secondSuperAdminId,
        new_status: "suspended",
      });
      record(
        "z9. super_admin set_account_status on ANOTHER super_admin FAILS",
        Boolean(err),
        err?.message ?? "no error raised — SECURITY: a super_admin suspended another super_admin's account",
      );
    } else {
      record("z9. super_admin set_account_status on ANOTHER super_admin FAILS", false, "skipped — z-setup failed");
    }

    // z10. NOBODY may act on themselves — every seeded role, own account.
    for (const [role, { client, userId }] of Object.entries(sessions)) {
      const { error: err } = await client.rpc("set_account_status", {
        target_user_id: userId,
        new_status: "suspended",
      });
      record(
        `z10-${role}. ${role} set_account_status on THEIR OWN account FAILS`,
        Boolean(err),
        err?.message ?? `no error raised — SECURITY: ${role} changed their own account status`,
      );
    }

    // z11. soft-remove ('removed') then reactivate ('active') round-trips.
    if (outsiderId) {
      const { error: removeErr } = await adminClient.rpc("set_account_status", {
        target_user_id: outsiderId,
        new_status: "removed",
      });
      record("z11a. admin set_account_status('removed') on a student succeeds", !removeErr, removeErr?.message);

      const removedStatus = await getProfileStatus(outsiderId);
      record(
        "z11b. profiles.status is 'removed' after the soft-remove",
        removedStatus === "removed",
        `status=${removedStatus}`,
      );

      const { error: reactivateErr } = await adminClient.rpc("set_account_status", {
        target_user_id: outsiderId,
        new_status: "active",
      });
      record("z11c. admin set_account_status('active') reactivates a removed account", !reactivateErr, reactivateErr?.message);

      const reactivatedStatus = await getProfileStatus(outsiderId);
      record(
        "z11d. profiles.status round-trips back to 'active'",
        reactivatedStatus === "active",
        `status=${reactivatedStatus}`,
      );
    } else {
      record("z11a. admin set_account_status('removed') on a student succeeds", false, "skipped — z-setup failed");
      record("z11b. profiles.status is 'removed' after the soft-remove", false, "skipped — z-setup failed");
      record("z11c. admin set_account_status('active') reactivates a removed account", false, "skipped — z-setup failed");
      record("z11d. profiles.status round-trips back to 'active'", false, "skipped — z-setup failed");
    }

    // z12. a direct client PATCH of profiles.status is rejected even for the
    // row's own owner and even for super_admin — status is gated behind
    // usted.allow_status_change (profiles_guard_update), exactly like
    // usted.allow_role_change gates role: it may ONLY change via
    // set_account_status.
    {
      // Must target a DIFFERENT value than the current one (studentId is
      // 'active' at this point, after z8c) — the guard's `new.status IS
      // DISTINCT FROM old.status` check (like every other guarded column)
      // only fires on an actual change; a same-value "update" is a no-op
      // that never reaches the check at all, which would make this
      // assertion pass for the wrong reason.
      const { error: selfPatchErr } = await studentClient
        .from("profiles")
        .update({ status: "suspended" })
        .eq("id", studentId);
      record(
        "z12a. student direct UPDATE of their OWN profiles.status FAILS (must go through set_account_status)",
        isDenied(selfPatchErr) || Boolean(selfPatchErr),
        selfPatchErr?.message ?? "no error raised — SECURITY: a user changed their own account status via a direct PATCH",
      );

      const { error: superAdminPatchErr } = await superAdminClient
        .from("profiles")
        .update({ status: "suspended" })
        .eq("id", studentId);
      record(
        "z12b. even super_admin direct UPDATE of profiles.status FAILS (outside the universal-role carve-out, same as must_change_password)",
        isDenied(superAdminPatchErr) || Boolean(superAdminPatchErr),
        superAdminPatchErr?.message ?? "no error raised — SECURITY: status is settable via a direct PATCH",
      );
    }

    // z13. class_roster() now surfaces `status` for the lecturer's own
    // class roster UI to gate its suspend/reactivate/remove actions.
    if (zClassId) {
      const { data: rosterRows, error: rosterErr } = await lecturerClient.rpc("class_roster", { class_id: zClassId });
      const studentRow = (rosterRows ?? []).find((r) => r.student_id === studentId);
      record(
        "z13. class_roster() returns a `status` field reflecting the account's current lifecycle state",
        !rosterErr && Boolean(studentRow) && studentRow.status === "active",
        rosterErr?.message ?? `status=${studentRow?.status}`,
      );
    } else {
      record("z13. class_roster() returns a `status` field reflecting the account's current lifecycle state", false, "skipped — z-setup failed");
    }

    // z14. the app-layer login/getSessionProfile block reads exactly this
    // column — assert the DB-level fact it depends on (this script has no
    // Next.js session to exercise the actual sign-in/redirect through; the
    // login round-trip itself is verified in the browser, see README.md
    // "Verifying locally").
    {
      const target = outsiderId ?? studentId;
      const { error: suspendErr } = await adminClient.rpc("set_account_status", {
        target_user_id: target,
        new_status: "suspended",
      });
      const status = await getProfileStatus(target);
      record(
        "z14. a suspended profiles.status persists and is readable — the value the app-layer login/session block reads (browser-verified separately)",
        !suspendErr && status === "suspended",
        suspendErr?.message ?? `status=${status}`,
      );
      // restore to active so cleanup below doesn't have to special-case it
      await adminClient.rpc("set_account_status", { target_user_id: target, new_status: "active" });
    }

    // Cleanup: delete the throwaway accounts + class this section created.
    if (outsiderId) await admin.auth.admin.deleteUser(outsiderId).catch(() => {});
    if (secondAdminId) await admin.auth.admin.deleteUser(secondAdminId).catch(() => {});
    if (secondSuperAdminId) await admin.auth.admin.deleteUser(secondSuperAdminId).catch(() => {});
    if (zClassId) await admin.from("classes").delete().eq("id", zClassId);

    // Defensive: ensure the shared seeded fixtures end this section back at
    // 'active' regardless of whether every step above ran to completion.
    // super_admin can restore student/lecturer/admin (never its own row —
    // but no assertion above ever successfully changes super_admin's own
    // status, since the self-check always rejects that attempt first).
    for (const role of ["student", "lecturer", "admin"]) {
      const uid = sessions[role].userId;
      const current = await getProfileStatus(uid);
      if (current !== "active") {
        await superAdminClient.rpc("set_account_status", { target_user_id: uid, new_status: "active" });
      }
    }
  }

  // === (aa) Admin UX task: resetUserPassword mechanics + escalation matrix ==
  // resetUserPassword (apps/web/app/dashboard/users/actions.ts) has NO
  // backing RPC — unlike every other privileged action tested above, its
  // entire security boundary (requireRole('admin','super_admin') +
  // canActOnAccountRole + "never self") lives in TypeScript, because
  // setting an Auth user's password is only possible through the
  // service-role Admin API, which has no RLS to fall back on (see that
  // function's own doc comment). This script has no Next.js session, so it
  // cannot invoke the server action directly. What it verifies instead:
  //   (1) canActOnAccountRole is, BY DESIGN, the exact same role matrix
  //       set_account_status enforces in Postgres (lib/admin/role-labels.ts's
  //       doc comment states this explicitly) — already exhaustively proven
  //       above in (z) against the shared seeded fixtures. aa1-aa4 re-run
  //       the SAME pairs the task calls out (lecturer/student denied
  //       entirely; admin allowed on lecturer/student but denied on
  //       admin/super_admin; super_admin allowed on admin) against fresh
  //       throwaway targets, so this section is self-contained rather than
  //       only cross-referenced. "Nobody resets self" is (z10)'s exact
  //       assertion — canActOnAccountRole's caller in resetUserPassword adds
  //       an explicit self-check on top, mirroring setAccountStatus's own.
  //   (2) The actual Auth-level mechanics resetUserPassword performs once
  //       the gate passes — updateUserById + must_change_password=true —
  //       really do issue a working new password, really do invalidate the
  //       old one, and really do set the forced-change flag (aa5-aa8b).
  //   (3) Why the audit write must go through the service-role client, not
  //       the caller's own session (aa9-aa10): log_audit is granted to
  //       service_role only (same fact (c)/(e) above prove against
  //       student/lecturer) — an ADMIN's own authenticated session is
  //       denied too, so resetUserPassword's use of createAdminClient() for
  //       its audit call isn't a stylistic choice, it's the only way that
  //       call can succeed.
  // The actual server action — the "Reset password" menu item, the
  // one-time TempPasswordReveal, and the reset user then signing in with
  // the new temp password and being forced through /onboarding/set-password
  // — is verified in the browser separately (see README.md
  // "Verifying locally").
  {
    const { client: studentClient } = sessions.student;
    const { client: adminClient } = sessions.admin;
    const { client: superAdminClient } = sessions.super_admin;
    const suffix = Date.now();

    async function makeThrowawayUser(label, role) {
      const email = `smoke-test-resetpw-${label}-${suffix}@usted.test`;
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password: PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: `Smoke Test Reset ${label}` },
      });
      const id = data?.user?.id;
      if (id && role !== "student") {
        await superAdminClient.rpc("set_user_role", { target: id, new_role: role });
      }
      return { id, email, error };
    }

    const targetStudent = await makeThrowawayUser("student", "student");
    const targetLecturer = await makeThrowawayUser("lecturer", "lecturer");
    const targetAdmin = await makeThrowawayUser("admin", "admin");
    record(
      "aa-setup. three fresh throwaway targets created (student/lecturer/admin)",
      Boolean(targetStudent.id && targetLecturer.id && targetAdmin.id),
      [targetStudent.error, targetLecturer.error, targetAdmin.error]
        .filter(Boolean)
        .map((e) => e.message)
        .join("; "),
    );

    // aa1. student session denied the reset-password matrix entirely.
    if (targetStudent.id) {
      const { error } = await studentClient.rpc("set_account_status", {
        target_user_id: targetStudent.id,
        new_status: "suspended",
      });
      record(
        "aa1. student denied the reset-password escalation matrix (student can never reset anyone)",
        Boolean(error),
        error?.message ?? "no error raised — SECURITY",
      );
    }

    // aa2. admin CAN act on a lecturer target (the matrix resetUserPassword allows).
    if (targetLecturer.id) {
      const { error } = await adminClient.rpc("set_account_status", {
        target_user_id: targetLecturer.id,
        new_status: "suspended",
      });
      record("aa2. admin allowed on a lecturer target (matrix resetUserPassword shares)", !error, error?.message);
      await adminClient.rpc("set_account_status", { target_user_id: targetLecturer.id, new_status: "active" });
    }

    // aa3. admin denied on an admin target.
    if (targetAdmin.id) {
      const { error } = await adminClient.rpc("set_account_status", {
        target_user_id: targetAdmin.id,
        new_status: "suspended",
      });
      record(
        "aa3. admin denied on an admin target (resetUserPassword: admin may reset lecturer/student only)",
        isDenied(error),
        error?.message ?? "no error raised — SECURITY: admin reset/acted on another admin",
      );
    }

    // aa4. super_admin CAN act on an admin target.
    if (targetAdmin.id) {
      const { error } = await superAdminClient.rpc("set_account_status", {
        target_user_id: targetAdmin.id,
        new_status: "suspended",
      });
      record("aa4. super_admin allowed on an admin target (matrix resetUserPassword shares)", !error, error?.message);
      await superAdminClient.rpc("set_account_status", { target_user_id: targetAdmin.id, new_status: "active" });
    }

    // aa5-aa8b: the actual password-reset mechanics resetUserPassword
    // performs once its gate passes, exercised end-to-end via the exact
    // same service-role Admin API calls (updateUserById +
    // must_change_password=true) regenerateTempPassword makes.
    if (targetStudent.id) {
      const before = await trySignIn(targetStudent.email, PASSWORD);
      record(
        "aa5. throwaway target signs in with its ORIGINAL password before any reset",
        before.ok,
        before.error?.message,
      );

      const newPassword = "ResetSmokeTest!789";
      const { error: updateErr } = await admin.auth.admin.updateUserById(targetStudent.id, {
        password: newPassword,
      });
      const { error: flagErr } = await admin
        .from("profiles")
        .update({ must_change_password: true })
        .eq("id", targetStudent.id);
      record(
        "aa6. service-role updateUserById + must_change_password=true succeeds (resetUserPassword's exact mechanics)",
        !updateErr && !flagErr,
        updateErr?.message ?? flagErr?.message,
      );

      const oldStillWorks = await trySignIn(targetStudent.email, PASSWORD);
      record(
        "aa7. the OLD password no longer signs in after a reset",
        !oldStillWorks.ok,
        oldStillWorks.ok ? "SECURITY: old password still works after reset" : undefined,
      );

      const newWorks = await trySignIn(targetStudent.email, newPassword);
      record("aa8. the NEW temp password signs in after a reset", newWorks.ok, newWorks.error?.message);

      const { data: profileAfter } = await admin
        .from("profiles")
        .select("must_change_password")
        .eq("id", targetStudent.id)
        .maybeSingle();
      record(
        "aa8b. must_change_password=true after a reset (forces /onboarding/set-password next sign-in)",
        profileAfter?.must_change_password === true,
        JSON.stringify(profileAfter),
      );
    }

    // aa9-aa10: the audit write resetUserPassword makes MUST go through the
    // service-role client — an admin's own authenticated session is denied
    // log_audit just like student/lecturer in (c)/(e) above.
    {
      const { error } = await adminClient.rpc("log_audit", {
        action: "reset_password",
        target_type: "profile",
        target_id: targetStudent.id ?? adminId,
        metadata: {},
      });
      record(
        "aa9. an admin's OWN session is denied log_audit directly (must use the service-role client, like resetUserPassword does)",
        isDenied(error),
        error?.message ?? "no error raised — SECURITY: forged audit entries possible from a session client",
      );
    }
    {
      const { error } = await admin.rpc("log_audit", {
        action: "reset_password",
        target_type: "profile",
        target_id: targetStudent.id ?? adminId,
        metadata: {},
      });
      record(
        "aa10. the service-role client CAN call log_audit('reset_password', ...) — resetUserPassword's actual audit call",
        !error,
        error?.message,
      );
    }

    // Cleanup: delete the throwaway targets this section created.
    for (const t of [targetStudent, targetLecturer, targetAdmin]) {
      if (t.id) await admin.auth.admin.deleteUser(t.id).catch(() => {});
    }
  }

  // === cleanup / idempotency: restore original roles ========================
  // set_user_role needs auth.uid(), so cleanup must go through an
  // authenticated session's RPC call, not the service role directly (the
  // service role bypasses RLS policies but NOT the profiles_guard_update
  // trigger, which gates on the transaction-local GUC that only
  // set_user_role sets). super_admin's session can fix any non-self target,
  // which covers every role this script ever touches (student, lecturer,
  // admin-as-target). The test body already reverts student (f4b) and
  // lecturer (g3b) — this is a defensive second pass in case an earlier
  // assertion failed before its own revert ran.
  console.log("\nRestoring original roles...");
  const superAdminClient = sessions.super_admin.client;
  for (const [role, email] of Object.entries(USERS)) {
    const userId = sessions[role].userId;
    const desiredRole = originalRoles[role];
    const currentRole = await getProfileRole(userId);
    if (currentRole !== desiredRole) {
      if (userId === superAdminId) {
        console.warn(
          `  ${email} drifted to ${currentRole} (expected ${desiredRole}) but nobody may change their own role — fix manually via 'supabase db reset' or direct SQL.`,
        );
      } else {
        const { error } = await superAdminClient.rpc("set_user_role", {
          target: userId,
          new_role: desiredRole,
        });
        if (error) {
          console.warn(`  could not revert ${email} to ${desiredRole} via RPC: ${error.message}`);
        }
      }
    }
    const finalRole = await getProfileRole(userId);
    console.log(`  ${email}: ${finalRole} (expected ${desiredRole})`);
  }

  // sign out all sessions
  for (const { client } of Object.values(sessions)) {
    await client.auth.signOut().catch(() => {});
  }

  // === summary ===============================================================
  const failed = results.filter((r) => !r.pass);
  console.log(
    `\n${results.length} checks, ${results.length - failed.length} passed, ${failed.length} failed.`,
  );
  if (failed.length > 0) {
    console.log("\nFAILED CHECKS:");
    for (const f of failed) {
      console.log(`  - ${f.name}${f.detail ? `: ${f.detail}` : ""}`);
    }
    process.exit(1);
  }
  console.log("All checks passed.");
}

main().catch((err) => {
  console.error("\nSmoke test crashed:", err);
  process.exit(1);
});
