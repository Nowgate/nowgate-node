// The client: keys and environments, what every request carries, its arguments, and the
// key never shown (api-docs-and-sdks.md, sections 1.2 and 1.3).
import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { ApiError, ConnectionError, Nowgate, NowgateError, VERSION } from "../src/index.ts";
import { fake, json, KEY, PAYMENT, problem, refused, SECRET } from "./fake.ts";

test("the base URL follows the key's environment", () => {
  const live = new Nowgate({ apiKey: `ngk_live_${SECRET}` });
  assert.equal(live.baseUrl, "https://api.nowgate.io/v1");
  const sandbox = new Nowgate({ apiKey: KEY });
  assert.equal(sandbox.baseUrl, "https://sandbox-api.nowgate.io/v1");
  assert.equal(sandbox.timeout, 60_000);
  assert.equal(sandbox.maxRetries, 2);
});

test("other environments' keys need a base URL, and live keys go only over https", () => {
  assert.throws(() => new Nowgate({ apiKey: `ngk_test_${SECRET}` }), /test key needs a baseUrl/);
  const local = new Nowgate({ apiKey: `ngk_test_${SECRET}`, baseUrl: "http://127.0.0.1:8080/v1/" });
  assert.equal(local.baseUrl, "http://127.0.0.1:8080/v1");
  assert.throws(
    () => new Nowgate({ apiKey: `ngk_live_${SECRET}`, baseUrl: "http://api.nowgate.io/v1" }),
    /live key is sent only over https/,
  );
  assert.throws(() => new Nowgate({ apiKey: KEY, baseUrl: "ftp://x" }), /https URL/);
  assert.throws(() => new Nowgate({ apiKey: KEY, baseUrl: "https://x/v1?a=1" }), /query/);
});

test("a key that isn't a Nowgate key is refused before any request, without showing it", () => {
  for (const apiKey of ["sk_live_abcdef", "", ` ${KEY}`, `${KEY}\n`, "ngk_live", "ngk__x"]) {
    assert.throws(
      () => new Nowgate({ apiKey }),
      (err: unknown) => {
        assert.ok(err instanceof TypeError);
        assert.match(err.message, /must be a Nowgate API key/);
        assert.ok(!err.message.includes(SECRET) && !err.message.includes("abcdef"));
        return true;
      },
    );
  }
  assert.throws(() => new Nowgate(undefined as never), TypeError);
});

test("options are checked when the client is made", () => {
  assert.throws(() => new Nowgate({ apiKey: KEY, timeout: 0 }), /timeout/);
  assert.throws(() => new Nowgate({ apiKey: KEY, maxRetries: -1 }), /maxRetries/);
  assert.throws(() => new Nowgate({ apiKey: KEY, maxRetries: 1.5 }), /maxRetries/);
  assert.throws(() => new Nowgate({ apiKey: KEY, appInfo: "my shop\n" }), /appInfo/);
});

test("the client refuses to run in a browser unless told otherwise", () => {
  const g = globalThis as { document?: unknown };
  g.document = {};
  try {
    assert.throws(
      () => new Nowgate({ apiKey: KEY }),
      (err: unknown) => {
        assert.ok(err instanceof NowgateError);
        assert.match(err.message, /must never reach a browser/);
        return true;
      },
    );
    assert.ok(new Nowgate({ apiKey: KEY, dangerouslyAllowBrowser: true }));
  } finally {
    delete g.document;
  }
});

test("every request carries the key, the User-Agent and Accept, public operations too", async () => {
  const { nowgate, sent } = fake([json(200, { object: "status" })], { appInfo: "my-shop/1.2" });
  await nowgate.status.retrieve();
  const [request] = sent;
  assert.equal(request?.url, "https://sandbox-api.nowgate.io/v1/status");
  assert.equal(request?.method, "GET");
  assert.equal(request?.headers.get("authorization"), `Bearer ${KEY}`);
  assert.equal(request?.headers.get("accept"), "application/json");
  assert.equal(
    request?.headers.get("user-agent"),
    `nowgate-typescript/${VERSION} node/${process.versions.node} my-shop/1.2`,
  );
  assert.equal(request?.headers.get("idempotency-key"), null);
  assert.equal(request?.body, undefined);
});

test("a body is JSON, path IDs are encoded, and query parameters are sent as given", async () => {
  const { nowgate, sent } = fake([
    json(201, { id: "rf_1" }),
    json(200, PAYMENT),
    json(200, { object: "list", data: [], has_more: false }),
  ]);
  await nowgate.refunds.create("pay_1", {
    amount: "1.5",
    address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
  });
  await nowgate.payments.retrieve("pay_a/b?c");
  await nowgate.payments.list({ limit: 2, status: "finished", order_id: "A&B" });
  assert.equal(sent[0]?.url, "https://sandbox-api.nowgate.io/v1/payments/pay_1/refunds");
  assert.equal(sent[0]?.headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(sent[0]?.body ?? ""), {
    amount: "1.5",
    address: "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb",
  });
  assert.equal(sent[1]?.url, "https://sandbox-api.nowgate.io/v1/payments/pay_a%2Fb%3Fc");
  assert.equal(
    sent[2]?.url,
    "https://sandbox-api.nowgate.io/v1/payments?limit=2&status=finished&order_id=A%26B",
  );
});

test("an optional body is sent as {} when it's left out, and a POST without a body has none", async () => {
  const { nowgate, sent } = fake([json(201, { id: "rf_1" }), json(200, { id: "po_1" })]);
  await nowgate.refunds.create("pay_1");
  await nowgate.payouts.cancel("po_1");
  assert.equal(sent[0]?.body, "{}");
  assert.equal(sent[1]?.method, "POST");
  assert.equal(sent[1]?.body, undefined);
  assert.equal(sent[1]?.headers.get("content-type"), null);
  assert.ok(sent[1]?.headers.get("idempotency-key"));
});

test("an empty or missing ID is refused before sending", async () => {
  const { nowgate, sent } = fake([]);
  await assert.rejects(nowgate.payments.retrieve(""), /id must be a non-empty string/);
  await assert.rejects(nowgate.payouts.cancel(undefined as never), TypeError);
  assert.equal(sent.length, 0);
});

test("the key is never shown: not by inspection, JSON, errors or the resources", async () => {
  const { nowgate } = fake([problem(401, "invalid_api_key"), refused()], { maxRetries: 0 });
  const shown = [inspect(nowgate), inspect(nowgate, { showHidden: true, depth: 10 })];
  shown.push(JSON.stringify(nowgate), inspect(nowgate.payments, { depth: 10 }), String(nowgate));
  await assert.rejects(nowgate.payments.retrieve("pay_1"), (err: unknown) => {
    assert.ok(err instanceof ApiError);
    shown.push(String(err), inspect(err, { depth: 10 }), JSON.stringify(err));
    return true;
  });
  await assert.rejects(nowgate.payments.retrieve("pay_1"), (err: unknown) => {
    assert.ok(err instanceof ConnectionError);
    shown.push(String(err), inspect(err, { depth: 10 }));
    return true;
  });
  for (const text of shown) {
    assert.ok(!text.includes(SECRET.slice(6, 30)), text);
  }
  assert.match(inspect(nowgate), /apiKey: 'ngk_sandbox_012345…9abc'/);
  assert.deepEqual(JSON.parse(JSON.stringify(nowgate)), {
    apiKey: "ngk_sandbox_012345…9abc",
    baseUrl: "https://sandbox-api.nowgate.io/v1",
    timeout: 60_000,
    maxRetries: 0,
  });
});

test("a transport of the caller's own is used for every request", async () => {
  const urls: string[] = [];
  const nowgate = new Nowgate({
    apiKey: KEY,
    fetch: async (url) => {
      urls.push(url);
      return json(200, { object: "list", data: [] });
    },
  });
  assert.deepEqual(await nowgate.assets.list(), { object: "list", data: [] });
  assert.deepEqual(urls, ["https://sandbox-api.nowgate.io/v1/assets"]);
});

test("a success that isn't JSON is an error, not retried", async () => {
  const { nowgate, sent } = fake([new Response("<html>", { status: 200 })]);
  await assert.rejects(nowgate.status.retrieve(), (err: unknown) => {
    assert.ok(err instanceof NowgateError && !(err instanceof ApiError));
    assert.match(err.message, /answered 200 with a body that isn't JSON/);
    return true;
  });
  assert.equal(sent.length, 1);
});
