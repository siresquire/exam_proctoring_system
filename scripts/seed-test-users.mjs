#!/usr/bin/env node
// LOCAL DEV ONLY. Idempotently (re)creates the four seeded test users that
// the RLS smoke test and manual QA rely on, after a `supabase db reset`
// wipes auth.users. Mirrors README.md "Test users": create via the Auth
// admin API (email_confirm: true), then set roles. super_admin is
// bootstrapped with the same transaction-local GUC escape hatch seed.sql
// documents (applied here through the local Postgres container); the other
// three are promoted from the super_admin session via set_user_role.
//
// Also (re)seeds the student test user's USTED index number so the identity
// cross-check + Phase 1.5 smoke tests have registry data to compare against.
//
// Refuses to run against anything but a local Supabase URL.
//
// Usage: node scripts/seed-test-users.mjs

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envLocalPath = path.resolve(__dirname, "..", "apps", "web", ".env.local");

function loadEnvLocal(filePath) {
  if (!existsSync(filePath)) return;
  for (const rawLine of readFileSync(filePath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!(key in process.env)) process.env[key] = line.slice(eq + 1).trim();
  }
}
loadEnvLocal(envLocalPath);

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_CONTAINER = process.env.SUPABASE_DB_CONTAINER || "supabase_db_exam_proctoring_system";

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY.",
  );
  process.exit(1);
}
if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(SUPABASE_URL)) {
  console.error(`Refusing to run against non-local URL: ${SUPABASE_URL}`);
  process.exit(1);
}

const PASSWORD = "Usted!Test2026";
const STUDENT_INDEX_NUMBER = "5201040845";
const USERS = [
  { email: "superadmin@usted.test", role: "super_admin", full_name: "Super Admin Test" },
  { email: "admin@usted.test", role: "admin", full_name: "Admin Test" },
  { email: "lecturer@usted.test", role: "lecturer", full_name: "Lecturer Test" },
  { email: "student@usted.test", role: "student", full_name: "Student Test" },
];

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function findUserByEmail(email) {
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (error) throw error;
  return data.users.find((u) => u.email === email) ?? null;
}

async function ensureUser({ email, full_name }) {
  const existing = await findUserByEmail(email);
  if (existing) return existing.id;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { full_name },
  });
  if (error) throw error;
  return data.user.id;
}

/** Run SQL inside the local Postgres container (bypasses PostgREST/RLS for the
 * documented seed-time escape hatches: super_admin bootstrap + student_number). */
function psql(sql) {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      DB_CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      input: sql,
      encoding: "utf8",
    },
  );
}

async function main() {
  console.log(`Target: ${SUPABASE_URL}\n`);

  const ids = {};
  for (const u of USERS) {
    ids[u.email] = await ensureUser(u);
    console.log(`  created/found ${u.email}: ${ids[u.email]}`);
  }

  // Bootstrap all four roles + the student index number directly in the DB,
  // guarded by the transaction-local usted.allow_role_change GUC (exactly the
  // pattern supabase/seed.sql uses for the first super_admin). This avoids the
  // chicken-and-egg of needing a super_admin session to call set_user_role
  // before any super_admin exists.
  const roleUpdates = USERS.map(
    (u) =>
      `update public.profiles set role = '${u.role}' where id = (select id from auth.users where email = '${u.email}');`,
  ).join("\n  ");

  psql(`begin;
  set local usted.allow_role_change = 'on';
  ${roleUpdates}
  update public.profiles set student_number = '${STUDENT_INDEX_NUMBER}'
    where id = (select id from auth.users where email = 'student@usted.test');
commit;`);

  console.log("\n  roles + student_number seeded via GUC-guarded transaction.");

  // Verify.
  const { data: profiles } = await admin
    .from("profiles")
    .select("role, student_number, id")
    .in("id", Object.values(ids));
  for (const u of USERS) {
    const p = profiles?.find((row) => row.id === ids[u.email]);
    console.log(`  ${u.email}: role=${p?.role} student_number=${p?.student_number ?? "null"}`);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("seed-test-users crashed:", err);
  process.exit(1);
});
