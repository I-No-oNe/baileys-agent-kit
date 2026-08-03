import "../src/load-local-env";
import { requiredEnv } from "../src/env";
import { runAgentAction } from "../src/runner";
import { explainError } from "../src/explain-error";

async function main() {
  const result = await runAgentAction(JSON.parse(requiredEnv("ACTION_JSON")));
  console.log(JSON.stringify({ ok: true, result }));
}

main().catch((error) => {
  console.error(JSON.stringify(explainError(error)));
  process.exit(1);
});
