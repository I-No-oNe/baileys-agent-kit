import assert from "node:assert/strict";
import test from "node:test";
import { detectLocalCountryCode, prefersPairingCode } from "./local-region";

test("detects Israel from an Israeli locale", () => {
  assert.equal(detectLocalCountryCode({ locale: "he_IL", timeZone: "UTC" }), "IL");
  assert.equal(prefersPairingCode({ locale: "he-IL", timeZone: "UTC" }), true);
});

test("detects Israel from the local timezone when locale has no region", () => {
  assert.equal(detectLocalCountryCode({ locale: "he", timeZone: "Asia/Jerusalem" }), "IL");
  assert.equal(detectLocalCountryCode({ locale: "en-US", timeZone: "Asia/Jerusalem" }), "IL");
});

test("does not select code pairing for another region", () => {
  assert.equal(detectLocalCountryCode({ locale: "en-US", timeZone: "America/New_York" }), "US");
  assert.equal(prefersPairingCode({ locale: "en-US", timeZone: "America/New_York" }), false);
});
