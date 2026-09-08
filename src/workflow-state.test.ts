import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("GitHub action keeps auth out of artifacts while publishing a short-lived result artifact", async () => {
  const action = await readFile(".github/workflows/whatsapp-action.yml", "utf8");
  const pairing = await readFile(".github/workflows/pair-whatsapp.yml", "utf8");
  assert.match(action, /permissions:\s+contents: write/);
  assert.match(action, /WA_STATE_ENCRYPTION_KEY/);
  assert.match(action, /npm run wa:state -- pull/);
  assert.match(action, /npm run wa:state -- push/);
  assert.ok(action.indexOf("npm run wa:state -- pull") < action.indexOf("npm run wa:run"));
  assert.ok(action.indexOf("npm run wa:run") < action.lastIndexOf("npm run wa:state -- push"));
  const uploads = action.split(/(?=^      - )/m).filter((step) =>
    /uses: actions\/upload-artifact@/.test(step),
  );
  assert.equal(uploads.length, 1, "only the structured result may be uploaded");
  const upload = uploads[0];
  assert.match(upload, /if: always\(\) && github\.event\.repository\.private\s*$/m);
  assert.match(upload, /path: \$\{\{ runner\.temp \}\}\/baileys-agent-result\.json\s*$/m);
  assert.match(upload, /retention-days: 1\s*$/m);
  assert.match(upload, /if-no-files-found: ignore\s*$/m);
  assert.doesNotMatch(action, /path:.*baileys-agent-state/);
  assert.match(action, /group: whatsapp-state-/);
  assert.match(pairing, /group: whatsapp-state-/);
});
