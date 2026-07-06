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
