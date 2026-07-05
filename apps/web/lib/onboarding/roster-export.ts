/**
 * Phase 3a: roster export for mail-merge (PLAN.md "Student onboarding
 * without a domain") — CSV is REQUIRED (works with Google/Microsoft mail
 * merge tools out of the box); XLSX is intentionally NOT included (no XLSX
 * library in this repo's dependencies, and CSV alone already satisfies the
 * mail-merge use case — see README.md's Phase 3a section for the note).
 */

export interface RosterExportRow {
  fullName: string;
  indexNumber: string;
  loginUrl: string;
  /** Null when this row is an existing account with no freshly (re)generated password this session. */
  tempPassword: string | null;
}

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Builds the roster CSV text: full_name, index_number, login_url, temp_password. */
export function buildRosterCsv(rows: RosterExportRow[]): string {
  const header = "full_name,index_number,login_url,temp_password";
  const lines = rows.map((row) =>
    [
      csvEscape(row.fullName),
      csvEscape(row.indexNumber),
      csvEscape(row.loginUrl),
      csvEscape(row.tempPassword ?? "(existing — use reset)"),
    ].join(","),
  );
  return [header, ...lines].join("\n") + "\n";
}

/** Triggers a browser download of the given CSV text. Client-only. */
export function downloadCsv(filename: string, csvText: string) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
