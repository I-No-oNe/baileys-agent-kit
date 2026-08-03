import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { writePrivateFile } from "./local-files";

type ResultEnvironment = Record<string, string | undefined>;

const escapeHtml = (value: string) => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

const escapeWorkflowCommand = (value: string) => value
  .replace(/%/g, "%25")
  .replace(/\r/g, "%0D")
  .replace(/\n/g, "%0A");

export async function publishActionResult(
  payload: Record<string, unknown>,
  environment: ResultEnvironment = process.env,
  writeLine: (line: string) => void = console.log,
): Promise<void> {
  const compact = JSON.stringify(payload);
  const pretty = JSON.stringify(payload, null, 2);
  const publishDetails = environment.WA_ACTION_RESULT_DETAILS !== "false";
  const warnings: string[] = [];
  const attempt = async (name: string, operation: () => Promise<void>) => {
    try {
      await operation();
    } catch {
      warnings.push(name);
    }
  };

  if (environment.WA_ACTION_RESULT_PATH) {
    await attempt("result file", () => writePrivateFile(environment.WA_ACTION_RESULT_PATH!, `${pretty}\n`));
  }
  if (environment.GITHUB_OUTPUT) {
    const delimiter = `BAILEYS_RESULT_${randomUUID().replace(/-/g, "")}`;
    await attempt("GITHUB_OUTPUT", () => appendFile(
      environment.GITHUB_OUTPUT!,
      `result_json<<${delimiter}\n${compact}\n${delimiter}\n${environment.WA_ACTION_RESULT_PATH ? `result_path=${environment.WA_ACTION_RESULT_PATH}\n` : ""}`,
    ));
  }
  if (publishDetails && environment.GITHUB_STEP_SUMMARY) {
    const status = payload.ok === true ? "Success" : "Failure";
    await attempt("GITHUB_STEP_SUMMARY", () => appendFile(
      environment.GITHUB_STEP_SUMMARY!,
      `## WhatsApp action result: ${status}\n\n<details open><summary>Structured JSON</summary>\n\n<pre>${escapeHtml(pretty)}</pre>\n\n</details>\n`,
    ));
  }

  if (publishDetails && environment.GITHUB_ACTIONS === "true") {
    const annotation = Buffer.byteLength(compact) <= 8_000
      ? compact
      : JSON.stringify({ ok: payload.ok, result: "Result is larger than the live annotation; use the result artifact." });
    writeLine(`::notice title=Baileys Agent Result::${escapeWorkflowCommand(annotation)}`);
    if (warnings.length) writeLine(`::warning title=Baileys result delivery::Could not write ${escapeWorkflowCommand(warnings.join(", "))}. The JSON log line remains available.`);
  }
  writeLine(compact);
}
