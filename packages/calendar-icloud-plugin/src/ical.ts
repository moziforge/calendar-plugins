/**
 * Purpose: Convert raw iCalendar resources into normalized event occurrences,
 * expanding recurring series onto the requested window.
 *
 * High-level flow:
 * 1. `ICAL.parse` reads one resource; the resulting component tree is used to
 *    register any VTIMEZONE it carries (see "Timezone behaviour" below).
 * 2. Each VEVENT is classified: recurrence exceptions are skipped because the
 *    master expands them, cancelled masters are dropped, and non-recurring
 *    events become a single occurrence.
 * 3. Recurring masters are expanded with `ICAL.Event.iterator()`, which applies
 *    RRULE, RDATE and EXDATE together and resolves per-occurrence overrides.
 * 4. Every candidate occurrence is filtered by window overlap and normalized.
 *
 * Timezone behaviour (the subtle part):
 * - ical.js resolves a `TZID` against the VTIMEZONE subcomponents of the same
 *   parsed document, so `toUnixTime()` is offset-correct whenever the resource
 *   is self-contained, which is what iCloud sends. Verified against a real
 *   Apple-style Asia/Shanghai VTIMEZONE: `09:00 Asia/Shanghai` yields
 *   `2026-01-05T01:00:00.000Z`, not `09:00Z`.
 * - `registerTimezones` additionally publishes each VTIMEZONE into ical.js's
 *   process-global registry, skipping identifiers already present. This covers a
 *   resource that uses a `TZID` without repeating its VTIMEZONE. The registry is
 *   global mutable state: an identifier is never overwritten, so the first
 *   definition seen wins and a later resource cannot retroactively reinterpret
 *   an earlier event.
 * - When a `TZID` cannot be resolved at all, ical.js falls back to treating the
 *   wall clock as UTC. The emitted instant is then offset-wrong but the emitted
 *   `timeZone` still carries the original identifier, so the discrepancy is
 *   visible to a caller rather than silently absorbed.
 *
 * Important behavior:
 * - Instants are compared with `ICAL.Time.toUnixTime()`, never `toJSDate()`.
 *   `toJSDate()` interprets floating times in the *host* zone, which would make
 *   results depend on the machine running the agent; `toUnixTime()` is
 *   deterministic. Floating times and all-day dates therefore compare as if
 *   their wall clock were UTC. All-day output stays date-only, so the calendar
 *   date a user sees is unaffected by that comparison convention.
 * - Expansion is iterated from the series start, because
 *   `ICAL.Event.iterator(startTime)` **replaces** DTSTART with the passed value
 *   and would shift the time of day. Measured: a daily 09:00Z series iterated
 *   from `2026-01-01T00:00:00Z` yields 00:00Z occurrences. This module therefore
 *   never passes a start time, and bounds the walk with
 *   `MAX_OCCURRENCES_PER_SERIES` instead.
 *
 * Example:
 * Input: a window of 2026-01-05T00:00Z..2026-01-08T00:00Z and one resource with a
 *   master `DTSTART:20260105T090000Z`, `RRULE:FREQ=DAILY;COUNT=3`, plus an
 *   override moving the 2026-01-06 occurrence to 14:00Z and a CANCELLED
 *   override for 2026-01-07.
 * Process: the master is not an exception and not cancelled, so it expands to
 *   three occurrences; `getOccurrenceDetails` substitutes the moved event for
 *   the second and returns the CANCELLED status for the third.
 * Result: two events — `2026-01-05T09:00:00.000Z` and `2026-01-06T14:00:00.000Z`
 *   (the second carrying `recurrenceId: '2026-01-06T09:00:00.000Z'`). The
 *   cancelled occurrence is absent, and a 14:00 query window would still match it.
 *
 * Edge-case Example:
 * Input: `RRULE:FREQ=MINUTELY` starting in 2015, queried for one hour in 2026.
 * Process: iteration begins at the series start and would need millions of steps
 *   to reach the window.
 * Result: the walk stops after `MAX_OCCURRENCES_PER_SERIES` steps, the events
 *   found so far are returned, and the series UID is reported in `truncated` so
 *   the caller can see the answer is incomplete instead of assuming no events.
 *
 * Architectural boundaries:
 * - Parsing, expansion, and normalization only. This module performs no network
 *   I/O, does not select which calendar to read, and does not decide retry or
 *   caching policy; those belong to `client.ts` and `host.ts`.
 */

import ICAL from 'ical.js'
import { CalendarError } from './errors.js'
import type { CalendarEvent, EventStatus, EventWindow } from './types.js'

/**
 * Hard bound on the occurrences walked per recurring series.
 *
 * 10,000 steps covers a daily series running for 27 years before the window,
 * which is far beyond any realistic calendar, while still terminating a
 * pathological minutely rule in bounded time.
 */
export const MAX_OCCURRENCES_PER_SERIES = 10000

/** One CalDAV calendar object as returned by the client. */
export interface CalendarObjectInput {
  /** Absolute object URL, echoed into `CalendarEvent.url`. */
  url: string
  /** Raw iCalendar text. */
  data: string
}

/** Identity and window applied to every event parsed from one calendar. */
export interface ParseContext {
  calendarId: string
  calendarName: string
  window: EventWindow
}

/** Outcome of parsing one or more resources. */
export interface ParseResult {
  events: CalendarEvent[]
  /** Series UIDs whose expansion stopped at `MAX_OCCURRENCES_PER_SERIES`. */
  truncated: string[]
}

/**
 * Parses one calendar resource into windowed occurrences.
 *
 * Logic:
 * 1. Parse and validate the root component; malformed text is an upstream
 *    failure, not an empty result, so the caller can see the calendar is broken.
 * 2. Register the resource's VTIMEZONEs before any time property is read.
 * 3. Expand masters; recur only through masters so exceptions are not emitted twice.
 * 4. If a resource carries only recurrence exceptions — the master lives in
 *    another resource — emit them as standalone events instead of dropping them.
 *
 * @param object - object URL plus raw iCalendar text.
 * @param context - owning calendar identity and the queried window.
 * @returns occurrences overlapping the window, plus truncated series UIDs.
 * @throws CalendarError `CALENDAR_UPSTREAM_FAILED` when the text is not a VCALENDAR.
 */
export function parseCalendarObject(object: CalendarObjectInput, context: ParseContext): ParseResult {
  const root = parseRoot(object.data, object.url)
  registerTimezones(root)
  const components = root.getAllSubcomponents('vevent')
  const hasMaster = components.some(component => !isException(component))
  const events: CalendarEvent[] = []
  const truncated: string[] = []
  for (const component of components) {
    const event = new ICAL.Event(component)
    const exception = event.isRecurrenceException()
    if (hasMaster && exception) continue
    const status = statusOf(component)
    if (status === 'cancelled') continue
    if (exception || !event.isRecurring()) {
      const single = singleOccurrence(event, status, context, object.url)
      if (single) events.push(single)
      continue
    }
    const expanded = expandSeries(event, context, object.url)
    events.push(...expanded.events)
    if (expanded.truncated) truncated.push(expanded.uid)
  }
  return { events, truncated }
}

/**
 * Parses several resources and concatenates their occurrences.
 *
 * Logic: fold each resource's result, preserving the first-seen order of both
 * `events` and `truncated` so output is stable across runs.
 *
 * External calls and effects: none; pure transformation of already-fetched text.
 *
 * @param objects - resources belonging to one calendar.
 * @param context - owning calendar identity and the queried window.
 * @returns merged occurrences and the union of truncated series UIDs.
 */
export function parseCalendarObjects(objects: readonly CalendarObjectInput[], context: ParseContext): ParseResult {
  const events: CalendarEvent[] = []
  const truncated: string[] = []
  for (const object of objects) {
    const parsed = parseCalendarObject(object, context)
    events.push(...parsed.events)
    for (const uid of parsed.truncated) if (!truncated.includes(uid)) truncated.push(uid)
  }
  return { events, truncated }
}

/**
 * Sorts occurrences chronologically, then by calendar and title for stability.
 *
 * Separate from parsing so callers that merge several calendars can sort once.
 * Sorting compares parsed instants rather than the rendered strings, because a
 * date-only value such as `2026-01-06` and an instant such as
 * `2026-01-06T09:00:00.000Z` are not lexicographically ordered by time — string
 * comparison would place every all-day entry of a day before the day's timed
 * entries by accident rather than by rule. An all-day value is placed at UTC
 * midnight, so all-day entries sort before that day's timed entries.
 *
 * @param events - occurrences from any number of calendars.
 * @returns a new array sorted by start instant, calendar name, then summary.
 */
export function sortEvents(events: readonly CalendarEvent[]): CalendarEvent[] {
  return [...events].sort((left, right) => {
    const leftStart = sortInstant(left)
    const rightStart = sortInstant(right)
    if (leftStart !== rightStart) return leftStart - rightStart
    if (left.calendarName !== right.calendarName) return left.calendarName < right.calendarName ? -1 : 1
    if (left.summary !== right.summary) return left.summary < right.summary ? -1 : 1
    return 0
  })
}

/**
 * Maps a rendered start to a comparable instant in milliseconds.
 *
 * Logic: date-only values name a calendar date, so they resolve to that date's
 * UTC midnight; every other value is already an absolute instant. Invalid values
 * sort to the epoch rather than throwing, because this runs on data the parser
 * already produced and a sort must not be able to fail a whole query.
 *
 * @param event - a normalized event.
 * @returns the sortable instant.
 */
function sortInstant(event: CalendarEvent): number {
  const parsed = Date.parse(event.allDay ? `${event.start}T00:00:00Z` : event.start)
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Parses a resource and rejects anything that is not a VCALENDAR. */
function parseRoot(data: string, url: string): ICAL.Component {
  let root: ICAL.Component
  try {
    root = new ICAL.Component(ICAL.parse(data))
  } catch (error) {
    throw new CalendarError('CALENDAR_UPSTREAM_FAILED', `iCloud returned an unparsable iCalendar object at ${url}.`, { cause: error })
  }
  if (root.name !== 'vcalendar') {
    throw new CalendarError('CALENDAR_UPSTREAM_FAILED', `iCloud returned a ${root.name || 'non-calendar'} component at ${url} instead of a VCALENDAR.`)
  }
  return root
}

/**
 * Publishes the resource's VTIMEZONE definitions into ical.js's registry.
 *
 * Logic: for each VTIMEZONE, read its TZID and register it only when the
 * identifier is absent. Skipping present identifiers is what keeps the global
 * registry append-only, so registering later resources cannot change the
 * meaning of times already normalized.
 *
 * External calls and effects: mutates ical.js's process-global timezone registry.
 * A malformed VTIMEZONE is contained here rather than failing the whole resource,
 * because ical.js can still resolve the zone from the component tree in the
 * common self-contained case.
 *
 * @param root - the parsed VCALENDAR.
 */
function registerTimezones(root: ICAL.Component): void {
  for (const timezone of root.getAllSubcomponents('vtimezone')) {
    const tzid = timezone.getFirstPropertyValue('tzid')
    if (typeof tzid !== 'string' || tzid.length === 0) continue
    if (ICAL.TimezoneService.has(tzid)) continue
    try {
      ICAL.TimezoneService.register(timezone)
    } catch {
      // An unusable VTIMEZONE leaves the TZID in place on the time property, so
      // the caller still learns which zone the event claimed to be in.
    }
  }
}

/** Whether a VEVENT is a recurrence exception rather than a series master. */
function isException(component: ICAL.Component): boolean {
  return component.getFirstPropertyValue('recurrence-id') !== null
}

/** Normalizes the VEVENT STATUS property to the plugin's vocabulary. */
function statusOf(component: ICAL.Component): EventStatus {
  const raw = component.getFirstPropertyValue('status')
  const text = typeof raw === 'string' ? raw.toUpperCase() : ''
  if (text === 'CANCELLED') return 'cancelled'
  if (text === 'TENTATIVE') return 'tentative'
  return 'confirmed'
}

/** Emits a non-recurring event when it overlaps the window. */
function singleOccurrence(event: ICAL.Event, status: EventStatus, context: ParseContext, url: string): CalendarEvent | undefined {
  const start = event.startDate
  if (!start) return undefined
  const end = event.endDate ?? start
  if (!overlaps(start, end, context.window)) return undefined
  return normalize(event, start, end, undefined, status, false, context, url)
}

/**
 * Expands one recurring master across the window.
 *
 * Logic:
 * 1. Iterate occurrences from the series start — never from a passed start time,
 *    which would rewrite the series time of day.
 * 2. Stop once the recurrence identity reaches the window end, because the
 *    iterator yields occurrences in ascending recurrence order. The window test
 *    for inclusion uses the occurrence's own start/end, so a moved or long
 *    occurrence whose identity precedes the window is still matched.
 * 3. Stop after `MAX_OCCURRENCES_PER_SERIES` steps and report truncation.
 * 4. Resolve each occurrence through `getOccurrenceDetails` so per-occurrence
 *    overrides replace the master values and CANCELLED overrides remove the
 *    occurrence entirely.
 *
 * External calls and effects: none.
 *
 * @returns the occurrences in the window plus whether the walk was truncated.
 */
function expandSeries(event: ICAL.Event, context: ParseContext, url: string): { events: CalendarEvent[]; truncated: boolean; uid: string } {
  const uid = event.uid || ''
  const events: CalendarEvent[] = []
  const windowEndSeconds = context.window.end.getTime() / 1000
  const iterator = event.iterator()
  let steps = 0
  for (;;) {
    const occurrence = iterator.next()
    if (!occurrence) return { events, truncated: false, uid }
    if (steps >= MAX_OCCURRENCES_PER_SERIES) return { events, truncated: true, uid }
    steps += 1
    if (occurrence.toUnixTime() >= windowEndSeconds) return { events, truncated: false, uid }
    const details = event.getOccurrenceDetails(occurrence)
    const item = details.item ?? event
    const status = statusOf(item.component)
    if (status === 'cancelled') continue
    const start = details.startDate ?? occurrence
    const end = details.endDate ?? start
    if (!overlaps(start, end, context.window)) continue
    events.push(normalize(item, start, end, occurrence, status, true, context, url))
  }
}

/**
 * Projects one resolved occurrence into the normalized event shape.
 *
 * Logic: read identity and descriptive fields from the resolved item — which is
 * the override when one exists — and render times through `instantString`.
 *
 * @param item - the master or override event that supplied this occurrence.
 * @param start - occurrence start.
 * @param end - occurrence end, exclusive for all-day events.
 * @param recurrenceId - recurrence identity, present only for expanded series.
 * @param status - resolved lifecycle status.
 * @param recurring - whether the series carries recurrence rules.
 * @param context - owning calendar identity and window.
 * @param url - resource URL.
 * @returns the normalized event.
 */
function normalize(item: ICAL.Event, start: ICAL.Time, end: ICAL.Time, recurrenceId: ICAL.Time | undefined, status: EventStatus, recurring: boolean, context: ParseContext, url: string): CalendarEvent {
  const property = item.component.getFirstProperty('dtstart')
  const timeZone = zoneOf(start, property)
  const location = item.location
  const description = item.description
  return {
    uid: item.uid || url,
    ...(recurrenceId ? { recurrenceId: instantString(recurrenceId) } : {}),
    calendarId: context.calendarId,
    calendarName: context.calendarName,
    summary: item.summary || '(no title)',
    start: instantString(start),
    end: instantString(end),
    allDay: Boolean(start.isDate),
    ...(timeZone ? { timeZone } : {}),
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    status,
    recurring,
    url,
  }
}

/**
 * Reports whether an occurrence intersects the window.
 *
 * Logic: instants are compared in UTC seconds. A zero-length occurrence is kept
 * when it sits exactly on the window start, while a positive-length occurrence
 * that merely ends exactly at the window start is excluded — the boundary case
 * that would otherwise leak the previous window's last meeting into the next one.
 *
 * @param start - occurrence start.
 * @param end - occurrence end, exclusive for all-day events.
 * @param window - queried window, half-open.
 * @returns whether the occurrence should be reported.
 */
function overlaps(start: ICAL.Time, end: ICAL.Time, window: EventWindow): boolean {
  const startSeconds = start.toUnixTime()
  const endSeconds = end.toUnixTime()
  const windowStart = window.start.getTime() / 1000
  const windowEnd = window.end.getTime() / 1000
  if (!(startSeconds < windowEnd)) return false
  return endSeconds > startSeconds ? endSeconds > windowStart : endSeconds >= windowStart
}

/**
 * Renders one time as a deterministic string.
 *
 * Logic: all-day times render as the calendar date they name, because converting
 * them through an instant would shift the date for any zone west of UTC. Every
 * other time renders as its UTC instant.
 *
 * @param time - the time to render.
 * @returns `YYYY-MM-DD` for date-only values, otherwise a UTC ISO-8601 instant.
 */
export function instantString(time: ICAL.Time): string {
  if (time.isDate) {
    const month = String(time.month).padStart(2, '0')
    const day = String(time.day).padStart(2, '0')
    return `${String(time.year).padStart(4, '0')}-${month}-${day}`
  }
  return new Date(time.toUnixTime() * 1000).toISOString()
}

/**
 * Reports the zone a time property claims.
 *
 * Logic: date-only values have no zone. Otherwise prefer the property's TZID
 * parameter, which survives an unresolvable zone; fall back to the resolved
 * zone's identifier, which yields `UTC` for `Z` values and `floating` for values
 * with neither a TZID nor a `Z`.
 *
 * @param time - the parsed time.
 * @param property - the property the time came from, when available.
 * @returns the zone identifier, or `undefined` for date-only values.
 */
function zoneOf(time: ICAL.Time, property: ICAL.Property | null): string | undefined {
  if (time.isDate) return undefined
  const tzid = property?.getParameter('tzid')
  if (typeof tzid === 'string' && tzid.length > 0) return tzid
  const resolved = time.zone && time.zone.tzid
  return typeof resolved === 'string' && resolved.length > 0 ? resolved : undefined
}
