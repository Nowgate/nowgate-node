// The SDK's errors. Every problem the API answers with (RFC 9457 problem JSON) becomes an
// ApiError of its status's class, carrying the whole problem.
import type { ErrorCode, FieldError } from "./generated/resources.ts";

/** Every error the SDK throws, except a TypeError for an argument it can't send. */
export class NowgateError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** What an ApiError is made of. */
export interface ApiErrorInit {
  status: number;
  code: string;
  title: string;
  detail?: string | undefined;
  type?: string | undefined;
  instance?: string | undefined;
  request_id?: string | undefined;
  retry_after?: number | undefined;
  errors?: FieldError[] | undefined;
  headers?: Headers | undefined;
}

/** A problem the API answered with. */
export class ApiError extends NowgateError {
  /** The HTTP status. */
  readonly status: number;
  /** The problem's stable code, such as `insufficient_balance`; `http_<status>` for an answer that isn't a problem. */
  readonly code: ErrorCode | (string & Record<never, never>);
  readonly title: string;
  readonly detail: string | undefined;
  /** The code's page in the docs. */
  readonly type: string | undefined;
  readonly instance: string | undefined;
  /** The request's ID, to quote to support. */
  readonly request_id: string | undefined;
  /** The seconds the API asked to wait before trying again (`Retry-After`). */
  readonly retry_after: number | undefined;
  /** Each field's problem, with its JSON pointer into the request: `/amount`. */
  readonly errors: FieldError[];
  readonly headers: Headers;

  constructor(init: ApiErrorInit) {
    const page = init.type ? ` (${init.type})` : "";
    super(`${init.code}: ${init.detail || init.title}${page}`);
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.detail = init.detail;
    this.type = init.type;
    this.instance = init.instance;
    this.request_id = init.request_id;
    this.retry_after = init.retry_after;
    this.errors = init.errors ?? [];
    this.headers = init.headers ?? new Headers();
  }
}

/** 401: the key is missing, unknown or revoked. */
export class AuthenticationError extends ApiError {}
/** 403: the key may not do this (`insufficient_scope`, `ip_not_allowed`, ...). */
export class PermissionError extends ApiError {}
/** 404: there's no such object, or it isn't yours. */
export class NotFoundError extends ApiError {}
/** 409: the object's state doesn't allow this now. */
export class ConflictError extends ApiError {}
/** 400, 405, 413, 414, 415 and 422: the request itself is wrong; `errors` points at the fields. */
export class InvalidRequestError extends ApiError {}
/** 429: too many requests; `retry_after` says when to try again. */
export class RateLimitError extends ApiError {}
/** 5xx: Nowgate couldn't answer. A POST's retry with the same idempotency key is safe. */
export class ServerError extends ApiError {}

/** No answer: the connection was refused or reset, or an attempt timed out. */
export class ConnectionError extends NowgateError {}

/** Why a webhook's signature didn't verify: the published vectors' names. */
export type SignatureFailure = "malformed" | "no_signature" | "timestamp" | "mismatch";

const FAILURES: Record<SignatureFailure, string> = {
  malformed: "the Nowgate-Signature header can't be parsed",
  no_signature: "the Nowgate-Signature header has no v1 signature",
  timestamp: "the signature's timestamp is outside the tolerance",
  mismatch: "no signature matches the body with any of the secrets",
};

/** A webhook whose Nowgate-Signature doesn't verify: don't trust its body. */
export class SignatureVerificationError extends NowgateError {
  readonly reason: SignatureFailure;

  constructor(reason: SignatureFailure) {
    super(`${reason}: ${FAILURES[reason]}`);
    this.reason = reason;
  }
}

const STATUS_CLASSES: Record<number, typeof ApiError> = {
  400: InvalidRequestError,
  401: AuthenticationError,
  403: PermissionError,
  404: NotFoundError,
  405: InvalidRequestError,
  409: ConflictError,
  413: InvalidRequestError,
  414: InvalidRequestError,
  415: InvalidRequestError,
  422: InvalidRequestError,
  429: RateLimitError,
};

/** apiError makes the error for an answer that isn't a success. */
export function apiError(
  status: number,
  statusText: string,
  headers: Headers,
  body: string,
  now = Date.now(),
): ApiError {
  const problem = parseProblem(headers, body);
  const init: ApiErrorInit = problem
    ? {
        status,
        code: problem.code,
        title: problem.title,
        detail: problem.detail,
        type: problem.type,
        instance: problem.instance,
        request_id: problem.request_id ?? headers.get("x-request-id") ?? undefined,
        errors: problem.errors,
      }
    : {
        status,
        code: `http_${status}`,
        title: statusText || `HTTP ${status}`,
        detail: firstBytes(body, 500) || undefined,
        request_id: headers.get("x-request-id") ?? undefined,
      };
  init.retry_after = retryAfter(headers.get("retry-after"), now);
  init.headers = headers;
  const ErrorClass = STATUS_CLASSES[status] ?? (status >= 500 ? ServerError : ApiError);
  return new ErrorClass(init);
}

interface ParsedProblem {
  code: string;
  title: string;
  type: string | undefined;
  detail: string | undefined;
  instance: string | undefined;
  request_id: string | undefined;
  errors: FieldError[] | undefined;
}

/** parseProblem reads RFC 9457 problem JSON, or returns undefined for anything else. */
function parseProblem(headers: Headers, body: string): ParsedProblem | undefined {
  if (!/\bjson\b/i.test(headers.get("content-type") ?? "")) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const p = value as Record<string, unknown>;
  const text = (key: string) => (typeof p[key] === "string" ? (p[key] as string) : undefined);
  const code = text("code");
  const title = text("title");
  if (code === undefined || title === undefined) return undefined;
  return {
    code,
    title,
    type: text("type"),
    detail: text("detail"),
    instance: text("instance"),
    request_id: text("request_id"),
    errors: Array.isArray(p.errors) ? (p.errors as FieldError[]) : undefined,
  };
}

/** retryAfter reads Retry-After, in seconds or as an HTTP date, as whole seconds from now. */
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now) / 1000));
}

/** firstBytes returns the text of at most the first n bytes of s, as UTF-8, whole characters only. */
function firstBytes(s: string, n: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length <= n) return s;
  let end = n;
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--; // not inside a character
  return new TextDecoder().decode(bytes.subarray(0, end));
}
