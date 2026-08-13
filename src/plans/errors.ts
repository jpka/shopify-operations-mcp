/**
 * Host-side error codes for the execute path, complementing the core's token
 * lifecycle codes. The core owns UNKNOWN_TOKEN/PLAN_EXPIRED/PLAN_USED/
 * PLAN_MISMATCH/AWAITING_APPROVAL/PLAN_REJECTED; this host owns the errors
 * its own domain data and thresholds produce.
 *
 * STATE_CHANGED is deliberately NOT a core code: the core's errors are about
 * the token lifecycle, and "the underlying data drifted since the preview"
 * is a property of the host's domain data — exactly the same split
 * sw-postgres-mcp makes with its ROWSET_CHANGED host code. It is represented
 * here as a host error (thrown after the token has been consumed and a
 * "refused" audit row recorded), never as a reused core PlanError.
 */
export type ExecutionErrorCode = "STATE_CHANGED" | "HARD_MAX_ITEMS_EXCEEDED";

/**
 * Structured host error, mirroring the core's PlanError convention: `code`
 * is machine-actionable, `message` is human-readable, `hint` tells the
 * caller what to do next. Never expose a raw exception from a deeper layer.
 */
export class ExecutionError extends Error {
  readonly code: ExecutionErrorCode;
  readonly hint?: string;

  constructor(code: ExecutionErrorCode, message: string, hint?: string) {
    super(message);
    this.name = "ExecutionError";
    this.code = code;
    this.hint = hint;
  }
}