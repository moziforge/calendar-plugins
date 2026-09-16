/**
 * Purpose: Pin the iCalendar normalization and recurrence-expansion contract.
 *
 * High-level flow: each case feeds raw `VCALENDAR` text plus a window into
 * `parseCalendarObject` and asserts the normalized occurrences, so the tests
 * exercise the module exactly as the Host service calls it.
 *
 * Important behavior asserted here:
 * - A series queried far from its start keeps its original time of day. This is
 *   the regression guard for `ICAL.Event.iterator(startTime)`, which silently
 *   rewrites DTSTART to the passed value and would turn a 09:00 series into
 *   00:00 occurrences.
 * - A `TZID` is offset-correct when the resource carries its VTIMEZONE, which is
 *   what iCloud sends, so a 09:00 Asia/Shanghai event is a 01:00Z instant.
 * - All-day values stay date-only, because routing them through an instant would
 *   shift the calendar date west of UTC.
 *
 * Example:
 * Input: the `weekly series` case with a window covering 2026-01-05..2026-01-20.
 * Process: three weekly occurrences exist from 2026-01-05; the window keeps them
 *   all and the fourth, on 2026-01-26, is outside.
 * Result: exactly three events, the first at `2026-01-05T09:00:00.000Z`.
 */

import { describe, expect, it } from 'vitest'
import { CalendarError } from '../src/errors.js'
import { MAX_OCCURRENCES_PER_SERIES, parseCalendarObject, parseCalendarObjects, sortEvents } from '../src/ical.js'
import type { CalendarEvent, EventWindow } from '../src/types.js'

/** Wraps VEVENT bodies plus optional VTIMEZONEs into a VCALENDAR document. */
function ics(body: string, timezones = ''): string {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//stub//EN', timezones, body, 'END:VCALENDAR', ''].join('\r\n')
}

/** A fixed Asia/Shanghai VTIMEZONE, matching what iCloud attaches to events. */
const SHANGHAI = [
  'BEGIN:VTIMEZONE',
  'TZID:Asia/Shanghai',
  'BEGIN:STANDARD',
  'DTSTART:19700101T000000',
  'TZOFFSETFROM:+0800',
  'TZOFFSETTO:+0800',
  'TZNAME:CST',
  'END:STANDARD',
  'END:VTIMEZONE',
  '',
].join('\r\n')

/** Parses one resource with the standard fixture identity. */
function parse(data: string, window: EventWindow): CalendarEvent[] {
  return parseCalendarObject({ url: 'https://example.invalid/cal/event.ics', data }, { calendarId: 'https://example.invalid/cal/', calendarName: 'Home', window }).events
}

/** Builds a half-open window from two ISO instants. */
function window(from: string, to: string): EventWindow {
  return { start: new Date(from), end: new Date(to) }
}

describe('recurrence expansion', () => {
  it('emits one occurrence per week inside the window and drops later ones', () => {
    const data = ics([
      'BEGIN:VEVENT',
      'UID:weekly-1',
      'DTSTART:20260105T090000Z',
      'DTEND:20260105T093000Z',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=4',
      'SUMMARY:Weekly sync',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    const events = parse(data, window('2026-01-05T00:00:00Z', '2026-01-20T00:00:00Z'))
    expect(events.map(event => event.start)).toEqual([
      '2026-01-05T09:00:00.000Z',
      '2026-01-12T09:00:00.000Z',
      '2026-01-19T09:00:00.000Z',
    ])
    expect(events.every(event => event.recurring)).toBe(true)
    expect(events[0]!.recurrenceId).toBe('2026-01-05T09:00:00.000Z')
    expect(events[0]!.end).toBe('2026-01-05T09:30:00.000Z')
  })

  it('preserves the time of day for a series that starts years before the window', () => {
    const data = ics([
      'BEGIN:VEVENT',
      'UID:daily-long',
      'DTSTART:20150105T090000Z',
      'DTEND:20150105T100000Z',
      'RRULE:FREQ=DAILY',
      'SUMMARY:Daily standup',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    const events = parse(data, window('2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z'))
    expect(events).toHaveLength(1)
    expect(events[0]!.start).toBe('2026-01-05T09:00:00.000Z')
    expect(events[0]!.end).toBe('2026-01-05T10:00:00.000Z')
  })

  it('honours EXDATE exclusions', () => {
    const data = ics([
      'BEGIN:VEVENT',
      'UID:with-exdate',
      'DTSTART:20260105T090000Z',
      'DTEND:20260105T093000Z',
      'RRULE:FREQ=DAILY;COUNT=3',
      'EXDATE:20260106T090000Z',
      'SUMMARY:Standup',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    const events = parse(data, window('2026-01-05T00:00:00Z', '2026-01-09T00:00:00Z'))
    expect(events.map(event => event.start)).toEqual(['2026-01-05T09:00:00.000Z', '2026-01-07T09:00:00.000Z'])
  })

  it('applies a moved override and removes a cancelled occurrence', () => {
    const data = ics([
      'BEGIN:VEVENT',
      'UID:overridden',
      'DTSTART:20260105T090000Z',
      'DTEND:20260105T100000Z',
      'RRULE:FREQ=DAILY;COUNT=3',
      'SUMMARY:Standup',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:overridden',
      'RECURRENCE-ID:20260106T090000Z',
      'DTSTART:20260106T140000Z',
      'DTEND:20260106T150000Z',
      'SUMMARY:Standup moved',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'UID:overridden',
      'RECURRENCE-ID:20260107T090000Z',
      'DTSTART:20260107T090000Z',
      'DTEND:20260107T100000Z',
      'STATUS:CANCELLED',
      'SUMMARY:Standup',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    const events = parse(data, window('2026-01-05T00:00:00Z', '2026-01-09T00:00:00Z'))
    expect(events).toHaveLength(2)
    expect(events[0]!.summary).toBe('Standup')
    expect(events[1]!.summary).toBe('Standup moved')
    expect(events[1]!.start).toBe('2026-01-06T14:00:00.000Z')
    expect(events[1]!.recurrenceId).toBe('2026-01-06T09:00:00.000Z')
  })

  it('reports truncation instead of silently returning nothing for a dense series', () => {
    const data = ics([
      'BEGIN:VEVENT',
      'UID:minutely',
      'DTSTART:20150105T090000Z',
      'DTEND:20150105T090100Z',
      'RRULE:FREQ=MINUTELY',
      'SUMMARY:Dense',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    const result = parseCalendarObject({ url: 'https://example.invalid/cal/dense.ics', data }, { calendarId: 'https://example.invalid/cal/', calendarName: 'Home', window: window('2026-01-05T00:00:00Z', '2026-01-05T01:00:00Z') })
    expect(result.events).toHaveLength(0)
    expect(result.truncated).toEqual(['minutely'])
    expect(MAX_OCCURRENCES_PER_SERIES).toBe(10000)
  })
})

describe('time zones and all-day values', () => {
  it('resolves a TZID against the resource VTIMEZONE', () => {
    const data = ics([
      'BEGIN:VEVENT',
      'UID:shanghai',
      'DTSTART;TZID=Asia/Shanghai:20260105T090000',
      'DTEND;TZID=Asia/Shanghai:20260105T100000',
      'SUMMARY:Morning review',
      'END:VEVENT',
      '',
    ].join('\r\n'), SHANGHAI)
    const events = parse(data, window('2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z'))
    expect(events).toHaveLength(1)
    expect(events[0]!.start).toBe('2026-01-05T01:00:00.000Z')
    expect(events[0]!.end).toBe('2026-01-05T02:00:00.000Z')
    expect(events[0]!.timeZone).toBe('Asia/Shanghai')
    expect(events[0]!.allDay).toBe(false)
  })

  it('keeps all-day events as date-only values with an exclusive end', () => {
    const data = ics([
      'BEGIN:VEVENT',
      'UID:holiday',
      'DTSTART;VALUE=DATE:20260105',
      'DTEND;VALUE=DATE:20260106',
      'SUMMARY:Public holiday',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    const events = parse(data, window('2026-01-05T00:00:00Z', '2026-01-07T00:00:00Z'))
    expect(events).toHaveLength(1)
    expect(events[0]!.allDay).toBe(true)
    expect(events[0]!.start).toBe('2026-01-05')
    expect(events[0]!.end).toBe('2026-01-06')
    expect(events[0]!.timeZone).toBeUndefined()
  })

  it('labels a time without TZID as floating and compares it as a UTC wall clock', () => {
    const data = ics([
      'BEGIN:VEVENT',
      'UID:floating',
      'DTSTART:20260105T090000',
      'DTEND:20260105T100000',
      'SUMMARY:Floating',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    const events = parse(data, window('2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z'))
    expect(events).toHaveLength(1)
    expect(events[0]!.timeZone).toBe('floating')
    expect(events[0]!.start).toBe('2026-01-05T09:00:00.000Z')
  })
})

describe('window filtering', () => {
  const single = ics([
    'BEGIN:VEVENT',
    'UID:single',
    'DTSTART:20260105T090000Z',
    'DTEND:20260105T100000Z',
    'SUMMARY:Meeting',
    'END:VEVENT',
    '',
  ].join('\r\n'))

  it('excludes an event that ends exactly at the window start', () => {
    expect(parse(single, window('2026-01-05T10:00:00Z', '2026-01-06T00:00:00Z'))).toHaveLength(0)
  })

  it('excludes an event that starts exactly at the window end', () => {
    expect(parse(single, window('2026-01-05T00:00:00Z', '2026-01-05T09:00:00Z'))).toHaveLength(0)
  })

  it('includes an event that straddles the window start', () => {
    expect(parse(single, window('2026-01-05T09:30:00Z', '2026-01-05T09:45:00Z'))).toHaveLength(1)
  })

  it('keeps a zero-length event sitting exactly on the window start', () => {
    const zero = ics([
      'BEGIN:VEVENT',
      'UID:zero',
      'DTSTART:20260105T090000Z',
      'DTEND:20260105T090000Z',
      'SUMMARY:Ping',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    expect(parse(zero, window('2026-01-05T09:00:00Z', '2026-01-05T10:00:00Z'))).toHaveLength(1)
  })

  it('drops a cancelled master entirely', () => {
    const cancelled = ics([
      'BEGIN:VEVENT',
      'UID:cancelled',
      'DTSTART:20260105T090000Z',
      'DTEND:20260105T100000Z',
      'STATUS:CANCELLED',
      'SUMMARY:Cancelled',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    expect(parse(cancelled, window('2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z'))).toHaveLength(0)
  })

  it('reports tentative status rather than discarding the event', () => {
    const tentative = ics([
      'BEGIN:VEVENT',
      'UID:tentative',
      'DTSTART:20260105T090000Z',
      'DTEND:20260105T100000Z',
      'STATUS:TENTATIVE',
      'SUMMARY:Maybe',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    expect(parse(tentative, window('2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z'))[0]!.status).toBe('tentative')
  })
})

describe('degenerate resources', () => {
  it('rejects an unparsable resource as an upstream failure', () => {
    expect(() => parse('this is not iCalendar', window('2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z')))
      .toThrowError(CalendarError)
  })

  it('keeps a resource that carries only a recurrence exception', () => {
    const orphan = ics([
      'BEGIN:VEVENT',
      'UID:orphan',
      'RECURRENCE-ID:20260105T090000Z',
      'DTSTART:20260105T110000Z',
      'DTEND:20260105T120000Z',
      'SUMMARY:Orphan override',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    const events = parse(orphan, window('2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z'))
    expect(events).toHaveLength(1)
    expect(events[0]!.start).toBe('2026-01-05T11:00:00.000Z')
  })

  it('falls back to the resource URL when a VEVENT has no UID', () => {
    const noUid = ics([
      'BEGIN:VEVENT',
      'DTSTART:20260105T090000Z',
      'DTEND:20260105T100000Z',
      'SUMMARY:No uid',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    expect(parse(noUid, window('2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z'))[0]!.uid).toBe('https://example.invalid/cal/event.ics')
  })
})

describe('merging and ordering', () => {
  it('sortEvents orders by start, then calendar, then summary', () => {
    const base = { calendarId: 'c', allDay: false, status: 'confirmed' as const, recurring: false }
    const events: CalendarEvent[] = [
      { ...base, uid: '3', calendarName: 'Work', summary: 'Beta', start: '2026-01-05T10:00:00.000Z', end: '2026-01-05T11:00:00.000Z' },
      { ...base, uid: '2', calendarName: 'Home', summary: 'Alpha', start: '2026-01-05T09:00:00.000Z', end: '2026-01-05T10:00:00.000Z' },
      { ...base, uid: '1', calendarName: 'Work', summary: 'Alpha', start: '2026-01-05T09:00:00.000Z', end: '2026-01-05T10:00:00.000Z' },
    ]
    expect(sortEvents(events).map(event => event.uid)).toEqual(['2', '1', '3'])
  })

  it('concatenates resources and merges truncation reports without duplicates', () => {
    const dense = ics([
      'BEGIN:VEVENT',
      'UID:dense',
      'DTSTART:20150105T090000Z',
      'DTEND:20150105T090100Z',
      'RRULE:FREQ=MINUTELY',
      'SUMMARY:Dense',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    const simple = ics([
      'BEGIN:VEVENT',
      'UID:simple',
      'DTSTART:20260105T090000Z',
      'DTEND:20260105T100000Z',
      'SUMMARY:Simple',
      'END:VEVENT',
      '',
    ].join('\r\n'))
    const result = parseCalendarObjects(
      [{ url: 'https://example.invalid/cal/a.ics', data: dense }, { url: 'https://example.invalid/cal/b.ics', data: simple }, { url: 'https://example.invalid/cal/c.ics', data: dense }],
      { calendarId: 'https://example.invalid/cal/', calendarName: 'Home', window: window('2026-01-05T00:00:00Z', '2026-01-06T00:00:00Z') },
    )
    expect(result.events.map(event => event.uid)).toEqual(['simple'])
    expect(result.truncated).toEqual(['dense'])
  })
})
