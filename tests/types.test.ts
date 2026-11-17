// The spec's types: these checks run when tsc checks the tests (make sdk-check), and the
// tests below run too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type {
  ApiError,
  CreatePaymentRequest,
  ErrorCode,
  Payment,
  PaymentEvent,
  WebhookEvent,
} from "../src/index.ts";
import { API_VERSION, VERSION } from "../src/index.ts";
import { fake, fixture, json, PAYMENT } from "./fake.ts";

test("the versions are the spec's and the package's", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
  const spec = fixture("api/openapi.yaml");
  assert.match(spec, new RegExp(`^  version: "?${API_VERSION}"?$`, "m"));
});

test("events narrow by their type", () => {
  const handle = (event: WebhookEvent): string => {
    switch (event.type) {
      case "payment.finished":
        return event.data.object.amount_credited;
      case "payout.failed":
        return event.data.object.failure_reason ?? "";
      case "refund.finished":
        return event.data.object.payment;
      default:
        return event.type;
    }
  };
  const event = { type: "payment.finished", data: { object: { amount_credited: "25" } } };
  assert.equal(handle(event as PaymentEvent), "25");
});

test("typed calls refuse what the API would", async () => {
  const { nowgate } = fake([json(201, PAYMENT)]);
  const body: CreatePaymentRequest = { network: "tron", asset: "USDT", amount: "25" };
  const payment: Payment = await nowgate.payments.create(body);
  assert.equal(payment.id, PAYMENT.id);
  const never = () => {
    // @ts-expect-error amounts are strings
    void nowgate.payments.create({ network: "tron", asset: "USDT", amount: 25 });
    // @ts-expect-error a field the API doesn't know
    void nowgate.payments.create({ network: "tron", asset: "USDT", amout: "25" });
    // @ts-expect-error a required field left out
    void nowgate.payments.create({ asset: "USDT", amount: "25" });
    // @ts-expect-error a status the API doesn't have
    void nowgate.payments.list({ status: "paid" });
    // @ts-expect-error listAll walks down from the newest: no ending_before
    void nowgate.payments.listAll({ ending_before: "pay_1" });
  };
  assert.equal(typeof never, "function");
  const known: ErrorCode = "insufficient_balance";
  const newer: ApiError["code"] = "a_code_from_a_newer_api";
  assert.ok(known && newer);
});
