// Amounts are decimal strings: numbers are refused before sending, and the helpers convert
// and compare without floating point (api-docs-and-sdks.md section 1.6).
import assert from "node:assert/strict";
import { test } from "node:test";
import { Amounts } from "../src/index.ts";
import { fake, json, PAYMENT } from "./fake.ts";

test("a number or bigint amount is refused before sending, naming the field", async () => {
  const { nowgate, sent } = fake([]);
  const cases: Array<[Promise<unknown>, string]> = [
    [
      nowgate.payments.create({ network: "tron", asset: "USDT", amount: 25 as never }),
      "/amount is a number",
    ],
    [
      nowgate.payments.create({ network: "tron", asset: "USDT", price_amount: 10n as never }),
      "/price_amount is a bigint",
    ],
    [
      nowgate.payoutBatches.create({
        items: [
          { network: "tron", asset: "USDT", amount: "1" },
          { network: "tron", asset: "USDT", amount: 2 as never },
        ],
      }),
      "/items/1/amount is a number",
    ],
    [
      nowgate.paymentLinks.create({
        title: "Tips",
        open_amount: { currency: "USD", presets: ["5", 10 as never] },
      }),
      "/open_amount/presets/1 is a number",
    ],
    [
      nowgate.rates.estimate({
        network: "tron",
        asset: "USDT",
        price_amount: 12.5 as never,
        price_currency: "USD",
      }),
      "/price_amount is a number",
    ],
    [
      nowgate.forwarding.update({
        rules: [
          {
            network: "tron",
            asset: "USDT",
            destination: "dst_1",
            mode: "daily",
            min_amount: 0.1 as never,
          },
        ],
      }),
      "/rules/0/min_amount is a number",
    ],
  ];
  for (const [call, message] of cases) {
    await assert.rejects(call, (err: unknown) => {
      assert.ok(err instanceof TypeError);
      assert.equal(err.message, `${message}: amounts are decimal strings, such as "12.5"`);
      return true;
    });
  }
  assert.equal(sent.length, 0);
});

test("amount strings are sent as given: their format is the API's to check", async () => {
  const { nowgate, sent } = fake([json(201, PAYMENT)]);
  await nowgate.payments.create({
    network: "tron",
    asset: "USDT",
    amount: "25.00",
    metadata: { qty: "2" },
  });
  assert.deepEqual(JSON.parse(sent[0]?.body ?? ""), {
    network: "tron",
    asset: "USDT",
    amount: "25.00",
    metadata: { qty: "2" },
  });
});

test("toUnits gives the smallest units, exactly", () => {
  assert.equal(Amounts.toUnits("1.5", 6), 1_500_000n);
  assert.equal(Amounts.toUnits("0", 18), 0n);
  assert.equal(Amounts.toUnits("25", 0), 25n);
  assert.equal(Amounts.toUnits("0.000001", 6), 1n);
  assert.equal(Amounts.toUnits("1.500000000", 6), 1_500_000n);
  assert.equal(
    Amounts.toUnits("123456789012345678901234567890.123456789012345678", 18),
    123456789012345678901234567890123456789012345678n,
  );
  assert.throws(() => Amounts.toUnits("1.0000001", 6), RangeError);
  for (const bad of ["", "1.", ".5", "01", "-1", "1e3", " 1", "1,5", 1.5 as never]) {
    assert.throws(() => Amounts.toUnits(bad, 6), TypeError, String(bad));
  }
  assert.throws(() => Amounts.toUnits("1", -1), /decimals/);
  assert.throws(() => Amounts.toUnits("1", 1.5), /decimals/);
});

test("fromUnits gives the API's canonical form", () => {
  assert.equal(Amounts.fromUnits(1_500_000n, 6), "1.5");
  assert.equal(Amounts.fromUnits(1n, 6), "0.000001");
  assert.equal(Amounts.fromUnits(0n, 6), "0");
  assert.equal(Amounts.fromUnits(2_000_000n, 6), "2");
  assert.equal(Amounts.fromUnits(25, 0), "25");
  assert.equal(
    Amounts.fromUnits("123456789012345678901234567890", 18),
    "123456789012.34567890123456789",
  );
  assert.throws(() => Amounts.fromUnits(-1n, 6), RangeError);
  assert.throws(() => Amounts.fromUnits(1.5, 6), TypeError);
  assert.throws(() => Amounts.fromUnits("1.5", 6), TypeError);
  for (const units of [0n, 1n, 10n, 999999n, 1000000n, 123456789123456789n]) {
    assert.equal(Amounts.toUnits(Amounts.fromUnits(units, 8), 8), units);
  }
});

test("compare orders amounts of any precision", () => {
  assert.equal(Amounts.compare("1.5", "1.50"), 0);
  assert.equal(Amounts.compare("0.1", "0.09"), 1);
  assert.equal(Amounts.compare("9", "10"), -1);
  assert.equal(Amounts.compare("10.000001", "10.00001"), -1);
  assert.equal(Amounts.compare("0", "0.0"), 0);
  assert.equal(Amounts.compare("100000000000000000000.1", "99999999999999999999.9"), 1);
  assert.throws(() => Amounts.compare("1", "1e2"), /b must be a decimal string/);
});
