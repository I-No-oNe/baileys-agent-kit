import { requiredEnv } from "../src/env";
import { runAgentAction } from "../src/runner";

async function main() {
  const result = await runAgentAction(JSON.parse(requiredEnv("ACTION_JSON")));
  console.log(JSON.stringify({ ok: true, result }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
