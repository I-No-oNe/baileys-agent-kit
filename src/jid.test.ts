import assert from "node:assert/strict";
import test from "node:test";
import { toJid } from "./jid";

test("normalizes phone numbers and preserves JIDs", () => {
  assert.equal(toJid("+972 50-123-4567"), "972501234567@s.whatsapp.net");
  assert.equal(toJid("120363000000@g.us"), "120363000000@g.us");
});

test("rejects empty recipients", () => {
  assert.throws(() => toJid("---"), /phone number or WhatsApp JID/);
});
