/** Stable machine-readable failure kinds shared by model-backed tool handlers. */
export type ToolFailureKind = "dependency" | "invalid_output" | "validation" | "semantic_revision";

/**
 * A tool dependency failed before it could produce a domain verdict.
 * This must never be presented to the Agent as evidence that user content is bad.
 */
export class ToolDependencyError extends Error {
  readonly failureKind = "dependency" as const;
  readonly retryable = true;

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolDependencyError";
  }
}

/** A domain gate rejected submitted content and requires a prose revision. */
export class ToolRevisionRequiredError extends Error {
  readonly failureKind = "semantic_revision" as const;
  readonly retryable = true;

  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ToolRevisionRequiredError";
  }
}

/** Provider/client timeout shapes differ; normalize them before retry policy sees them. */
export function isToolDependencyTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TimeoutError" || error.name === "AbortError") return true;
  const message = error.message.toLowerCase();
  return message.includes("due to timeout") || message.includes("timed out") || message.includes("timeout exceeded");
}
