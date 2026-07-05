import type { QuestionCategoryRow } from "@/lib/supabase/types";

/** Flattens the category tree into a depth-indented, alphabetically-sorted list suitable for a plain <select>. */
export function flattenCategoriesForSelect(
  categories: QuestionCategoryRow[],
): { id: string; label: string }[] {
  const byParent = new Map<string | null, QuestionCategoryRow[]>();
  for (const c of categories) {
    const key = c.parent_id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }

  const result: { id: string; label: string }[] = [];
  function walk(parentId: string | null, depth: number) {
    const children = (byParent.get(parentId) ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
    for (const c of children) {
      result.push({ id: c.id, label: `${"— ".repeat(depth)}${c.name}` });
      walk(c.id, depth + 1);
    }
  }
  walk(null, 0);
  return result;
}
