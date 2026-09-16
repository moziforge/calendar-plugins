/**
 * Purpose: Register the model-facing calendar tools against the Host
 * `ctx.calendar` service.
 *
 * High-level flow: each `defineTool` declaration supplies the model-visible
 * schema plus an `execute` that delegates to the service. `defineTool` validates
 * and freezes arguments before `execute` runs, so a tool body never has to
 * re-check types and can rely on the schema being the authoritative contract.
 *
 * Important behavior:
 * - Every tool forwards `exec.signal` into the service, so cancelling a call
 *   aborts the in-flight CalDAV request instead of leaving it to finish.
 * - Failures propagate as thrown `CalendarError`s. The registry converts them
 *   into error content carrying the message, which is written for a model
 *   reader: it names the missing environment variable or the ambiguous calendar
 *   rather than surfacing a stack trace.
 * - `timeoutMs` is declared so the deployment's cooperative timeout policy can
 *   bound a call; the underlying requests already carry their own deadline.
 *
 * Example:
 * Input: the model calls `calendar_list_events` with
 *   `{ start: '2026-01-05T00:00:00+08:00', end: '2026-01-06T00:00:00+08:00' }`.
 * Process: `defineTool` validates both required strings, then `execute` calls
 *   `ctx.calendar.listEvents`, which returns a `ListEventsResult`.
 * Result: the model receives that result as compact JSON text, and the same value
 *   is the persisted tool result.
 *
 * Edge-case Example:
 * Input: `calendar_list_events` with `limit: 0`.
 * Process: the schema accepts an integer, so validation passes; the service's
 *   `resolveLimit` rejects it as non-positive.
 * Result: `CALENDAR_INVALID_INPUT: limit must be a positive integer, received 0.`
 *   — a schema cannot express "positive integer" in this DSL, so the service owns
 *   the bound and reports it explicitly instead of silently defaulting.
 *
 * Architectural boundaries:
 * - Registration and argument surface only. No CalDAV, no parsing, no caching;
 *   all of that belongs to the service this module injects.
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type {} from './host.js'

export const name = 'moziforge-calendar-icloud-tools'

export const inject = ['tools', 'calendar']

/** Shared canonical output: a lossless JSON value rendered as compact text. */
const output = {
  schema: { type: 'json' as const },
  render: (_: unknown, value: JsonValue) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** Converts a service result into the lossless JSON value the output declares. */
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'calendar_status',
    description: 'Report whether iCloud calendar access is configured and reachable. Call this first when a calendar tool reports that it is not configured, or after changing credentials. Never returns the app-specific password; it only reports which environment variable is expected and whether that variable currently holds a value.',
    parameters: {},
    output,
    execute: async () => json(ctx.calendar.status()),
  }))

  ctx.tools.register(defineTool({
    name: 'calendar_list_calendars',
    description: 'List the iCloud calendars available to this agent, with each calendar id, display name, default time zone, color, and supported component types. Use the returned name or id as the `calendars` argument of calendar_list_events or the `calendar` argument of calendar_create_event. The result is cached for a few minutes.',
    parameters: {},
    output,
    execute: async (_args, exec) => json(await ctx.calendar.listCalendars(exec.signal)),
  }))

  ctx.tools.register(defineTool({
    name: 'calendar_list_events',
    description: 'List event occurrences inside a time window. Recurring events are expanded into one entry per occurrence, so a weekly meeting appears once per week in the range, and occurrences cancelled individually are omitted. Timed events report UTC instants plus the event\'s own IANA time zone in `timeZone`; all-day events report date-only `YYYY-MM-DD` values with `allDay: true` and an exclusive `end`. The window is capped at 366 days.',
    parameters: {
      start: { type: 'string', required: true, description: 'Inclusive window start as an ISO-8601 timestamp with an explicit offset, for example 2026-01-05T00:00:00+08:00 or 2026-01-04T16:00:00Z.' },
      end: { type: 'string', required: true, description: 'Exclusive window end in the same format as start. Must be after start, for example 2026-01-06T00:00:00+08:00.' },
      calendars: { type: 'array', items: { type: 'string' }, description: 'Optional calendar names or ids to read. Omit to read every calendar this agent may access. A name that matches more than one calendar is rejected; use the id then.' },
      limit: { type: 'integer', description: 'Maximum number of occurrences to return, defaulting to 200. The response still reports `total`, the full match count before the limit was applied.' },
    },
    output,
    execute: async (args, exec) => json(await ctx.calendar.listEvents(args, exec.signal)),
  }))

  ctx.tools.register(defineTool({
    name: 'calendar_create_event',
    description: 'Create one event in an iCloud calendar. The format of start and end states the intent: two date-only values (2026-01-05) create an all-day event whose end date is exclusive, while two RFC3339 values with an explicit offset create a timed event. A timestamp without an offset is rejected because it would be interpreted in the host time zone. Pass `calendar` when more than one calendar is available, otherwise the target is ambiguous and the call fails.',
    parameters: {
      summary: { type: 'string', required: true, description: 'Event title, for example "Design review".' },
      start: { type: 'string', required: true, description: 'Event start as 2026-01-05T09:00:00+08:00 for a timed event or 2026-01-05 for an all-day event.' },
      end: { type: 'string', required: true, description: 'Event end in the same format as start. For an all-day event this is exclusive: a single day is start=2026-01-05, end=2026-01-06. Events without an end are not supported, so always provide a real end.' },
      calendar: { type: 'string', description: 'Target calendar name or id. Required when the account exposes more than one calendar to this agent.' },
      location: { type: 'string', description: 'Optional free-text location, for example "Room 3" or an address.' },
      description: { type: 'string', description: 'Optional longer notes for the event body.' },
    },
    output,
    execute: async (args, exec) => json(await ctx.calendar.createEvent(args, exec.signal)),
  }))
}
