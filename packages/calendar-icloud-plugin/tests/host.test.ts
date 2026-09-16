/**
 * Purpose: Verify the Host service end to end against a real HTTP CalDAV
 * fixture, driven only through public service methods.
 *
 * High-level flow: `fixture` starts the stub, mounts the plugin on a real cordis
 * context with the stub's URL, and returns the service. Each case calls a public
 * method and asserts on the returned value, the thrown `CalendarError` code, the
 * requests the fixture observed, or the bytes the fixture accepted.
 *
 * Important behavior asserted here:
 * - Discovery works through the `/.well-known/caldav` redirect, the principal
 *   URL, and the calendar home, so the happy path proves the full handshake.
 * - A wrong password surfaces as `CALENDAR_AUTH_FAILED` and the message never
 *   contains the password, which is the credential-leak guard.
 * - A failed connect is not cached, so fixing the environment recovers without
 *   remounting the plugin.
 * - A calendar listing is cached, so a second query does not repeat the Depth-1
 *   PROPFIND that iCloud rate-limits.
 * - Timed events are written as UTC instants and all-day events as `VALUE=DATE`,
 *   verified by parsing the bytes the fixture received rather than by trusting
 *   the write path.
 *
 * Example:
 * Input: the `lists calendars discovered through the .well-known redirect` case.
 * Process: the service authenticates, follows the redirect, resolves the home,
 *   and lists one collection.
 * Result: `[{ name: 'Home', description: 'Family', timeZone: 'Asia/Shanghai',
 *   color: '#FF2968', components: ['VEVENT'] }]`, and the fixture saw three
 *   PROPFIND requests plus one per-collection report probe.
 */

import { Context } from '@deepseek-ai/cordis'
import ICAL from 'ical.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CalendarError } from '../src/errors.js'
import CalendarService from '../src/host.js'
import { startCaldavStub, type StubOptions, type StubServer } from './caldav-stub.js'

const HOME = '/123/calendars/home/'
const WORK = '/123/calendars/work/'

const contexts: Context[] = []
const stubs: StubServer[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const stub of stubs.splice(0)) await stub.close()
  vi.unstubAllEnvs()
})

/** One recurring timed event and one all-day event, as iCloud would return them. */
const SEEDED_OBJECTS: Record<string, Array<{ path: string; ics: string }>> = {
  [HOME]: [
    {
      path: 'standup.ics',
      ics: [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//stub//EN',
        'BEGIN:VEVENT',
        'UID:standup-1',
        'DTSTART:20260105T090000Z',
        'DTEND:20260105T093000Z',
        'RRULE:FREQ=DAILY;COUNT=5',
        'SUMMARY:Standup',
        'LOCATION:Room 3',
        'END:VEVENT',
        'END:VCALENDAR', '',
      ].join('\r\n'),
    },
    {
      path: 'holiday.ics',
      ics: [
        'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//stub//EN',
        'BEGIN:VEVENT',
        'UID:holiday-1',
        'DTSTART;VALUE=DATE:20260106',
        'DTEND;VALUE=DATE:20260107',
        'SUMMARY:Public holiday',
        'END:VEVENT',
        'END:VCALENDAR', '',
      ].join('\r\n'),
    },
  ],
}

interface FixtureOptions {
  stub?: Partial<StubOptions>
  credentials?: { username: string; password: string }
  config?: Partial<{ calendars: string[]; account: string; timeoutMs: number; passwordEnv: string }>
  /** `null` removes the password from the environment. */
  password?: string | null
}

/**
 * Mounts the plugin against a fresh fixture.
 *
 * External calls and effects: binds a loopback HTTP port, sets process
 * environment variables through `vi.stubEnv`, and registers a cordis context;
 * teardown closes each of those.
 *
 * @param options - fixture overrides.
 * @returns the mounted service and its fixture.
 */
async function fixture(options: FixtureOptions = {}) {
  const credentials = options.credentials ?? { username: 'me@example.com', password: 'app-pass' }
  const stub = await startCaldavStub({
    account: credentials,
    calendars: [
      { path: HOME, name: 'Home', description: 'Family', color: '#FF2968FF', timeZoneId: 'Asia/Shanghai' },
      { path: WORK, name: 'Work' },
    ],
    objects: SEEDED_OBJECTS,
    ...options.stub,
  })
  stubs.push(stub)
  const password = options.password === undefined ? credentials.password : options.password
  vi.stubEnv('ICLOUD_APP_PASSWORD', password ?? '')
  vi.stubEnv('ICLOUD_ACCOUNT', credentials.username)
  const context = new Context()
  contexts.push(context)
  await context.plugin(CalendarService, {
    account: options.config?.account ?? credentials.username,
    serverUrl: stub.url,
    timeoutMs: options.config?.timeoutMs ?? 5000,
    calendars: options.config?.calendars ?? [],
    passwordEnv: options.config?.passwordEnv ?? 'ICLOUD_APP_PASSWORD',
  })
  return { service: context.calendar, context, stub }
}

/** Runs a call and returns the thrown error, failing when nothing was thrown. */
async function caught(run: () => Promise<unknown>): Promise<CalendarError> {
  try {
    await run()
  } catch (error) {
    if (error instanceof CalendarError) return error
    throw error
  }
  throw new Error('expected the call to fail, but it succeeded')
}

describe('discovery and listing', () => {
  it('lists calendars discovered through the .well-known redirect', async () => {
    const { service, stub } = await fixture()
    const calendars = await service.listCalendars()
    expect(calendars.map(calendar => calendar.name)).toEqual(['Home', 'Work'])
    expect(calendars[0]).toEqual({
      id: `http://127.0.0.1:${new URL(stub.url).port}${HOME}`,
      name: 'Home',
      description: 'Family',
      timeZone: 'Asia/Shanghai',
      color: '#FF2968',
      components: ['VEVENT'],
    })
    expect(stub.requestsOf('PROPFIND').map(request => request.path).slice(0, 4))
      .toEqual(['/.well-known/caldav', '/', '/123/principal/', '/123/calendars/'])
  })

  it('reuses the cached listing instead of re-querying the calendar home', async () => {
    const { service, stub } = await fixture()
    await service.listCalendars()
    await service.listCalendars()
    const homeListings = stub.requestsOf('PROPFIND').filter(request => request.path === '/123/calendars/')
    expect(homeListings).toHaveLength(1)
  })

  it('issues exactly one REPORT per selected calendar and reuses the cached listing', async () => {
    const { service, stub } = await fixture()
    await service.listEvents({ start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z' })
    expect(stub.requestsOf('REPORT').map(request => request.path)).toEqual([HOME, WORK])
    await service.listEvents({ start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z', calendars: ['Work'] })
    expect(stub.requestsOf('REPORT').map(request => request.path)).toEqual([HOME, WORK, WORK])
    expect(stub.requestsOf('PROPFIND').filter(request => request.path === '/123/calendars/')).toHaveLength(1)
  })
})

describe('event queries', () => {
  it('expands recurring events and keeps all-day values date-only', async () => {
    const { service } = await fixture()
    const result = await service.listEvents({ start: '2026-01-05T00:00:00Z', end: '2026-01-07T00:00:00Z' })
    expect(result.total).toBe(3)
    expect(result.events.map(event => event.start)).toEqual(['2026-01-05T09:00:00.000Z', '2026-01-06', '2026-01-06T09:00:00.000Z'])
    expect(result.events.map(event => event.summary)).toEqual(['Standup', 'Public holiday', 'Standup'])
    expect(result.events[0]!.location).toBe('Room 3')
    expect(result.events[1]!.allDay).toBe(true)
    expect(result.calendars.map(calendar => calendar.name)).toEqual(['Home', 'Work'])
    expect(result.truncatedSeries).toEqual([])
  })

  it('reports the untruncated total when a limit is applied', async () => {
    const { service } = await fixture()
    const result = await service.listEvents({ start: '2026-01-05T00:00:00Z', end: '2026-01-07T00:00:00Z', limit: 1 })
    expect(result.events).toHaveLength(1)
    expect(result.total).toBe(3)
  })

  it('reads only the requested calendar', async () => {
    const { service, stub } = await fixture()
    const result = await service.listEvents({ start: '2026-01-05T00:00:00Z', end: '2026-01-07T00:00:00Z', calendars: ['Work'] })
    expect(result.events).toEqual([])
    expect(result.calendars.map(calendar => calendar.name)).toEqual(['Work'])
    expect(stub.requestsOf('REPORT').map(request => request.path)).toEqual(['/123/calendars/work/'])
  })

  it('rejects a name matching more than one calendar', async () => {
    const { service } = await fixture({
      stub: {
        calendars: [
          { path: HOME, name: 'Work' },
          { path: WORK, name: 'Work' },
        ],
      },
    })
    const error = await caught(() => service.listEvents({ start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z', calendars: ['Work'] }))
    expect(error.code).toBe('CALENDAR_UNKNOWN_CALENDAR')
    expect(error.message).toContain(HOME)
    expect(error.message).toContain(WORK)
  })

  it('rejects an unknown calendar and names the available ones', async () => {
    const { service } = await fixture()
    const error = await caught(() => service.listEvents({ start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z', calendars: ['Nope'] }))
    expect(error.code).toBe('CALENDAR_UNKNOWN_CALENDAR')
    expect(error.message).toContain('Home')
  })

  it('honours a configured allowlist', async () => {
    const { service } = await fixture({ config: { calendars: ['Work'] } })
    const result = await service.listEvents({ start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z' })
    expect(result.calendars.map(calendar => calendar.name)).toEqual(['Work'])
    const error = await caught(() => service.listEvents({ start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z', calendars: ['Home'] }))
    expect(error.code).toBe('CALENDAR_UNKNOWN_CALENDAR')
  })

  it('rejects an inverted, unparsable, or oversized window before any request', async () => {
    const { service, stub } = await fixture()
    const inverted = await caught(() => service.listEvents({ start: '2026-01-06T00:00:00Z', end: '2026-01-05T00:00:00Z' }))
    expect(inverted.code).toBe('CALENDAR_INVALID_INPUT')
    const unparsable = await caught(() => service.listEvents({ start: 'yesterday', end: '2026-01-05T00:00:00Z' }))
    expect(unparsable.code).toBe('CALENDAR_INVALID_INPUT')
    const oversized = await caught(() => service.listEvents({ start: '2026-01-01T00:00:00Z', end: '2028-01-01T00:00:00Z' }))
    expect(oversized.code).toBe('CALENDAR_INVALID_INPUT')
    expect(stub.requests).toHaveLength(0)
  })

  it('rejects a non-positive limit', async () => {
    const { service } = await fixture()
    const error = await caught(() => service.listEvents({ start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z', limit: 0 }))
    expect(error.code).toBe('CALENDAR_INVALID_INPUT')
  })
})

describe('credentials', () => {
  it('reports missing configuration without opening a connection', async () => {
    const { service, stub } = await fixture({ password: null })
    const error = await caught(() => service.listEvents({ start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z' }))
    expect(error.code).toBe('CALENDAR_NOT_CONFIGURED')
    expect(error.message).toContain('ICLOUD_APP_PASSWORD')
    expect(stub.requests).toHaveLength(0)
    expect(service.status().configuration).toEqual({
      configured: false,
      account: 'me@example.com',
      passwordEnv: 'ICLOUD_APP_PASSWORD',
      passwordPresent: false,
      serverUrl: stub.url,
      calendars: [],
    })
  })

  it('classifies a rejected password without leaking it', async () => {
    const { service } = await fixture({ credentials: { username: 'me@example.com', password: 'app-pass' }, password: 'wrong-pass' })
    const error = await caught(() => service.listCalendars())
    expect(error.code).toBe('CALENDAR_AUTH_FAILED')
    expect(error.message).not.toContain('wrong-pass')
    expect(error.message).not.toContain('app-pass')
    expect(service.status().connected).toBe(false)
  })

  it('recovers on the next call once the password is corrected', async () => {
    const { service } = await fixture({ password: 'wrong-pass' })
    expect((await caught(() => service.listCalendars())).code).toBe('CALENDAR_AUTH_FAILED')
    vi.stubEnv('ICLOUD_APP_PASSWORD', 'app-pass')
    expect((await service.listCalendars()).map(calendar => calendar.name)).toEqual(['Home', 'Work'])
    expect(service.status().lastError).toBeNull()
  })

  it('never returns the password from status', async () => {
    const { service } = await fixture()
    expect(JSON.stringify(service.status())).not.toContain('app-pass')
  })

  it('aborts a hung request through the deadline', async () => {
    const { service } = await fixture({ config: { timeoutMs: 300 }, stub: { failMode: 'hang' } })
    const error = await caught(() => service.listCalendars())
    expect(error.code).toBe('CALENDAR_ABORTED')
  })

  it('maps a server error to an upstream failure', async () => {
    const { service } = await fixture({ stub: { failMode: 'server-error' } })
    const error = await caught(() => service.listCalendars())
    expect(error.code).toBe('CALENDAR_UPSTREAM_FAILED')
  })
})

describe('event creation', () => {
  it('writes a timed event as UTC instants that reparse to the requested offset', async () => {
    const { service, stub } = await fixture()
    const created = await service.createEvent({
      calendar: 'Home',
      summary: 'Design review',
      start: '2026-01-05T09:00:00+08:00',
      end: '2026-01-05T10:00:00+08:00',
      location: 'Room 3',
      description: 'Agenda in the doc',
    })
    expect(created.allDay).toBe(false)
    expect(created.uid).toMatch(/@moziforge\.calendar$/)
    expect(created.url).toBe(`${new URL(stub.url).origin}${HOME}${created.uid}.ics`)
    expect(created.start).toBe('2026-01-05T01:00:00.000Z')
    expect(created.end).toBe('2026-01-05T02:00:00.000Z')
    expect(stub.puts).toHaveLength(1)
    const written = new ICAL.Event(new ICAL.Component(ICAL.parse(stub.puts[0]!.body)).getFirstSubcomponent('vevent')!)
    expect(written.uid).toBe(created.uid)
    expect(written.summary).toBe('Design review')
    expect(written.location).toBe('Room 3')
    expect(written.description).toBe('Agenda in the doc')
    expect(new Date(written.startDate.toUnixTime() * 1000).toISOString()).toBe('2026-01-05T01:00:00.000Z')
    expect(new Date(written.endDate.toUnixTime() * 1000).toISOString()).toBe('2026-01-05T02:00:00.000Z')
  })

  it('writes an all-day event as a floating calendar date', async () => {
    const { service, stub } = await fixture()
    const created = await service.createEvent({ calendar: 'Work', summary: 'Launch day', start: '2026-01-05', end: '2026-01-06' })
    expect(created.allDay).toBe(true)
    expect(created.start).toBe('2026-01-05')
    expect(created.end).toBe('2026-01-06')
    const vevent = new ICAL.Component(ICAL.parse(stub.puts[0]!.body)).getFirstSubcomponent('vevent')!
    const written = new ICAL.Event(vevent)
    expect(written.startDate.isDate).toBe(true)
    expect(vevent.getFirstProperty('dtstart')!.toICALString()).toContain('VALUE=DATE')
  })

  it('rejects a timestamp without an explicit offset', async () => {
    const { service, stub } = await fixture()
    const error = await caught(() => service.createEvent({ calendar: 'Home', summary: 'No offset', start: '2026-01-05T09:00:00', end: '2026-01-05T10:00:00' }))
    expect(error.code).toBe('CALENDAR_INVALID_INPUT')
    expect(error.message).toContain('host time zone')
    expect(stub.puts).toHaveLength(0)
  })

  it('rejects a mixed all-day and timed pair', async () => {
    const { service } = await fixture()
    const error = await caught(() => service.createEvent({ calendar: 'Home', summary: 'Mixed', start: '2026-01-05', end: '2026-01-05T10:00:00+08:00' }))
    expect(error.code).toBe('CALENDAR_INVALID_INPUT')
  })

  it('rejects an ambiguous target and an empty summary', async () => {
    const { service } = await fixture()
    const ambiguous = await caught(() => service.createEvent({ summary: 'Nowhere', start: '2026-01-05T09:00:00Z', end: '2026-01-05T10:00:00Z' }))
    expect(ambiguous.code).toBe('CALENDAR_INVALID_INPUT')
    expect(ambiguous.message).toContain('exactly one target calendar')
    const blank = await caught(() => service.createEvent({ calendar: 'Home', summary: '   ', start: '2026-01-05T09:00:00Z', end: '2026-01-05T10:00:00Z' }))
    expect(blank.code).toBe('CALENDAR_INVALID_INPUT')
  })

  it('surfaces a rejected write instead of reporting success', async () => {
    const { service } = await fixture({ stub: { putStatus: 412 } })
    const error = await caught(() => service.createEvent({ calendar: 'Home', summary: 'Conflict', start: '2026-01-05T09:00:00Z', end: '2026-01-05T10:00:00Z' }))
    expect(error.code).toBe('CALENDAR_UPSTREAM_FAILED')
    expect(error.message).toContain('412')
  })
})

describe('status', () => {
  it('reports a configured, connected service after a successful call', async () => {
    const { service, stub } = await fixture()
    await service.listCalendars()
    const status = service.status()
    expect(status.connected).toBe(true)
    expect(status.calendarCount).toBe(2)
    expect(status.configuration.configured).toBe(true)
    expect(status.configuration.passwordPresent).toBe(true)
    expect(status.configuration.serverUrl).toBe(stub.url)
  })
})
