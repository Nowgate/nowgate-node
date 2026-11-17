// An application's TypeScript against the built package's declarations, with Node.js's
// types and no DOM library: tsc -p tests/package checks that they compile.
import { ApiError, Nowgate, type Payment, type WebhookEvent, Webhooks } from "nowgate";

export async function example(
  apiKey: string,
  body: string,
  header: string | undefined,
  secret: string,
): Promise<string> {
  const nowgate = new Nowgate({ apiKey, maxRetries: 3 });
  const payment: Payment = await nowgate.payments.create(
    { network: "tron", asset: "USDT", amount: "25" },
    { idempotencyKey: "order-1042" },
  );
  const { data, request_id } = await nowgate.payments.retrieve(payment.id).withResponse();
  for await (const each of nowgate.payments.listAll({ status: "finished" })) void each.amount;
  const event: WebhookEvent = await Webhooks.constructEvent(body, header, [secret]);
  try {
    await nowgate.payouts.cancel("po_1");
  } catch (err) {
    if (err instanceof ApiError) return err.code;
  }
  return `${data.status} ${request_id ?? ""} ${event.type}`;
}
