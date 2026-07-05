#!/usr/bin/env node
// Phase 3b: unit tests for the bulk-import parsers
// (apps/web/lib/questions/import/{csv,aiken,gift}.ts).
//
// Dependency-free, matching this repo's ponytail posture: no vitest/jest in
// apps/web, so this uses Node's built-in test runner (node:test, available
// since Node 18) plus Node 22+'s native TypeScript type-stripping
// (--experimental-strip-types) to import the .ts source files directly —
// no build step, no ts-node/tsx dependency. proctor-core's vitest suite is
// unaffected; this is a second, independently-run test file, exactly the
// "small node test script under scripts/" fallback the task brief allows.
//
// Usage: node --experimental-strip-types scripts/question-import-parsers.test.mjs
// (wired up as `pnpm test:questions` in package.json)

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseQuestionCsv, CSV_TEMPLATE } from "../apps/web/lib/questions/import/csv.ts";
import { parseAiken, AIKEN_TEMPLATE } from "../apps/web/lib/questions/import/aiken.ts";
import { parseGift, GIFT_TEMPLATE } from "../apps/web/lib/questions/import/gift.ts";

function isValid(row) {
  return row.errors.length === 0 && row.type !== null && row.body !== null;
}

// --- CSV -------------------------------------------------------------------

test("csv: template rows all parse valid", () => {
  const rows = parseQuestionCsv(CSV_TEMPLATE);
  assert.equal(rows.length, 5);
  for (const row of rows) {
    assert.equal(row.errors.length, 0, `row ${row.itemNumber}: ${row.errors.join("; ")}`);
  }
});

test("csv: mcq_single by 1-based index resolves correct option", () => {
  const csv = "type,prompt,options,correct,difficulty,tags,marks,category\nmcq_single,2+2?,3|4|5,2,easy,math,1,Math";
  const rows = parseQuestionCsv(csv);
  assert.equal(rows.length, 1);
  assert.ok(isValid(rows[0]));
  assert.deepEqual(rows[0].body.value.correct, ["B"]);
});

test("csv: mcq_single by letter resolves correct option", () => {
  const csv = "type,prompt,options,correct,difficulty,tags,marks,category\nmcq_single,2+2?,3|4|5,B,easy,math,1,Math";
  const rows = parseQuestionCsv(csv);
  assert.ok(isValid(rows[0]));
  assert.deepEqual(rows[0].body.value.correct, ["B"]);
});

test("csv: mcq_multi with multiple correct indices", () => {
  const csv = 'type,prompt,options,correct,difficulty,tags,marks,category\nmcq_multi,Pick primes,2|3|4|5,"1,2,4",medium,math,2,Math';
  const rows = parseQuestionCsv(csv);
  assert.ok(isValid(rows[0]), rows[0].errors.join("; "));
  assert.deepEqual(rows[0].body.value.correct, ["A", "B", "D"]);
});

test("csv: quoted field containing a comma is handled (RFC-4180-ish)", () => {
  const csv =
    'type,prompt,options,correct,difficulty,tags,marks,category\n' +
    'short_answer,"Name a city, any city",,"Accra;Kumasi",easy,geo,1,Geography';
  const rows = parseQuestionCsv(csv);
  assert.ok(isValid(rows[0]), rows[0].errors.join("; "));
  assert.equal(rows[0].prompt, "Name a city, any city");
  assert.deepEqual(rows[0].body.value.accepted, ["Accra", "Kumasi"]);
});

test("csv: deliberately bad row (unresolvable correct index) is flagged invalid", () => {
  const csv = "type,prompt,options,correct,difficulty,tags,marks,category\nmcq_single,Bad row,A|B,9,easy,,1,";
  const rows = parseQuestionCsv(csv);
  assert.equal(rows.length, 1);
  assert.ok(!isValid(rows[0]));
  assert.ok(rows[0].errors.length > 0);
});

test("csv: unknown type is flagged invalid, not silently dropped", () => {
  const csv = "type,prompt,options,correct,difficulty,tags,marks,category\nmatching,Bad type,,,,,1,";
  const rows = parseQuestionCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, null);
  assert.ok(rows[0].errors.some((e) => e.includes("Unknown or missing type")));
});

test("csv: numeric value:tolerance syntax", () => {
  const csv = "type,prompt,options,correct,difficulty,tags,marks,category\nnumeric,g?,,9.8:0.2,medium,physics,2,Science";
  const rows = parseQuestionCsv(csv);
  assert.ok(isValid(rows[0]), rows[0].errors.join("; "));
  assert.equal(rows[0].body.value.correct, 9.8);
  assert.equal(rows[0].body.value.tolerance, 0.2);
});

test("csv: category path splits on /", () => {
  const csv = "type,prompt,options,correct,difficulty,tags,marks,category\nessay,Discuss X,,,hard,,10,Topic/Subtopic";
  const rows = parseQuestionCsv(csv);
  assert.deepEqual(rows[0].categoryPath, ["Topic", "Subtopic"]);
});

test("csv: TSV (tab-delimited) is auto-detected", () => {
  const tsv = "type\tprompt\toptions\tcorrect\tdifficulty\ttags\tmarks\tcategory\ntrue_false\tSky is blue\t\ttrue\teasy\t\t1\t";
  const rows = parseQuestionCsv(tsv);
  assert.ok(isValid(rows[0]), rows[0].errors.join("; "));
  assert.equal(rows[0].body.value.correct, true);
});

// --- Aiken -------------------------------------------------------------------

test("aiken: template parses two valid mcq_single items", () => {
  const rows = parseAiken(AIKEN_TEMPLATE);
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.ok(isValid(row), `item ${row.itemNumber}: ${row.errors.join("; ")}`);
    assert.equal(row.type, "mcq_single");
  }
});

test("aiken: resolves ANSWER letter to the matching option", () => {
  const rows = parseAiken(AIKEN_TEMPLATE);
  assert.deepEqual(rows[0].body.value.correct, ["A"]);
  assert.equal(rows[0].body.value.options[0].text, "Accra");
});

test("aiken: supports 5+ options", () => {
  const text = ["Pick one", "A. one", "B. two", "C. three", "D. four", "E. five", "ANSWER: E"].join("\n");
  const rows = parseAiken(text);
  assert.equal(rows.length, 1);
  assert.ok(isValid(rows[0]), rows[0].errors.join("; "));
  assert.equal(rows[0].body.value.options.length, 5);
  assert.deepEqual(rows[0].body.value.correct, ["E"]);
});

test("aiken: missing ANSWER line is flagged invalid", () => {
  const text = ["Question with no answer", "A. one", "B. two"].join("\n");
  const rows = parseAiken(text);
  assert.equal(rows.length, 1);
  assert.ok(!isValid(rows[0]));
  assert.ok(rows[0].errors.some((e) => e.includes("ANSWER")));
});

test("aiken: ANSWER letter not matching any option is flagged invalid", () => {
  const text = ["Q", "A. one", "B. two", "ANSWER: Z"].join("\n");
  const rows = parseAiken(text);
  assert.ok(!isValid(rows[0]));
  assert.ok(rows[0].errors.some((e) => e.includes("does not match")));
});

test("aiken: multiple blocks separated by blank lines produce multiple items", () => {
  const text = ["Q1", "A. a", "B. b", "ANSWER: A", "", "", "Q2", "A. c", "B. d", "ANSWER: B"].join("\n");
  const rows = parseAiken(text);
  assert.equal(rows.length, 2);
});

// --- GIFT --------------------------------------------------------------------

test("gift: template parses 4 items, all valid, with category applied", () => {
  const rows = parseGift(GIFT_TEMPLATE);
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.ok(isValid(row), `item ${row.itemNumber} (${row.type}): ${row.errors.join("; ")}`);
  }
  assert.deepEqual(rows[0].categoryPath, ["Geography"]);
});

test("gift: ::title:: prefix is stripped from the prompt", () => {
  const rows = parseGift(GIFT_TEMPLATE);
  assert.equal(rows[0].prompt, "What is the capital of Ghana?");
});

test("gift: multiple choice — = is correct, ~ is a distractor", () => {
  const rows = parseGift(GIFT_TEMPLATE);
  assert.equal(rows[0].type, "mcq_single");
  assert.deepEqual(rows[0].body.value.correct, ["A"]);
  assert.equal(rows[0].body.value.options.map((o) => o.text).join(","), "Accra,Kumasi,Tamale");
});

test("gift: {TRUE} parses as true_false", () => {
  const rows = parseGift(GIFT_TEMPLATE);
  assert.equal(rows[1].type, "true_false");
  assert.equal(rows[1].body.value.correct, true);
});

test("gift: {#answer:tolerance} parses as numeric", () => {
  const rows = parseGift(GIFT_TEMPLATE);
  assert.equal(rows[2].type, "numeric");
  assert.equal(rows[2].body.value.correct, 9.8);
  assert.equal(rows[2].body.value.tolerance, 0.2);
});

test("gift: multiple = entries with no ~ parses as short_answer", () => {
  const rows = parseGift(GIFT_TEMPLATE);
  assert.equal(rows[3].type, "short_answer");
  assert.deepEqual(rows[3].body.value.accepted, ["Red", "Blue", "Yellow"]);
});

test("gift: T/F shorthand also accepted", () => {
  const rows = parseGift("Q1{T}\n\nQ2{F}");
  assert.equal(rows[0].body.value.correct, true);
  assert.equal(rows[1].body.value.correct, false);
});

test("gift: escaped characters (\\: \\~ \\= \\# \\{ \\}) are unescaped in prompt and option text", () => {
  const text = String.raw`What does \: mean in GIFT syntax?{=A colon \~ escape ~Something else}`;
  const rows = parseGift(text);
  assert.equal(rows.length, 1);
  assert.ok(isValid(rows[0]), rows[0].errors.join("; "));
  assert.equal(rows[0].prompt, "What does : mean in GIFT syntax?");
  assert.equal(rows[0].body.value.options[0].text, "A colon ~ escape");
});

test("gift: option feedback (# ...) is parsed out and discarded, not preserved", () => {
  const text = "Q{=Correct # well done ~Wrong # try again}";
  const rows = parseGift(text);
  assert.ok(isValid(rows[0]), rows[0].errors.join("; "));
  assert.equal(rows[0].body.value.options[0].text, "Correct");
  assert.equal(rows[0].body.value.options[1].text, "Wrong");
  assert.ok(!JSON.stringify(rows[0].body).includes("well done"));
});

test("gift: per-option weight (%50%) is rejected with a clear error, not silently imported", () => {
  const text = "Q{~%50%Half credit ~%100%Full credit ~Wrong}";
  const rows = parseGift(text);
  assert.ok(!isValid(rows[0]));
  assert.ok(rows[0].errors.some((e) => e.includes("weight")));
});

test("gift: essay-style empty {} block is rejected (no rubric field in GIFT)", () => {
  const text = "Discuss the theme of the poem.{}";
  const rows = parseGift(text);
  assert.ok(!isValid(rows[0]));
  assert.ok(rows[0].errors.some((e) => e.includes("essay")));
});

test("gift: item with no {} answer block at all is rejected", () => {
  const rows = parseGift("This has no answer block at all.");
  assert.equal(rows[0].type, null);
  assert.ok(rows[0].errors.some((e) => e.includes("No {answer} block")));
});

test("gift: $CATEGORY directive applies to subsequent items until changed", () => {
  const text = ["$CATEGORY: A/B", "Q1{TRUE}", "", "$CATEGORY: C", "Q2{FALSE}"].join("\n");
  const rows = parseGift(text);
  assert.deepEqual(rows[0].categoryPath, ["A", "B"]);
  assert.deepEqual(rows[1].categoryPath, ["C"]);
});

console.log("\n(question-import-parsers.test.mjs: all assertions above must show no thrown errors)");
