// Nowgate's TypeScript SDK: the merchant API, typed from its spec, with safe retries,
// pages, problems as errors, amounts as strings, and webhook verification.

export { Amounts } from "./amounts.ts";
export type { ClientOptions, Fetch } from "./client.ts";
export { Nowgate } from "./client.ts";
export type { APIResponse, RequestOptions } from "./core.ts";
export { APIPromise } from "./core.ts";
export type { ApiErrorInit, SignatureFailure } from "./errors.ts";
export {
  ApiError,
  AuthenticationError,
  ConflictError,
  ConnectionError,
  InvalidRequestError,
  NotFoundError,
  NowgateError,
  PermissionError,
  RateLimitError,
  ServerError,
  SignatureVerificationError,
} from "./errors.ts";
export * from "./generated/resources.ts";
export type { components, operations, paths, webhooks } from "./generated/schema.ts";
export type { SignatureHeader, VerifyOptions, WebhookPayload } from "./webhooks.ts";
export { Webhooks } from "./webhooks.ts";
