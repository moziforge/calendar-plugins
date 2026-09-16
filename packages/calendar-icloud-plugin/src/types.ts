/**
 * Purpose: Define the normalized calendar vocabulary shared by the CalDAV
 * client, the iCalendar parser, the Host service, and the DSH tools.
 *
 * High-level flow: raw CalDAV/ICS values enter at `client.ts` and `ical.ts`,
 * are normalized once into these shapes, and every outward surface (tool output,
 * service return value, test assertion) speaks only these shapes. Keeping one
 * vocabulary means a provider-specific detail can never leak into a tool schema.
 *
 * Important behavior:
 * - Timed instants are UTC ISO-8601 strings (`2026-01-05T01:00:00.000Z`).
 *   The originating zone is preserved separately in `timeZone` instead of being
 *   baked into the string, because a calendar event's zone is a property of the
 *   event, not of its rendered instant.
 * - All-day events carry date-only strings (`2026-01-05`) and `allDay: true`.
 *   `end` stays exclusive, matching RFC 5545 DTEND semantics, so a one-day event
 *   has `start === '2026-01-05'` and `end === '2026-01-06'`.
 *
 * Example:
 * Input: an iCloud VEVENT
 *   `DTSTART;TZID=Asia/Shanghai:20260105T090000` / `DTEND;TZID=Asia/Shanghai:20260105T100000`.
 * Process: `ical.ts` converts both to UTC instants and notes the TZID.
 * Result: `{ start: '2026-01-05T01:00:00.000Z', end: '2026-01-05T02:00:00.000Z',
 *   timeZone: 'Asia/Shanghai', allDay: false }`.
 *
 * Architectural boundaries:
 * - Types only. This module performs no I/O and imports no dependency, so both
 *   the browser-free Host half and tests can depend on it freely.
 */

/** Lifecycle state of one event as published by the calendar owner. */
export type EventStatus = 'confirmed' | 'tentative' | 'cancelled'

/** One calendar collection inside the account. */
export interface CalendarSummary {
  /** Stable identity: the absolute CalDAV collection URL. */
  id: string
  /** Human-facing name; falls back to the URL's last path segment. */
  name: string
  /** Calendar description, empty string when the server omits it. */
  description: string
  /** IANA zone extracted from the calendar's VTIMEZONE default, when present. */
  timeZone?: string
  /** `#RRGGBB` color when iCloud publishes one. */
  color?: string
  /** Component kinds the collection accepts, e.g. `['VEVENT']`. */
  components: string[]
}

/**
 * One event occurrence, already expanded onto the wall clock.
 *
 * A recurring series produces one entry per occurrence inside the queried
 * window. `uid` stays the series identity and `recurrenceId` identifies the
 * occurrence, so the pair `(uid, recurrenceId)` is unique inside one response.
 */
export interface CalendarEvent {
  /** Series identity from the VEVENT `UID`. */
  uid: string
  /** Occurrence identity for expanded series; absent on non-recurring events. */
  recurrenceId?: string
  /** Owning calendar identity, matching `CalendarSummary.id`. */
  calendarId: string
  /** Owning calendar display name, so callers need not join two responses. */
  calendarName: string
  summary: string
  /** UTC ISO-8601 instant for timed events, `YYYY-MM-DD` for all-day events. */
  start: string
  /** Exclusive end in the same representation as `start`. */
  end: string
  allDay: boolean
  /** IANA zone of the occurrence, `floating` when the VEVENT carried none. */
  timeZone?: string
  location?: string
  description?: string
  status: EventStatus
  /** True when the master VEVENT carried RRULE/RDATE, regardless of instance count. */
  recurring: boolean
  /** Absolute CalDAV object URL, useful for follow-up inspection. */
  url?: string
}

/** One requested time window, validated before any network call. */
export interface EventWindow {
  /** Inclusive lower bound as an absolute instant. */
  start: Date
  /** Exclusive upper bound as an absolute instant. */
  end: Date
}

/** Input accepted by `CalendarService.createEvent`. */
export interface CreateEventRequest {
  /** Target calendar name or id; omitted means the only configured calendar. */
  calendar?: string
  summary: string
  /** RFC3339 timestamp with an explicit offset, or `YYYY-MM-DD` for an all-day event. */
  start: string
  /** Same format as `start`; exclusive for all-day events. */
  end: string
  location?: string
  description?: string
}

/** Outcome of a successful event creation. */
export interface CreatedEvent {
  uid: string
  calendarId: string
  calendarName: string
  /** Absolute CalDAV object URL of the created resource. */
  url: string
  start: string
  end: string
  allDay: boolean
}
