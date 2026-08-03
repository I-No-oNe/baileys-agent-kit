import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { publishActionResult } from "./action-result";

test("publishes Actions results to live, machine-readable, summary, and file channels", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "baileys-result-"));
  const resultPath = resolve(directory, "result.json");
  const outputPath = resolve(directory, "output");
  const summaryPath = resolve(directory, "summary");
  const lines: string[] = [];
  const payload = { ok: true, result: { text: "שלום <world>" } };

  await publishActionResult(payload, {
    GITHUB_ACTIONS: "true",
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    WA_ACTION_RESULT_PATH: resultPath,
  }, (line) => lines.push(line));

  assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), payload);
  assert.match(await readFile(outputPath, "utf8"), /result_json<<BAILEYS_RESULT_/);
  assert.match(await readFile(summaryPath, "utf8"), /שלום &lt;world&gt;/);
  assert.match(lines[0], /^::notice title=Baileys Agent Result::/);
  assert.equal(lines.at(-1), JSON.stringify(payload));
});

test("does not expand result details on public-repository workflows", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "baileys-result-public-"));
  const summaryPath = resolve(directory, "summary");
  const lines: string[] = [];
  await publishActionResult({ ok: true, result: { text: "private" } }, {
    GITHUB_ACTIONS: "true",
    GITHUB_STEP_SUMMARY: summaryPath,
    WA_ACTION_RESULT_DETAILS: "false",
  }, (line) => lines.push(line));

  await assert.rejects(readFile(summaryPath, "utf8"), /ENOENT/);
  assert.deepEqual(lines, [JSON.stringify({ ok: true, result: { text: "private" } })]);
});
