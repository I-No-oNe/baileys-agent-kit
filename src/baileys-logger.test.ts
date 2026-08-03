import assert from "node:assert/strict";
import test from "node:test";
import { baileysLogLevel, createBaileysLogger } from "./baileys-logger";

test("silences Baileys by default and permits explicit diagnostics", () => {
  assert.equal(baileysLogLevel(""), "silent");
  assert.equal(baileysLogLevel(" ERROR "), "error");
  assert.equal(createBaileysLogger().level, "silent");
  assert.throws(() => baileysLogLevel("verbose"), /WA_BAILEYS_LOG_LEVEL/);
});
