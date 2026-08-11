import assert from "node:assert/strict";
import test from "node:test";
import { parseQuestionnaire } from "../github.mjs";

test("parses whole-line bold questionnaire questions", () => {
  const [question] = parseQuestionnaire(
    "## 📋 Questionnaire\n\n" +
    "**q1. Which upload format should the first implementation support?**\n" +
    "- CSV only\n" +
    "- CSV and JSON batch payloads together\n" +
    "- JSON only\n",
  );

  assert.deepEqual(question, {
    id: "q1",
    select: "single",
    prompt: "Which upload format should the first implementation support?",
    choices: ["CSV only", "CSV and JSON batch payloads together", "JSON only"],
  });
});

test("accepts common heading prefixes and escaped markdown", () => {
  assert.equal(parseQuestionnaire("### **q1.** Which format?\n- CSV\n")[0].id, "q1");
  assert.equal(parseQuestionnaire("\\*\\*q1\\.\\*\\* Which format?\n- CSV\n")[0].id, "q1");
});

test("does not promote prose or stray bullets to questions", () => {
  assert.deepEqual(parseQuestionnaire("- q1 CSV\n"), []);
  assert.deepEqual(parseQuestionnaire("We answered q1 already.\n"), []);
});
