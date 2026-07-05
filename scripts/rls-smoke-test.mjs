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
