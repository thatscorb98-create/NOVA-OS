/**
 * Pause policy.
 *
 * A paused company performs no autonomous work. Two exceptions are deliberate:
 *
 *   * system maintenance jobs, which keep the queue healthy, and
 *   * the owner's own dry-run audit, which is read-only and exists to explain a
 *     paused company without resuming it.
 *
 * The audit exemption is tied to the `ownerStarted` marker that
 * `start_audit_run` writes into the queued job payload. An audit queued by
 * anything else — or any other job that happens to use the `audit.run` kind
 * without the marker — stays deferred like every other non-system job.
 */

const SYSTEM_PREFIX = 'system.';

/** Jobs that may run while the company is paused, given the right payload. */
const PAUSED_EXEMPT_KINDS = new Set(['audit.run']);

/** System jobs are allowed to run even while the company is paused. */
export function isSystemJob(kind: string): boolean {
  return kind.startsWith(SYSTEM_PREFIX);
}

/**
 * Whether a claimed job may run while the owner has paused the company.
 *
 * `payload` is the queued job payload. The owner-started marker is written by
 * the database when the owner asks for the audit, so it is not something the
 * caller of this function can set to widen the exemption.
 */
export function runsWhilePaused(
  kind: string,
  payload: Record<string, unknown> = {},
): boolean {
  if (isSystemJob(kind)) return true;
  return PAUSED_EXEMPT_KINDS.has(kind) && payload.ownerStarted === true;
}
