"use server";

import { revalidatePath } from "next/cache";

import { requireRole } from "@/lib/auth";
import { parseQuestionCsv } from "@/lib/questions/import/csv";
import { parseAiken } from "@/lib/questions/import/aiken";
import { parseGift } from "@/lib/questions/import/gift";
import { isValidRow, type ParsedQuestionRow } from "@/lib/questions/import/types";
import { bodyToWireShape } from "@/lib/questions/types";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/lib/supabase/types";

export type ImportFormat = "csv" | "aiken" | "gift";

/**
 * Server-side re-parse of the pasted/uploaded text for ANY of the three
 * formats — never trusts a client-parsed preview, same posture as Phase 3a's
 * roster importer (lib/onboarding/roster-csv.ts) and every other bulk-input
 * path in this codebase. Pure parsing only; no DB writes happen here.
 */
export async function previewQuestionImport(
  format: ImportFormat,
  rawText: string,
): Promise<{ error?: string; rows?: ParsedQuestionRow[] }> {
  await requireRole("lecturer", "admin");

  if (!rawText.trim()) {
    return { error: "Paste or upload some content first." };
  }

  const rows =
    format === "csv" ? parseQuestionCsv(rawText) : format === "aiken" ? parseAiken(rawText) : parseGift(rawText);

  if (rows.length === 0) {
    return { error: "No items found in that content." };
  }

  return { rows };
}

export interface CommitImportResult {
  error?: string;
  imported?: number;
  skipped?: number;
}

/**
 * Re-parses the SAME raw text server-side (never trusts the client's parsed
 * rows or which rows it claims are valid) and commits only rows that are
 * still valid at commit time. Category paths are resolved to category ids,
 * creating any missing category (and its ancestors) as needed via
 * create_question_category — idempotent by design (that RPC's unique
 * constraint means re-running an import with the same category paths never
 * creates duplicates; a unique_violation on a concurrent create is treated
 * as "someone already made it" and re-looked-up).
 */
export async function commitQuestionImport(
  bankId: string,
  format: ImportFormat,
  rawText: string,
): Promise<CommitImportResult> {
  await requireRole("lecturer", "admin");

  const client = await createClient();
  if (!client) {
    return { error: "Supabase is not configured in this environment." };
  }
  // Narrowed to a non-null local: TypeScript's null-narrowing on `client`
  // above does not survive being captured by the nested closures below.
  const supabase = client;

  const rows =
    format === "csv" ? parseQuestionCsv(rawText) : format === "aiken" ? parseAiken(rawText) : parseGift(rawText);

  const validRows = rows.filter(isValidRow);
  let imported = 0;
  const categoryCache = new Map<string, string>(); // "A/B" -> category id

  /** Looks up an existing category by (bank, parent, name); .is()/.eq() need to branch on parentId's nullness since a single call can't express "column = this string OR column IS NULL" through one typed overload. */
  async function findCategory(name: string, parentId: string | null): Promise<string | null> {
    const query = supabase
      .from("question_categories")
      .select("id")
      .eq("bank_id", bankId)
      .eq("name", name);
    const { data } = await (parentId === null ? query.is("parent_id", null) : query.eq("parent_id", parentId)).maybeSingle();
    return data?.id ?? null;
  }

  async function resolveCategoryId(path: string[]): Promise<string | null> {
    if (path.length === 0) return null;
    const key = path.join("/");
    if (categoryCache.has(key)) return categoryCache.get(key)!;

    let parentId: string | null = null;
    let builtPath = "";
    for (const segment of path) {
      builtPath = builtPath ? `${builtPath}/${segment}` : segment;
      const cached = categoryCache.get(builtPath);
      if (cached) {
        parentId = cached;
        continue;
      }

      // Look for an existing category with this (bank, parent, name) first
      // — avoids creating a duplicate when re-running an import, and avoids
      // relying solely on catching a unique_violation.
      const existingId = await findCategory(segment, parentId);
      if (existingId) {
        parentId = existingId;
        categoryCache.set(builtPath, existingId);
        continue;
      }

      const createResult: { data: string | null; error: { message: string } | null } = await supabase.rpc(
        "create_question_category",
        { bank_id: bankId, name: segment, parent_id: parentId },
      );
      const { data: newId, error } = createResult;
      if (error || !newId) {
        // Someone else created it concurrently, or another transient error
        // — re-look-up once before giving up on this branch.
        const retryId = await findCategory(segment, parentId);
        if (!retryId) {
          throw new Error(error?.message ?? `Could not create or find category "${segment}"`);
        }
        parentId = retryId;
        categoryCache.set(builtPath, retryId);
        continue;
      }
      parentId = newId;
      categoryCache.set(builtPath, newId);
    }
    return parentId;
  }

  for (const row of validRows) {
    if (!row.type || !row.body) continue;
    try {
      const categoryId = await resolveCategoryId(row.categoryPath);
      const { error } = await supabase.rpc("create_question", {
        bank_id: bankId,
        type: row.type,
        category_id: categoryId,
        difficulty: row.difficulty,
        tags: row.tags,
        prompt: row.prompt,
        body: bodyToWireShape(row.body) as Json,
      });
      if (error) {
        return { error: `Item ${row.itemNumber}: ${error.message}` };
      }
      imported++;
    } catch (err) {
      return { error: `Item ${row.itemNumber}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  revalidatePath(`/dashboard/lecturer/question-banks/${bankId}`);
  return { imported, skipped: rows.length - imported };
}
