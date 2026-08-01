/** Stable machine-readable failure kinds shared by model-backed tool handlers. */
export type ToolFailureKind = "dependency" | "invalid_output" | "validation";

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
