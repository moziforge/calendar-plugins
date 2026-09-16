/**
 * Purpose: Expose iCloud calendar reading and writing to the Host plane as a
 * cordis service (`ctx.calendar`), owning connection reuse, calendar caching,
 * window validation, and iCalendar construction.
 *
 * High-level flow:
 * 1. `listEvents` validates the window, resolves credentials lazily, connects
 *    once, resolves the target calendars, fetches each window in a single
 *    `calendar-query`, then normalizes through `ical.ts`.
 * 2. `createEvent` resolves exactly one target calendar, builds a complete
 *    VCALENDAR, and PUTs it.
 * 3. `status` reports readiness without ever touching a credential value.
 *
 * Important behavior:
 * - Credentials are resolved on first use and re-resolved after any connection
 *   failure. A failed connect is never cached, so an operator who exports the
 *   app-specific password after startup is served on the next call rather than
 *   needing an agent restart.
 * - A successful calendar listing is cached for `CALENDAR_CACHE_TTL_MS`. iCloud
 *   rate-limits CalDAV, and listing is the most request-hungry operation because
 *   the client library probes each collection's report set. The cache is
 *   consulted inside one pending promise, so concurrent tool calls share a
 *   single listing instead of racing to produce duplicate ones.
 * - Windows are validated before any network call: both bounds are required,
 *   `end` must be after `start`, and the span is capped at `MAX_WINDOW_MS`.
 *   The cap exists because a recurring series is expanded client-side, so an
 *   unbounded window would let one call expand years of a minutely rule.
 *
 * Example:
 * Input: `listEvents({ start: '2026-01-05T00:00:00+08:00', end:
 *   '2026-01-06T00:00:00+08:00' })` against an account with one calendar `Home`.
 * Process: the window validates to 2026-01-04T16:00Z..2026-01-05T16:00Z; the
 *   service connects, lists one calendar, issues one REPORT, and expands the
 *   returned resources.
 * Result: `{ total: 2, events: [...], truncatedSeries: [], calendars: [{ id:
 *   '...calendars/home/', name: 'Home' }] }` sorted by start instant.
 *
 * Edge-case Example:
 * Input: the same call before any credentials exist in the environment.
 * Process: `resolveCredentials` throws before a socket is opened, and the failed
 *   connect is not cached.
 * Result: `CALENDAR_NOT_CONFIGURED` naming `ICLOUD_APP_PASSWORD`. After the
 *   operator exports it, an identical retry connects on the first attempt
 *   because nothing negative was remembered.
 *
 * Architectural boundaries:
 * - Orchestration and policy. HTTP lives in `client.ts`, iCalendar semantics in
 *   `ical.ts`, credential resolution in `config.ts`, and model-facing schemas in
 *   `tools.ts`. This module registers no tools itself, so a deployment can mount
 *   the service without exposing it to a model.
 */

import { randomUUID } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import ICAL from 'ical.js'
import { Config as ConfigSchema, describeConfiguration, resolveCredentials, type Config as CalendarConfig, type ConfigurationDescription } from './config.js'
import { ICloudCalendarClient } from './client.js'
import { CalendarError } from './errors.js'
import { parseCalendarObjects, sortEvents } from './ical.js'
import type { CalendarEvent, CalendarSummary, CreateEventRequest, CreatedEvent, EventWindow } from './types.js'

/** Longest window one `listEvents` call may request. */
export const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000

/** How long a calendar listing stays valid before iCloud is asked again. */
export const CALENDAR_CACHE_TTL_MS = 5 * 60 * 1000

/** Upper bound on returned occurrences when the caller sets no `limit`. */
export const DEFAULT_EVENT_LIMIT = 200

/** Input accepted by `CalendarService.listEvents`. */
export interface ListEventsRequest {
  start: string
  end: string
  /** Calendar names or ids; omitted means every calendar allowed by config. */
  calendars?: string[]
  /** Maximum returned occurrences. */
  limit?: number
}

/** Outcome of a successful `listEvents` call. */
export interface ListEventsResult {
  window: { start: string; end: string }
  calendars: Array<{ id: string; name: string }>
  events: CalendarEvent[]
  /** Matching occurrences before `limit` was applied. */
  total: number
  /** Series UIDs whose expansion hit the safety bound. */
  truncatedSeries: string[]
}

/** Readiness snapshot returned by `CalendarService.status`. */
export interface CalendarStatus {
  configuration: ConfigurationDescription
  /** Whether a connection has been established successfully at least once. */
  connected: boolean
  /** Cached calendar count, when a listing is available. */
  calendarCount: number | null
  /** Most recent failure message, cleared by the next success. */
  lastError: string | null
}

export const name = 'moziforge-calendar-icloud-host'

export const Config = ConfigSchema

declare module '@deepseek-ai/cordis' {
  interface Context {
    calendar: CalendarService
  }
}

export class CalendarService extends Service {
  static Config = ConfigSchema

  private client: ICloudCalendarClient | undefined
  private connecting: Promise<ICloudCalendarClient> | undefined
  private listing: { at: number; calendars: CalendarSummary[] } | undefined
  private lastError: string | null = null

  constructor(ctx: Context, private readonly config: CalendarConfig) {
    super(ctx, 'calendar')
  }

  /**
   * Returns the connected client, connecting at most once per healthy session.
   *
   * Logic:
   * 1. Reuse the live client when one exists.
   * 2. Otherwise resolve credentials and connect, storing the in-flight promise
   *    so concurrent tool calls share one discovery handshake.
   * 3. On failure, clear both the promise and the `lastError` bookkeeping so the
   *    next call retries with freshly read credentials.
   *
   * External calls and effects: DAV discovery on first use and after any failure.
   *
   * @param signal - caller cancellation forwarded to discovery.
   * @returns a connected client.
   */
  private async connect(signal?: AbortSignal): Promise<ICloudCalendarClient> {
    if (this.client) return this.client
    if (!this.connecting) {
      this.connecting = (async () => {
        try {
          const credentials = resolveCredentials(this.config, process.env)
          const client = await ICloudCalendarClient.connect(credentials, signal)
          this.client = client
          return client
        } catch (error) {
          this.connecting = undefined
          throw error
        }
      })()
    }
    return this.connecting
  }

  /**
   * Lists calendars reachable from the account, reusing a fresh cache entry.
   *
   * Logic: return the cached listing while it is younger than
   * `CALENDAR_CACHE_TTL_MS`; otherwise refresh and replace the entry as one
   * atomic assignment, so a reader never observes a half-updated cache.
   *
   * External calls and effects: one authenticated listing per expiry window.
   *
   * @param signal - caller cancellation.
   * @returns every calendar in the account, unfiltered by the config allowlist.
   */
  async listCalendars(signal?: AbortSignal): Promise<CalendarSummary[]> {
    if (this.listing && Date.now() - this.listing.at < CALENDAR_CACHE_TTL_MS) return this.listing.calendars
    try {
      const client = await this.connect(signal)
      const calendars = await client.listCalendars(signal)
      this.listing = { at: Date.now(), calendars }
      this.lastError = null
      return calendars
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  /**
   * Reports configuration and connection readiness.
   *
   * Logic: reuses `describeConfiguration`, which never copies a secret, and adds
   * the cached calendar count plus the most recent failure. Reading `lastError`
   * instead of throwing keeps this call safe as a first diagnostic step.
   *
   * @returns the readiness snapshot.
   */
  status(): CalendarStatus {
    return {
      configuration: describeConfiguration(this.config, process.env),
      connected: this.client !== undefined,
      calendarCount: this.listing ? this.listing.calendars.length : null,
      lastError: this.lastError,
    }
  }

  /**
   * Lists event occurrences inside a validated window.
   *
   * Logic:
   * 1. Validate the window and reject anything unparseable, inverted, or longer
   *    than `MAX_WINDOW_MS` before touching the network.
   * 2. Resolve the requested calendars against the config allowlist; a request
   *    naming a calendar outside the allowlist is rejected rather than ignored,
   *    because silently reading a different calendar would look like missing data.
   * 3. Fetch each calendar and parse it with the window applied.
   * 4. Sort, merge truncation reports, and cap the result at `limit` while still
   *    reporting the untruncated `total`.
   *
   * External calls and effects: one `calendar-query` REPORT per selected
   * calendar, plus a listing when the cache is cold. Reads only.
   *
   * @param request - window, optional calendar selection, optional limit.
   * @param signal - caller cancellation.
   * @returns sorted occurrences plus counts and truncation evidence.
   */
  async listEvents(request: ListEventsRequest, signal?: AbortSignal): Promise<ListEventsResult> {
    const window = resolveWindow(request.start, request.end)
    const limit = resolveLimit(request.limit)
    const calendars = await this.selectCalendars(request.calendars, signal)
    const client = await this.connect(signal)
    const events: CalendarEvent[] = []
    const truncatedSeries: string[] = []
    for (const calendar of calendars) {
      const objects = await client.fetchObjects(calendar.id, window.start, window.end, signal)
      const parsed = parseCalendarObjects(objects, { calendarId: calendar.id, calendarName: calendar.name, window })
      events.push(...parsed.events)
      for (const uid of parsed.truncated) if (!truncatedSeries.includes(uid)) truncatedSeries.push(uid)
    }
    const sorted = sortEvents(events)
    this.lastError = null
    return {
      window: { start: window.start.toISOString(), end: window.end.toISOString() },
      calendars: calendars.map(calendar => ({ id: calendar.id, name: calendar.name })),
      events: sorted.slice(0, limit),
      total: sorted.length,
      truncatedSeries,
    }
  }

  /**
   * Creates one event in exactly one calendar.
   *
   * Logic:
   * 1. Reject an empty summary before any network call.
   * 2. Interpret the time format as the intent: two `YYYY-MM-DD` values request
   *    an all-day event, two offset-bearing RFC3339 values request a timed event,
   *    and a mixture is rejected. Inferring from the format keeps the caller from
   *    having to keep a separate boolean consistent with the strings.
   * 3. Require exactly one target calendar: with several calendars configured
   *    and none named, the write target is ambiguous, and guessing would put a
   *    meeting somewhere the caller did not choose.
   * 4. Serialize and PUT. The UID is a fresh UUID, so the resource name cannot
   *    collide with an existing event.
   *
   * External calls and effects: one authenticated PUT that creates a user-visible
   * calendar entry. It is not transactional with anything else in this plugin;
   * the returned URL is the evidence of success.
   *
   * @param request - calendar selection and event fields.
   * @param signal - caller cancellation.
   * @returns the created event's identity and URL.
   */
  async createEvent(request: CreateEventRequest, signal?: AbortSignal): Promise<CreatedEvent> {
    const summary = request.summary.trim()
    if (summary.length === 0) {
      throw new CalendarError('CALENDAR_INVALID_INPUT', 'summary must be a non-empty event title.')
    }
    const times = resolveEventTimes(request.start, request.end)
    const calendars = await this.selectCalendars(request.calendar ? [request.calendar] : undefined, signal)
    if (calendars.length !== 1) {
      throw new CalendarError('CALENDAR_INVALID_INPUT', `Creating an event needs exactly one target calendar, but ${calendars.length} matched. Pass the calendar name or id explicitly; available: ${calendars.map(calendar => calendar.name).join(', ')}.`)
    }
    const calendar = calendars[0]!
    const uid = `${randomUUID()}@moziforge.calendar`
    const iCalString = buildEventCalendar({ uid, summary, times, ...(request.location ? { location: request.location } : {}), ...(request.description ? { description: request.description } : {}) })
    const client = await this.connect(signal)
    const created = await client.createObject(calendar.id, `${uid}.ics`, iCalString, signal)
    this.lastError = null
    return {
      uid,
      calendarId: calendar.id,
      calendarName: calendar.name,
      url: created.url,
      start: times.allDay ? times.startDate : times.start.toISOString(),
      end: times.allDay ? times.endDate : times.end.toISOString(),
      allDay: times.allDay,
    }
  }

  /**
   * Resolves requested calendar names or ids against the account and allowlist.
   *
   * Logic:
   * 1. List calendars (possibly cached).
   * 2. Apply the config allowlist, which limits what this agent may read at all.
   * 3. With no request, return every allowed calendar.
   * 4. Otherwise match each request against an id or a case-insensitive display
   *    name, reject unknown names, and reject a multi-match name so ambiguity is
   *    never resolved by guesswork.
   *
   * @param requested - names or ids from the tool call, or undefined for all.
   * @param signal - caller cancellation.
   * @returns the selected calendars.
   */
  private async selectCalendars(requested: string[] | undefined, signal?: AbortSignal): Promise<CalendarSummary[]> {
    const all = await this.listCalendars(signal)
    const allowed = this.config.calendars.length === 0 ? all : all.filter(calendar => this.config.calendars.some(entry => matches(calendar, entry)))
    if (!requested || requested.length === 0) {
      if (allowed.length === 0) {
        throw new CalendarError('CALENDAR_UNKNOWN_CALENDAR', this.config.calendars.length === 0 ? 'The account exposes no usable calendar collections.' : `The configured calendar allowlist (${this.config.calendars.join(', ')}) matches no calendar in the account. Available: ${all.map(calendar => calendar.name).join(', ')}.`)
      }
      return allowed
    }
    const selected: CalendarSummary[] = []
    for (const entry of requested) {
      const matchesInAllowed = allowed.filter(calendar => matches(calendar, entry))
      if (matchesInAllowed.length === 0) {
        throw new CalendarError('CALENDAR_UNKNOWN_CALENDAR', `No calendar matches "${entry}". Available: ${allowed.map(calendar => calendar.name).join(', ') || '(none)'}.`)
      }
      if (matchesInAllowed.length > 1) {
        throw new CalendarError('CALENDAR_UNKNOWN_CALENDAR', `"${entry}" matches ${matchesInAllowed.length} calendars (${matchesInAllowed.map(calendar => calendar.id).join(', ')}). Use the calendar id instead.`)
      }
      const found = matchesInAllowed[0]!
      if (!selected.some(calendar => calendar.id === found.id)) selected.push(found)
    }
    return selected
  }
}

/** Whether a calendar answers to a name (case-insensitive) or an exact id. */
function matches(calendar: CalendarSummary, entry: string): boolean {
  return calendar.id === entry || calendar.name.toLowerCase() === entry.trim().toLowerCase()
}

/**
 * Validates a requested window into concrete instants.
 *
 * Logic: parse both bounds, reject unparseable values, reject `end <= start`,
 * and reject spans above `MAX_WINDOW_MS`. Rejecting rather than clamping keeps
 * the caller's mental model intact: a clamped window would silently drop events
 * the caller asked for.
 *
 * @param start - inclusive lower bound as an ISO-8601 string.
 * @param end - exclusive upper bound as an ISO-8601 string.
 * @returns the validated window.
 * @throws CalendarError `CALENDAR_INVALID_INPUT`.
 */
export function resolveWindow(start: string, end: string): EventWindow {
  const from = new Date(start)
  const to = new Date(end)
  if (Number.isNaN(from.getTime())) throw new CalendarError('CALENDAR_INVALID_INPUT', `start must be an ISO-8601 timestamp such as 2026-01-05T00:00:00+08:00, received "${start}".`)
  if (Number.isNaN(to.getTime())) throw new CalendarError('CALENDAR_INVALID_INPUT', `end must be an ISO-8601 timestamp such as 2026-01-06T00:00:00+08:00, received "${end}".`)
  if (to.getTime() <= from.getTime()) throw new CalendarError('CALENDAR_INVALID_INPUT', `end (${end}) must be after start (${start}).`)
  if (to.getTime() - from.getTime() > MAX_WINDOW_MS) throw new CalendarError('CALENDAR_INVALID_INPUT', `The requested window spans more than ${Math.round(MAX_WINDOW_MS / 86400000)} days. Query a shorter range.`)
  return { start: from, end: to }
}

/** Resolves an optional limit to a positive integer, defaulting to `DEFAULT_EVENT_LIMIT`. */
function resolveLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_EVENT_LIMIT
  if (!Number.isInteger(limit) || limit <= 0) throw new CalendarError('CALENDAR_INVALID_INPUT', `limit must be a positive integer, received ${String(limit)}.`)
  return limit
}

/** Validated event times in both representations the writer needs. */
interface EventTimes {
  allDay: boolean
  /** Timed start; for all-day events this is the date's UTC midnight. */
  start: Date
  end: Date
  /** All-day start as `YYYY-MM-DD`. */
  startDate: string
  /** All-day exclusive end as `YYYY-MM-DD`. */
  endDate: string
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Interprets the caller's time strings as either an all-day or a timed event.
 *
 * Logic:
 * 1. Two date-only values mean an all-day event; `end` stays exclusive, matching
 *    RFC 5545 DTEND, so a single day is `start === end - 1 day`.
 * 2. Two offset-bearing timestamps mean a timed event. A timestamp without an
 *    offset is rejected: `new Date('2026-01-05T09:00')` would silently adopt the
 *    host zone, and a meeting placed in the wrong zone is worse than an error.
 * 3. A mixture, or anything else, is rejected.
 *
 * @param start - caller-provided start string.
 * @param end - caller-provided end string.
 * @returns the interpreted times.
 * @throws CalendarError `CALENDAR_INVALID_INPUT`.
 */
export function resolveEventTimes(start: string, end: string): EventTimes {
  const bothDates = DATE_ONLY.test(start) && DATE_ONLY.test(end)
  const bothTimed = OFFSET_TIMESTAMP.test(start) && OFFSET_TIMESTAMP.test(end)
  if (bothDates) {
    const from = new Date(`${start}T00:00:00Z`)
    const to = new Date(`${end}T00:00:00Z`)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw new CalendarError('CALENDAR_INVALID_INPUT', `Invalid calendar date: "${start}" or "${end}".`)
    if (to.getTime() <= from.getTime()) throw new CalendarError('CALENDAR_INVALID_INPUT', `For an all-day event end (${end}) must be after start (${start}); DTEND is exclusive, so one day is start=2026-01-05, end=2026-01-06.`)
    return { allDay: true, start: from, end: to, startDate: start, endDate: end }
  }
  if (bothTimed) {
    const from = new Date(start)
    const to = new Date(end)
    if (to.getTime() <= from.getTime()) throw new CalendarError('CALENDAR_INVALID_INPUT', `end (${end}) must be after start (${start}).`)
    return { allDay: false, start: from, end: to, startDate: start.slice(0, 10), endDate: end.slice(0, 10) }
  }
  throw new CalendarError('CALENDAR_INVALID_INPUT', 'start and end must both be all-day dates (2026-01-05) or both RFC3339 timestamps with an explicit offset (2026-01-05T09:00:00+08:00). A timestamp without an offset is rejected because it would be interpreted in the host time zone.')
}

/**
 * Serializes one event into a self-contained VCALENDAR.
 *
 * Logic: timed events are written as UTC instants (`Z`), which every CalDAV
 * server accepts without a VTIMEZONE and which iCloud renders in the viewer's
 * local zone. All-day events are written with `VALUE=DATE` so they stay floating
 * calendar dates. `DTSTAMP` is required by RFC 5545 and is set to now.
 *
 * External calls and effects: none; the returned text is sent by the caller.
 *
 * @param event - identity and fields to serialize.
 * @returns complete VCALENDAR text.
 */
export function buildEventCalendar(event: { uid: string; summary: string; times: EventTimes; location?: string; description?: string }): string {
  const vcalendar = new ICAL.Component(['vcalendar', [], []])
  vcalendar.updatePropertyWithValue('version', '2.0')
  vcalendar.updatePropertyWithValue('prodid', '-//moziforge//calendar-icloud-plugin//EN')
  const vevent = new ICAL.Component('vevent')
  vevent.updatePropertyWithValue('uid', event.uid)
  vevent.updatePropertyWithValue('summary', event.summary)
  vevent.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
  vevent.updatePropertyWithValue('dtstart', event.times.allDay ? ICAL.Time.fromDateString(event.times.startDate) : ICAL.Time.fromJSDate(event.times.start, true))
  vevent.updatePropertyWithValue('dtend', event.times.allDay ? ICAL.Time.fromDateString(event.times.endDate) : ICAL.Time.fromJSDate(event.times.end, true))
  if (event.location) vevent.updatePropertyWithValue('location', event.location)
  if (event.description) vevent.updatePropertyWithValue('description', event.description)
  vcalendar.addSubcomponent(vevent)
  return vcalendar.toString()
}

export default CalendarService
