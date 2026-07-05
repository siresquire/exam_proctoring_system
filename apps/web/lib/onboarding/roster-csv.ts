/**
 * Phase 3a: CSV parsing + row validation for the roster importer, shared by
 * the client-side preview (components/onboarding/roster-import.tsx) and the
 * server action that actually creates/enrolls students
 * (app/dashboard/lecturer/classes/actions.ts) — the server action re-parses
 * and re-validates the same raw CSV text rather than trusting the client's
 * parsed rows, same "never trust the client" posture as
 * lib/forms/google-form-url.ts.
 *
 * Dependency-free by design (ponytail: this repo has no CSV library in
 * package.json, and the template is simple enough — three plain columns,
 * no embedded newlines expected) — a small RFC-4180-ish parser that handles
 * quoted fields (for names containing commas) without pulling in a package
 * for what is otherwise ~30 lines.
 */

export const ROSTER_CSV_TEMPLATE_HEADER = "full_name,index_number,phone";
export const ROSTER_CSV_TEMPLATE_EXAMPLE = "Ama Mensah,5201040845,0244000000";

/** Downloadable template shown/linked in the import UI. */
export const ROSTER_CSV_TEMPLATE = `${ROSTER_CSV_TEMPLATE_HEADER}\n${ROSTER_CSV_TEMPLATE_EXAMPLE}\n`;

const INDEX_NUMBER_PATTERN = /^\d{10}$/;

export interface RosterCsvRow {
  fullName: string;
  indexNumber: string;
  phone: string | null;
}

export type RosterRowStatus =
  | "valid"
  | "already_enrolled"
  | "duplicate_in_file"
  | "bad_index_format"
  | "missing_name";

export interface RosterRowPreview {
  rowNumber: number; // 1-based, counting the header as row 0
  fullName: string;
  indexNumber: string;
  phone: string | null;
  status: RosterRowStatus;
  /** Set when status is not "valid" — shown in the preview table and read by screen readers. */
  message?: string;
}

/** Splits one CSV line into fields, honoring double-quoted fields (with "" as an escaped quote). No support for embedded newlines inside a quoted field — the roster template does not need it. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields.map((f) => f.trim());
}

/** Parses raw CSV text into rows, skipping the header (matched loosely by column name, order-independent) and blank lines. */
export function parseRosterCsv(raw: string): RosterCsvRow[] {
  const lines = raw
    .split(/\r\n|\r|\n/)
    .map((l) => l)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const nameIdx = header.indexOf("full_name");
  const indexIdx = header.indexOf("index_number");
  const phoneIdx = header.indexOf("phone");

  // If the header doesn't look like our template at all, assume there is no
  // header row and the file starts straight with data in the documented
  // column order — more forgiving for a lecturer who stripped the header.
  const hasRecognizedHeader = nameIdx !== -1 && indexIdx !== -1;
  const dataLines = hasRecognizedHeader ? lines.slice(1) : lines;
  const [fNameIdx, fIndexIdx, fPhoneIdx] = hasRecognizedHeader ? [nameIdx, indexIdx, phoneIdx] : [0, 1, 2];

  return dataLines.map((line) => {
    const fields = splitCsvLine(line);
    return {
      fullName: (fields[fNameIdx] ?? "").trim(),
      indexNumber: (fields[fIndexIdx] ?? "").trim(),
      phone: fPhoneIdx >= 0 ? (fields[fPhoneIdx] ?? "").trim() || null : null,
    };
  });
}

/**
 * Validates parsed rows against format rules + each other (in-file
 * duplicates) + a caller-supplied set of index numbers already enrolled in
 * the target class. Pure/synchronous — the "already enrolled" set is looked
 * up by the caller (a DB round trip) and passed in, so this function stays
 * usable identically on the client (for the live preview) and the server
 * (for the pre-commit re-validation).
 */
export function validateRosterRows(
  rows: RosterCsvRow[],
  alreadyEnrolledIndexNumbers: ReadonlySet<string>,
): RosterRowPreview[] {
  const seen = new Set<string>();

  return rows.map((row, i) => {
    const rowNumber = i + 1;
    const base = { rowNumber, fullName: row.fullName, indexNumber: row.indexNumber, phone: row.phone };

    if (!row.fullName) {
      return { ...base, status: "missing_name" as const, message: "Full name is required." };
    }

    if (!INDEX_NUMBER_PATTERN.test(row.indexNumber)) {
      return {
        ...base,
        status: "bad_index_format" as const,
        message: "Index number must be exactly 10 digits.",
      };
    }

    if (seen.has(row.indexNumber)) {
      return {
        ...base,
        status: "duplicate_in_file" as const,
        message: "Duplicate index number elsewhere in this file.",
      };
    }
    seen.add(row.indexNumber);

    if (alreadyEnrolledIndexNumbers.has(row.indexNumber)) {
      return {
        ...base,
        status: "already_enrolled" as const,
        message: "Already enrolled in this class — will be skipped.",
      };
    }

    return { ...base, status: "valid" as const };
  });
}
