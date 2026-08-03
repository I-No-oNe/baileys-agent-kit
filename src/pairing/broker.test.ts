import assert from "node:assert/strict";
import test from "node:test";
import { renderPairingQrDataUrl } from "./broker";

test("renders pairing QR images as square PNGs", async () => {
  const dataUrl = await renderPairingQrDataUrl("pairing-test-value");
  const png = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  assert.equal(png.toString("ascii", 1, 4), "PNG");
  assert.equal(png.readUInt32BE(16), 640);
  assert.equal(png.readUInt32BE(20), 640);
});
