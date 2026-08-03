import "../src/load-local-env";
import { publishActionResult } from "../src/action-result";
import { requiredEnv } from "../src/env";
import { runAgentAction } from "../src/runner";
import { explainError } from "../src/explain-error";
import { saveGitHubState } from "../src/github-state";

async function main() {
  const result = await runAgentAction(JSON.parse(requiredEnv("ACTION_JSON")), undefined, {
    ...(process.env.WA_STATE_ENCRYPTION_KEY
      ? { afterReserve: async () => { await saveGitHubState({}, true); } }
      : {}),
  });
  await publishActionResult({ ok: true, result });
}

main().catch(async (error) => {
  await publishActionResult(explainError(error));
  process.exitCode = 1;
});
