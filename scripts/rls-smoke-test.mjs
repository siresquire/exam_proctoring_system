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

  // === (l) Phase 1.6: face-presence detection events =========================
  {
    const { client: studentClient } = sessions.student;
    const context = `smoke-test-face-detection-${Date.now()}`;

    // l1. start a fresh session for this scenario.
    const { data: sessionId, error: startErr } = await studentClient.rpc("start_proctor_session", {
      context,
      tier: 2,
      claimed_index_number: "5201040845",
      attested: true,
    });
    record(
      "l1. student start_proctor_session succeeds for face-detection test",
      !startErr && typeof sessionId === "string",
      startErr?.message ?? `sessionId=${sessionId}`,
    );

    // l2. no_face_detected (debounced client-side already, so the server
    // just needs to accept the vocabulary) logs fine at medium severity and
    // does NOT count toward the violation limit.
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
      "l2. log_proctor_events accepts no_face_detected (medium) and does not bump violation_count",
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
    // toward the violation limit — drive it to the default limit (3) with
    // three high-severity multiple_faces_detected events and confirm
    // auto-termination + report filing, exactly like the generic
    // high-severity path in section (j), but exercising the new event type
    // specifically end-to-end.
    const { data: batch1, error: batch1Err } = await studentClient.rpc("log_proctor_events", {
      session_id: sessionId,
      events: [
        {
          event_type: "multiple_faces_detected",
          severity: "high",
          occurred_at: nowIso,
          meta: { faceCount: 2 },
        },
        {
          event_type: "multiple_faces_detected",
          severity: "high",
          occurred_at: nowIso,
          meta: { faceCount: 2 },
        },
      ],
    });
    record(
      "l4. two multiple_faces_detected (high) events accepted, violation_count=2, still active",
      !batch1Err && batch1?.session_status === "active" && batch1?.violation_count === 2,
      batch1Err?.message ??
        `session_status=${batch1?.session_status} violation_count=${batch1?.violation_count}`,
    );

    const { data: batch2, error: batch2Err } = await studentClient.rpc("log_proctor_events", {
      session_id: sessionId,
      events: [
        {
          event_type: "multiple_faces_detected",
          severity: "high",
          occurred_at: nowIso,
          meta: { faceCount: 3 },
        },
      ],
    });
    record(
      "l5. 3rd multiple_faces_detected (high) event terminates the session (violation_limit reached)",
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
    // allowlist, not "anything goes now that we added two more values").
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
