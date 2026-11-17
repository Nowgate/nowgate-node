// The built package, imported by its name as an application would: it loads from dist/
// and verifies a published signature vector.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { Amounts, API_VERSION, Nowgate, VERSION, Webhooks } from "nowgate";

// The published vectors: the SDK's testdata/ when it stands alone, else Nowgate's repository's.
const local = new URL("../../testdata/signature-vectors.json", import.meta.url);
const { vectors } = JSON.parse(
  readFileSync(
    existsSync(local)
      ? local
      : new URL("../../../../api/webhooks/signature-vectors.json", import.meta.url),
    "utf8",
  ),
);

test("the built package imports by its name and verifies a published vector", async () => {
  const v = vectors[0];
  await Webhooks.verifySignature(v.body, v.header, v.secrets, { now: v.now });
  const event = await Webhooks.constructEvent(v.body, v.header, v.secrets, { now: v.now });
  assert.equal(event.type, "payment.finished");
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
  assert.equal(API_VERSION, "2026-11-01");
  assert.equal(Amounts.fromUnits(Amounts.toUnits("1.5", 6), 6), "1.5");
  const nowgate = new Nowgate({ apiKey: `ngk_sandbox_${"0123456789".repeat(4)}abc` });
  assert.equal(nowgate.baseUrl, "https://sandbox-api.nowgate.io/v1");
  assert.equal(typeof nowgate.payments.listAll, "function");
});
