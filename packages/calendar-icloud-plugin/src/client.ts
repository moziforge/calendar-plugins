/**
 * Purpose: Own the HTTP/CalDAV boundary — connect to iCloud, enumerate calendar
 * collections, query events in a window, and create new event resources.
 *
 * High-level flow:
 * 1. `connect` performs DAV discovery for the account. tsdav walks
 *    `/.well-known/caldav` (iCloud answers 301 to the CalDAV root), reads
 *    `current-user-principal`, then `calendar-home-set`, so the caller only
 *    supplies the Apple ID, the app-specific password, and the entry point URL.
 * 2. `listCalendars` PROPFINDs the calendar home with Depth 1 and projects each
 *    collection into `CalendarSummary`, discarding provider-only fields.
 * 3. `fetchObjects` issues one `calendar-query` REPORT per collection with a
 *    time-range filter and `calendar-data`, so a window costs one request per
 *    calendar rather than one per event.
 * 4. `createObject` PUTs an iCalendar resource with `If-None-Match: *`, so a
 *    colliding filename fails loudly instead of silently overwriting an event.
 *
 * Important behavior:
 * - Every request carries a deadline built from `AbortSignal.timeout` combined
 *   with the caller's signal through `AbortSignal.any`. Discovery is given the
 *   same budget as queries because a hung iCloud endpoint would otherwise pin a
 *   tool call open indefinitely.
 * - There is deliberately **no automatic retry**. iCloud rate-limits CalDAV
 *   access, and an unobserved retry storm is worse than a surfaced failure: the
 *   caller sees `CALENDAR_UPSTREAM_FAILED` and decides whether to try again.
 * - Credentials are held in the client instance and only ever appear in the
 *   Authorization header tsdav builds. No method returns, logs, or embeds them,
 *   and error messages are produced by `toCalendarError`, which never copies
 *   request headers.
 *
 * Example:
 * Input: credentials for `me@example.com` with a valid app-specific password.
 * Process: `connect` resolves the account home URL; `listCalendars` returns
 *   `[{ id: 'https://p42-caldav.icloud.com/123/calendars/home/', name: 'Home',
 *   components: ['VEVENT'], description: '', timeZone: 'Asia/Shanghai' }]`;
 *   `fetchObjects` for 2026-01-05..2026-01-06 returns the two `.ics` resources
 *   whose events the server judged to overlap that range.
 * Result: parsed and expanded by `ical.ts` into concrete occurrences, with one
 *   network round trip per calendar for the whole window.
 *
 * Edge-case Example:
 * Input: the account has two calendars named `Work`, and the caller asks for `Work`.
 * Process: `listCalendars` returns both with distinct `id`s; the Host resolves the
 *   name and finds more than one match.
 * Result: `CALENDAR_UNKNOWN_CALENDAR` listing both collection URLs, so the caller
 *   can disambiguate by id instead of silently reading the wrong calendar.
 *
 * Architectural boundaries:
 * - Transport only. This module does not parse iCalendar (that is `ical.ts`),
 *   does not cache (that is `host.ts`), and does not build tool schemas
 *   (that is `tools.ts`).
 */

import { createDAVClient, type DAVCalendar, type DAVResponse } from 'tsdav'
import type { Credentials } from './config.js'
import { CalendarError, toCalendarError } from './errors.js'
import type { CalendarSummary } from './types.js'

/** One fetched calendar resource, before parsing. */
export interface RemoteCalendarObject {
  url: string
  data: string
}

/** A connected CalDAV session bound to one account. */
export class ICloudCalendarClient {
  private constructor(
    private readonly dav: Awaited<ReturnType<typeof createDAVClient>>,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Performs DAV discovery and returns a session bound to the discovered home.
   *
   * Logic:
   * 1. Build the per-attempt deadline before the first request so a hung
   *    discovery cannot outlive the configured budget.
   * 2. Delegate discovery to tsdav with Basic auth; the app-specific password is
   *    the only password iCloud accepts for a two-factor account.
   * 3. Classify any failure through `toCalendarError`, turning tsdav's
   *    "Invalid credentials: ... 401 Unauthorized" into `CALENDAR_AUTH_FAILED`.
   *
   * External calls and effects: three authenticated PROPFIND requests
   * (`/.well-known/caldav`, the principal URL, the calendar home). No local state.
   *
   * @param credentials - resolved account, password, entry point, and deadline.
   * @param signal - optional caller cancellation, combined with the deadline.
   * @returns a connected client.
   * @throws CalendarError `CALENDAR_AUTH_FAILED` or `CALENDAR_UPSTREAM_FAILED`.
   */
  static async connect(credentials: Credentials, signal?: AbortSignal): Promise<ICloudCalendarClient> {
    const deadline = combineSignal(signal, credentials.timeoutMs)
    try {
      const dav = await createDAVClient({
        serverUrl: credentials.serverUrl,
        credentials: { username: credentials.account, password: credentials.password },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
        fetchOptions: { signal: deadline },
      })
      return new ICloudCalendarClient(dav, credentials.timeoutMs)
    } catch (error) {
      throw toCalendarError(error)
    }
  }

  /**
   * Lists the calendar collections reachable from the account's home.
   *
   * Logic: PROPFIND the home with Depth 1 for display name, description,
   * default VTIMEZONE, color, and supported components, then project each
   * collection into the plugin's summary shape.
   *
   * External calls and effects: one PROPFIND per listing plus tsdav's
   * `supportedReportSet` probe per returned collection. iCloud counts each of
   * those against its rate limit, which is why the Host caches the result.
   *
   * @param signal - optional caller cancellation.
   * @returns the account's calendars, in server order.
   * @throws CalendarError when the request fails.
   */
  async listCalendars(signal?: AbortSignal): Promise<CalendarSummary[]> {
    try {
      const calendars = await this.dav.fetchCalendars({ fetchOptions: { signal: combineSignal(signal, this.timeoutMs) } })
      return calendars.map(toCalendarSummary)
    } catch (error) {
      throw toCalendarError(error)
    }
  }

  /**
   * Fetches the calendar resources overlapping a window.
   *
   * Logic: issue **one** `calendar-query` REPORT that asks for `calendar-data`
   * together with a VEVENT time-range filter, then project each response.
   *
   * Why this does not use the library's `fetchCalendarObjects`: that helper
   * always spends two round trips per collection — first a REPORT that only
   * collects hrefs, then either a second REPORT or a `calendar-multiget` to
   * retrieve the bodies. Measured against the fixture, a collection holding two
   * events produced two REPORTs, and a collection holding none produced one.
   * Since iCloud rate-limits CalDAV, halving the request count for the common
   * case is worth building the filter here.
   *
   * External calls and effects: one authenticated REPORT per call. The server
   * performs coarse overlap filtering; `ical.ts` re-checks precisely because a
   * moved or long-running occurrence can still fall outside the filter.
   *
   * @param calendarId - absolute collection URL from `CalendarSummary.id`.
   * @param start - inclusive window start.
   * @param end - exclusive window end.
   * @param signal - optional caller cancellation.
   * @returns raw resources; unparsable ones surface later during parsing.
   */
  async fetchObjects(calendarId: string, start: Date, end: Date, signal?: AbortSignal): Promise<RemoteCalendarObject[]> {
    try {
      const responses = await this.dav.calendarQuery({
        url: calendarId,
        props: { 'd:getetag': {}, 'c:calendar-data': {} },
        filters: [{
          'comp-filter': {
            _attributes: { name: 'VCALENDAR' },
            'comp-filter': {
              _attributes: { name: 'VEVENT' },
              'time-range': { _attributes: { start: calDavTime(start), end: calDavTime(end) } },
            },
          },
        }],
        depth: '1',
        fetchOptions: { signal: combineSignal(signal, this.timeoutMs) },
      })
      return responses
        .filter(response => response.ok)
        .map(response => ({ url: new URL(response.href ?? '', calendarId).href, data: calendarData(response) }))
        .filter((object): object is RemoteCalendarObject => typeof object.data === 'string')
    } catch (error) {
      throw toCalendarError(error)
    }
  }

  /**
   * Creates one event resource in a collection.
   *
   * Logic: PUT the serialized VCALENDAR with `If-None-Match: *`, which the
   * client library sets. Any non-2xx response is surfaced rather than treated as
   * success, so a rejected write never looks like a created meeting.
   *
   * External calls and effects: one authenticated PUT that mutates the user's
   * calendar. The effect is immediate and idempotent only because the filename
   * embeds a fresh UUID; a repeated call creates a second event by design.
   *
   * Failure / lifecycle: 412 (precondition failed) means the object already
   * exists and is reported as an upstream failure; the caller may retry with a
   * new identifier. There is no rollback — a 5xx response after the server
   * accepted the body is indistinguishable from one before it, so the error
   * message tells the caller to verify the calendar before retrying.
   *
   * @param calendarId - absolute collection URL from `CalendarSummary.id`.
   * @param filename - resource name, conventionally `<uid>.ics`.
   * @param iCalString - complete VCALENDAR text.
   * @param signal - optional caller cancellation.
   * @returns the created resource URL.
   */
  async createObject(calendarId: string, filename: string, iCalString: string, signal?: AbortSignal): Promise<{ url: string }> {
    try {
      const response = await this.dav.createCalendarObject({
        calendar: { url: calendarId } as DAVCalendar,
        filename,
        iCalString,
        fetchOptions: { signal: combineSignal(signal, this.timeoutMs) },
      })
      if (!response.ok) {
        throw new CalendarError('CALENDAR_UPSTREAM_FAILED', `iCloud rejected the new event with HTTP ${response.status}. If the resource already existed, retry with a new identifier; otherwise verify the calendar has not been changed.`)
      }
      return { url: new URL(filename, calendarId).href }
    } catch (error) {
      throw toCalendarError(error)
    }
  }
}

/**
 * Builds the effective per-request deadline.
 *
 * Logic: the caller's signal (tool cancellation) and a fresh timeout are
 * combined, so whichever fires first aborts the request. `AbortSignal.any`
 * keeps both reasons, and `toCalendarError` maps the resulting abort to
 * `CALENDAR_ABORTED` rather than blaming iCloud.
 *
 * @param signal - caller cancellation, when present.
 * @param timeoutMs - plugin-configured deadline.
 * @returns a signal that aborts on cancellation or deadline.
 */
function combineSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

/**
 * Formats one instant the way a CalDAV `time-range` attribute expects.
 *
 * Logic: the format is UTC `YYYYMMDDTHHMMSSZ` with no separators, which is not
 * RFC 3339; passing an ISO string would make the server ignore the filter and
 * return every object in the collection.
 *
 * @param date - the instant to format.
 * @returns the CalDAV basic-format UTC timestamp.
 */
function calDavTime(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

/**
 * Extracts the iCalendar body from one REPORT response.
 *
 * Logic: the XML parser yields a plain string for element text, but a `<![CDATA[]]>`
 * section arrives as `{ _cdata }`. Both shapes occur in the wild, so both are
 * accepted and anything else is reported as absent.
 *
 * @param response - one parsed DAV response.
 * @returns the raw iCalendar text, or undefined when the response carried none.
 */
function calendarData(response: DAVResponse): unknown {
  const value = (response.props as Record<string, unknown> | undefined)?.calendarData
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && '_cdata' in value) return (value as { _cdata?: unknown })._cdata
  return undefined
}

/**
 * Projects a server collection into the plugin's calendar summary.
 *
 * Logic:
 * 1. Normalize `displayName`, which xml-js can hand back as an object when the
 *    element carries attributes; fall back to the collection URL's last segment
 *    so a calendar without a name is still addressable and legible.
 * 2. Extract the IANA identifier from the collection's default VTIMEZONE, which
 *    iCloud sends as a full iCalendar blob rather than a zone name.
 * 3. Reduce the color to `#RRGGBB`, dropping the alpha byte Apple appends,
 *    because the tool output is read by a model, not a renderer.
 *
 * @param calendar - a collection returned by tsdav.
 * @returns the normalized summary.
 */
function toCalendarSummary(calendar: DAVCalendar): CalendarSummary {
  const rawName = calendar.displayName
  const displayName = typeof rawName === 'string' ? rawName.trim() : ''
  const timeZone = extractTimeZoneId(calendar.timezone)
  const color = normalizeColor(calendar.calendarColor)
  return {
    id: calendar.url,
    name: displayName || lastPathSegment(calendar.url),
    description: typeof calendar.description === 'string' ? calendar.description : '',
    ...(timeZone ? { timeZone } : {}),
    ...(color ? { color } : {}),
    components: Array.isArray(calendar.components) ? calendar.components : [],
  }
}

/** Extracts the `TZID` line from a collection's default VTIMEZONE blob. */
function extractTimeZoneId(timezone: unknown): string | undefined {
  if (typeof timezone !== 'string') return undefined
  const match = /(?:^|\r?\n)TZID:([^\r\n]+)/.exec(timezone)
  const tzid = match?.[1]?.trim()
  return tzid ? tzid : undefined
}

/** Reduces `#RRGGBBAA` or `#RRGGBB` to `#RRGGBB`, rejecting anything else. */
function normalizeColor(color: unknown): string | undefined {
  if (typeof color !== 'string') return undefined
  const match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(color.trim())
  return match ? `#${match[1]!.toUpperCase()}` : undefined
}

/** Returns the last non-empty path segment, used as a nameless calendar's name. */
function lastPathSegment(url: string): string {
  const segments = url.split('/').filter(segment => segment.length > 0)
  return decodeURIComponent(segments.at(-1) ?? url)
}
