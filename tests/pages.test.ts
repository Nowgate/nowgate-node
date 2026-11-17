// Pages: list returns one page as the API sends it, and listAll walks every page by
// starting_after while has_more (api-docs-and-sdks.md section 1.4).
import assert from "node:assert/strict";
import { test } from "node:test";
import { NotFoundError } from "../src/index.ts";
import { fake, json, problem } from "./fake.ts";

const item = (n: number) => ({ id: `pay_${n}`, object: "payment" });
const page = (ids: number[], has_more: boolean) =>
  json(200, { object: "list", data: ids.map(item), has_more });

test("list returns one page exactly as the API sends it", async () => {
  const { nowgate, sent } = fake([page([5, 4], true)]);
  const list = await nowgate.payments.list({ limit: 2, starting_after: "pay_6" });
  assert.deepEqual(list, { object: "list", data: [item(5), item(4)], has_more: true });
  assert.equal(
    sent[0]?.url,
    "https://sandbox-api.nowgate.io/v1/payments?limit=2&starting_after=pay_6",
  );
});

test("listAll fetches pages of 100 as it's iterated, following starting_after", async () => {
  const { nowgate, sent } = fake([page([5, 4], true), page([3, 2], true), page([1], false)]);
  const walk = nowgate.payments.listAll({ status: "finished" });
  assert.equal(sent.length, 0, "nothing is fetched before the walk starts");
  const ids: string[] = [];
  for await (const payment of walk) ids.push(payment.id);
  assert.deepEqual(ids, ["pay_5", "pay_4", "pay_3", "pay_2", "pay_1"]);
  assert.deepEqual(
    sent.map((s) => new URL(s.url).search),
    [
      "?status=finished&limit=100",
      "?status=finished&limit=100&starting_after=pay_4",
      "?status=finished&limit=100&starting_after=pay_2",
    ],
  );
});

test("listAll keeps the caller's limit and starting point, and stops early when told", async () => {
  const { nowgate, sent } = fake([page([5, 4], true), page([3, 2], true)]);
  const ids: string[] = [];
  for await (const refund of nowgate.refunds.listAll({ limit: 2, starting_after: "pay_6" })) {
    ids.push(refund.id);
    if (ids.length === 3) break;
  }
  assert.deepEqual(ids, ["pay_5", "pay_4", "pay_3"]);
  assert.equal(sent.length, 2);
  assert.equal(new URL(sent[1]?.url ?? "").search, "?limit=2&starting_after=pay_4");
});

test("listAll stops on an empty page, and refuses ending_before", async () => {
  const { nowgate, sent } = fake([page([], true)]);
  const ids = [];
  for await (const payout of nowgate.payouts.listAll()) ids.push(payout);
  assert.deepEqual(ids, []);
  assert.equal(sent.length, 1);
  const walk = nowgate.payouts.listAll({ ending_before: "po_1" } as never);
  await assert.rejects(walk[Symbol.asyncIterator]().next(), /not ending_before/);
});

test("each page is retried as any GET, and a failure ends the walk", async () => {
  const { nowgate, sent } = fake([
    page([2], true),
    problem(503, "pool_exhausted"),
    page([1], false),
    problem(404, "not_found"),
  ]);
  const ids: string[] = [];
  for await (const link of nowgate.paymentLinks.listAll()) ids.push(link.id);
  assert.deepEqual(ids, ["pay_2", "pay_1"]);
  assert.equal(sent.length, 3);
  await assert.rejects(async () => {
    for await (const _ of nowgate.payoutBatches.listAll()) {
      // the first page fails
    }
  }, NotFoundError);
});
