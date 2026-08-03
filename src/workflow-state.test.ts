import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("GitHub action restores and saves encrypted state without auth caches or artifacts", async () => {
  const action = await readFile(".github/workflows/whatsapp-action.yml", "utf8");
  const pairing = await readFile(".github/workflows/pair-whatsapp.yml", "utf8");
  assert.match(action, /permissions:\s+contents: write/);
  assert.match(action, /WA_STATE_ENCRYPTION_KEY/);
  assert.match(action, /npm run wa:state -- pull/);
  assert.match(action, /npm run wa:state -- push/);
  assert.ok(action.indexOf("npm run wa:state -- pull") < action.indexOf("npm run wa:run"));
  assert.ok(action.indexOf("npm run wa:run") < action.lastIndexOf("npm run wa:state -- push"));
  assert.doesNotMatch(action, /upload-artifact|download-artifact/);
  assert.match(action, /group: whatsapp-state-/);
  assert.match(pairing, /group: whatsapp-state-/);
});
