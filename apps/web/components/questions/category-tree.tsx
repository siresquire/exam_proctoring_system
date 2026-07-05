"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { FolderPlus, Pencil, Plus, Trash2 } from "lucide-react";

import { createCategory, deleteCategory, renameCategory } from "@/app/dashboard/lecturer/question-banks/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import type { QuestionCategoryRow } from "@/lib/supabase/types";

interface CategoryTreeProps {
  bankId: string;
  categories: QuestionCategoryRow[];
  /** Currently selected category id used to filter the questions list ("all" = null). */
  selectedCategoryId: string | null;
  onSelectCategory: (categoryId: string | null) => void;
}

interface TreeNode {
  category: QuestionCategoryRow;
  children: TreeNode[];
}

function buildTree(categories: QuestionCategoryRow[]): TreeNode[] {
  const byParent = new Map<string | null, QuestionCategoryRow[]>();
  for (const c of categories) {
    const key = c.parent_id;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(c);
  }
  function build(parentId: string | null): TreeNode[] {
    return (byParent.get(parentId) ?? [])
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((category) => ({ category, children: build(category.id) }));
  }
  return build(null);
}

/**
 * Accessible category tree manager: a nested list (not a drag-and-drop
 * tree — DESIGN.md 2.5.7 "no drag-only interactions") with explicit
 * add/rename/delete buttons at every node, keyboard-operable throughout.
 * Uses a native <ul>/<li> nested list with role="tree"/"treeitem" would add
 * real complexity for arrow-key roving-tabindex behavior with little
 * benefit here — a plain nested list with normal tab order and visible
 * buttons is simpler, fully keyboard-operable, and screen-reader
 * navigable via standard list semantics, so that's what this ships.
 */
export function CategoryTree({ bankId, categories, selectedCategoryId, onSelectCategory }: CategoryTreeProps) {
  const [addingUnder, setAddingUnder] = React.useState<string | null | "none">("none");
  const [newName, setNewName] = React.useState("");
  const [renamingId, setRenamingId] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const router = useRouter();

  const tree = React.useMemo(() => buildTree(categories), [categories]);

  async function handleCreate(parentId: string | null) {
    if (!newName.trim()) {
      await notify.warning("Name required", "Give the category a name first.");
      return;
    }
    setBusy(true);
    try {
      const result = await createCategory(bankId, newName, parentId);
      if (result.error) {
        await notify.error("Could not create category", result.error);
        return;
      }
      setNewName("");
      setAddingUnder("none");
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(categoryId: string) {
    if (!renameValue.trim()) {
      await notify.warning("Name required", "Give the category a name first.");
      return;
    }
    setBusy(true);
    try {
      const result = await renameCategory(bankId, categoryId, renameValue);
      if (result.error) {
        await notify.error("Could not rename category", result.error);
        return;
      }
      setRenamingId(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(category: QuestionCategoryRow) {
    const confirmed = await notify.confirm({
      title: `Delete "${category.name}"?`,
      text: "Subcategories are deleted too. Questions filed under it become uncategorized, not deleted.",
      destructive: true,
      confirmButtonText: "Delete",
    });
    if (!confirmed) return;

    setBusy(true);
    try {
      const result = await deleteCategory(bankId, category.id);
      if (result.error) {
        await notify.error("Could not delete category", result.error);
        return;
      }
      if (selectedCategoryId === category.id) onSelectCategory(null);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function renderAddRow(parentId: string | null, depth: number) {
    if (addingUnder !== parentId) return null;
    return (
      <li style={{ marginLeft: depth * 1.25 + "rem" }} className="mt-1 flex items-center gap-2">
        <Label htmlFor={`new-category-${parentId ?? "root"}`} className="sr-only">
          New category name
        </Label>
        <Input
          id={`new-category-${parentId ?? "root"}`}
          autoFocus
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleCreate(parentId);
            if (e.key === "Escape") setAddingUnder("none");
          }}
          placeholder="Category name"
          className="h-8 max-w-56 text-sm"
          disabled={busy}
        />
        <Button type="button" size="sm" onClick={() => handleCreate(parentId)} disabled={busy}>
          Add
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => setAddingUnder("none")} disabled={busy}>
          Cancel
        </Button>
      </li>
    );
  }

  function renderNode(node: TreeNode, depth: number): React.ReactNode {
    const isSelected = selectedCategoryId === node.category.id;
    const isRenaming = renamingId === node.category.id;
    return (
      <li key={node.category.id}>
        <div
          style={{ marginLeft: depth * 1.25 + "rem" }}
          className={cn(
            "group flex min-h-11 items-center gap-1 rounded-md pr-1",
            isSelected && "bg-muted",
          )}
        >
          {isRenaming ? (
            <>
              <Label htmlFor={`rename-${node.category.id}`} className="sr-only">
                Rename category
              </Label>
              <Input
                id={`rename-${node.category.id}`}
                autoFocus
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRename(node.category.id);
                  if (e.key === "Escape") setRenamingId(null);
                }}
                className="h-8 max-w-48 text-sm"
                disabled={busy}
              />
              <Button type="button" size="sm" onClick={() => handleRename(node.category.id)} disabled={busy}>
                Save
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setRenamingId(null)} disabled={busy}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => onSelectCategory(isSelected ? null : node.category.id)}
                className="flex-1 truncate rounded-md px-2 py-1.5 text-left text-sm hover:underline focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none"
                aria-pressed={isSelected}
              >
                {node.category.name}
              </button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                onClick={() => setAddingUnder(node.category.id)}
                aria-label={`Add subcategory under ${node.category.name}`}
              >
                <Plus aria-hidden className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-8 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                onClick={() => {
                  setRenamingId(node.category.id);
                  setRenameValue(node.category.name);
                }}
                aria-label={`Rename ${node.category.name}`}
              >
                <Pencil aria-hidden className="size-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="text-destructive size-8 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"
                onClick={() => handleDelete(node.category)}
                aria-label={`Delete ${node.category.name}`}
              >
                <Trash2 aria-hidden className="size-4" />
              </Button>
            </>
          )}
        </div>
        <ul>
          {renderAddRow(node.category.id, depth + 1)}
          {node.children.map((child) => renderNode(child, depth + 1))}
        </ul>
      </li>
    );
  }

  return (
    <nav aria-label="Question categories">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium">Categories</h2>
        <Button type="button" size="sm" variant="outline" onClick={() => setAddingUnder(null)}>
          <FolderPlus aria-hidden className="size-4" />
          New top-level category
        </Button>
      </div>
      <ul className="space-y-0.5">
        <li>
          <button
            type="button"
            onClick={() => onSelectCategory(null)}
            aria-pressed={selectedCategoryId === null}
            className={cn(
              "min-h-11 w-full rounded-md px-2 py-1.5 text-left text-sm hover:underline focus-visible:ring-ring/50 focus-visible:ring-3 focus-visible:outline-none",
              selectedCategoryId === null && "bg-muted font-medium",
            )}
          >
            All questions
          </button>
        </li>
        {renderAddRow(null, 0)}
        {tree.map((node) => renderNode(node, 0))}
      </ul>
      {categories.length === 0 && addingUnder === "none" ? (
        <p className="text-muted-foreground mt-2 text-sm">No categories yet — questions will be uncategorized.</p>
      ) : null}
    </nav>
  );
}
