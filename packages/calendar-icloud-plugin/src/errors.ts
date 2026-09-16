/**
 * Purpose: Declare the stable error codes this plugin raises at its public tool
 * boundary, and one helper that maps any thrown value to a coded error.
 *
 * High-level flow:
 * 1. Tool bodies and the Host service throw `CalendarError` with a code from
 *    `CalendarErrorCode`; the message is written for a model or human reader.
 * 2. `toCalendarError` converts an unknown thrown value (a tsdav error, a
 *    network failure, an abort) into one of those codes so callers never have
 *    to pattern-match library message text.
 *
 * Important invariants:
 * - Messages never contain the app-specific password, the Authorization header,
 *   or any other credential value. Only the Apple ID account may appear, and it
 *   is the value the operator already configured, not a secret.
 * - Codes are part of the observable contract and are asserted by tests.
 *
 * Example:
 * Input: `createDAVClient` rejects with
 *   `Invalid credentials: PROPFIND https://caldav.icloud.com/ returned 401 Unauthorized`.
 * Process: the connect path passes that value to `toCalendarError`.
 * Result: a `CalendarError` with code `CALENDAR_AUTH_FAILED` and the message
 *   `iCloud rejected the credentials for <account>...`, so the model can tell
 *   the operator to regenerate an app-specific password instead of retrying.
 *
 * Architectural boundaries:
 * - This module owns error vocabulary only. It does not perform I/O, and it does
 *   not decide retry policy; retries live in the client that owns the request.
 */

/** Codes the calendar tools may surface to the model. */
export type CalendarErrorCode =
  /** Required credentials are absent from config and environment. */
  | 'CALENDAR_NOT_CONFIGURED'
  /** iCloud rejected the account or the app-specific password. */
  | 'CALENDAR_AUTH_FAILED'
  /** The requested calendar name or id is not present in the account. */
  | 'CALENDAR_UNKNOWN_CALENDAR'
  /** The caller supplied a malformed or unsupported time window or field. */
  | 'CALENDAR_INVALID_INPUT'
  /** iCloud was unreachable, rate-limited beyond retry, or answered with an error. */
  | 'CALENDAR_UPSTREAM_FAILED'
  /** The caller's abort signal fired or the request exceeded its timeout. */
  | 'CALENDAR_ABORTED'

/** A coded, model-readable failure raised by the calendar plugin. */
export class CalendarError extends Error {
  constructor(readonly code: CalendarErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'CalendarError'
  }
}

/**
 * Classifies one thrown value into a coded `CalendarError`.
 *
 * Logic:
 * 1. Re-throw an existing `CalendarError` unchanged so inner codes survive.
 * 2. Map abort/timeout failures first: they are caller cancellation, not an
 *    iCloud outage, and the distinction changes whether a retry is sensible.
 * 3. Map library auth text (`401`, `403`, `Unauthorized`, `Invalid credentials`)
 *    to `CALENDAR_AUTH_FAILED`. tsdav raises plain `Error`s without a status
 *    field, so message inspection is the only signal available. It is confined
 *    to this one function so the heuristic is replaceable in one place.
 * 4. Everything else becomes `CALENDAR_UPSTREAM_FAILED` carrying the original
 *    message, which never includes credentials because tsdav never echoes them.
 *
 * @param error - the value thrown by a dependency or by this plugin.
 * @returns a coded error safe to return to the model.
 */
export function toCalendarError(error: unknown): CalendarError {
  if (error instanceof CalendarError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new CalendarError('CALENDAR_ABORTED', `Calendar request aborted: ${message}`, { cause: error })
  }
  if (/(^|\D)(401|403)(\D|$)|unauthor|forbidden|invalid credentials|invalid password/i.test(message)) {
    return new CalendarError('CALENDAR_AUTH_FAILED', 'iCloud rejected the credentials. Verify the Apple ID account and generate a fresh app-specific password at https://appleid.apple.com.', { cause: error })
  }
  return new CalendarError('CALENDAR_UPSTREAM_FAILED', `iCloud CalDAV request failed: ${message}`, { cause: error })
}
