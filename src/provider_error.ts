/**
 * Stable, machine-readable provider transport errors.
 * UI / agent / tools branch on `code` + `retryable`; humans read `message`.
 */

export type ProviderErrorCode =
  | "PROVIDER_RATE_LIMIT"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_AUTH"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_CIRCUIT_OPEN"
  | "PROVIDER_QUEUE_TIMEOUT"
  | "PROVIDER_HTTP"
  | "PROVIDER_NETWORK"
  | "PROVIDER_ABORTED"
  | "PROVIDER_INVALID_RESPONSE"
  | "PROVIDER_CONFIG"
  | "PROCESS_JOB_LIMIT"
  | "SESSION_JOB_ALREADY_RUNNING";

export type ProviderErrorAction =
  | "retry"
  | "wait_and_retry"
  | "check_api_key"
  | "check_config"
  | "reduce_concurrency"
  | "cancel"
  | "none";

const ACTION_BY_CODE: Record<ProviderErrorCode, ProviderErrorAction> = {
  PROVIDER_RATE_LIMIT: "wait_and_retry",
  PROVIDER_UNAVAILABLE: "retry",
  PROVIDER_AUTH: "check_api_key",
  PROVIDER_TIMEOUT: "retry",
  PROVIDER_CIRCUIT_OPEN: "wait_and_retry",
  PROVIDER_QUEUE_TIMEOUT: "reduce_concurrency",
  PROVIDER_HTTP: "none",
  PROVIDER_NETWORK: "retry",
  PROVIDER_ABORTED: "cancel",
  PROVIDER_INVALID_RESPONSE: "none",
  PROVIDER_CONFIG: "check_config",
  PROCESS_JOB_LIMIT: "wait_and_retry",
  SESSION_JOB_ALREADY_RUNNING: "none",
};

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly action: ProviderErrorAction;
  readonly httpStatus?: number;
  readonly providerKey?: string;
  readonly attempt?: number;
  readonly retryAfterMs?: number;

  constructor(
    code: ProviderErrorCode,
    message: string,
    options?: ErrorOptions & {
      retryable?: boolean;
      httpStatus?: number;
      providerKey?: string;
      attempt?: number;
      retryAfterMs?: number;
      action?: ProviderErrorAction;
    },
  ) {
    super(message, options);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = options?.retryable ?? defaultRetryable(code);
    this.action = options?.action ?? ACTION_BY_CODE[code];
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options?.providerKey) this.providerKey = options.providerKey;
    if (options?.attempt !== undefined) this.attempt = options.attempt;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      action: this.action,
      ...(this.httpStatus !== undefined ? { httpStatus: this.httpStatus } : {}),
      ...(this.providerKey ? { providerKey: this.providerKey } : {}),
      ...(this.attempt !== undefined ? { attempt: this.attempt } : {}),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

function defaultRetryable(code: ProviderErrorCode): boolean {
  return (
    code === "PROVIDER_RATE_LIMIT"
    || code === "PROVIDER_UNAVAILABLE"
    || code === "PROVIDER_TIMEOUT"
    || code === "PROVIDER_NETWORK"
    || code === "PROVIDER_CIRCUIT_OPEN"
    || code === "PROVIDER_QUEUE_TIMEOUT"
    || code === "PROCESS_JOB_LIMIT"
  );
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** Map HTTP status + body snippet to a stable code. */
export function providerErrorCodeFromHttp(status: number, body = ""): ProviderErrorCode {
  if (status === 429) return "PROVIDER_RATE_LIMIT";
  if (status === 401 || status === 403) return "PROVIDER_AUTH";
  if (status === 408 || status === 504) return "PROVIDER_TIMEOUT";
  if (status === 500 || status === 502 || status === 503 || status === 520 || status === 521 || status === 522 || status === 523 || status === 524) {
    return "PROVIDER_UNAVAILABLE";
  }
  const lower = body.toLowerCase();
  if (/rate limit|too many requests|配额|额度|quota/i.test(lower)) return "PROVIDER_RATE_LIMIT";
  if (/unauthorized|invalid api key|authentication/i.test(lower)) return "PROVIDER_AUTH";
  return "PROVIDER_HTTP";
}

export function providerErrorFromUnknown(error: unknown, fallbackCode: ProviderErrorCode = "PROVIDER_NETWORK"): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderError("PROVIDER_ABORTED", error.message || "请求已取消", { cause: error, retryable: false });
  }
  if (error instanceof Error && (error.name === "TimeoutError" || /timeout|timed out|超时/i.test(error.message))) {
    return new ProviderError("PROVIDER_TIMEOUT", error.message || "请求超时", { cause: error, retryable: true });
  }
  const message = error instanceof Error ? error.message : String(error ?? "未知网络错误");
  return new ProviderError(fallbackCode, message, {
    cause: error instanceof Error ? error : undefined,
    retryable: true,
  });
}

/** Compact public matrix for health/docs consumers. */
export function providerErrorCodeMatrix(): Array<{
  code: ProviderErrorCode;
  retryable: boolean;
  action: ProviderErrorAction;
}> {
  return (Object.keys(ACTION_BY_CODE) as ProviderErrorCode[]).map(code => ({
    code,
    retryable: defaultRetryable(code),
    action: ACTION_BY_CODE[code],
  }));
}
