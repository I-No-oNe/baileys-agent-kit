import "../src/load-local-env";
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
  console.log(JSON.stringify({ ok: true, result }));
}

main().catch((error) => {
  console.error(JSON.stringify(explainError(error)));
  process.exit(1);
});
