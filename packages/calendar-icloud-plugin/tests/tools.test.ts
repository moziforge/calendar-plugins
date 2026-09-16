/**
 * Purpose: Verify the model-facing tool surface through a real Harness tool
 * registry, so both the schema the model receives and the validated dispatch
 * path are exercised rather than assumed.
 *
 * High-level flow: mount the real `ToolRuntime`, the calendar service pointed at
 * the CalDAV fixture, and the tools plugin; then read `ctx.tools.schemas()` for
 * the model-visible contract and dispatch calls through `ctx.tools.execute`.
 *
 * Important behavior asserted here:
 * - The registry publishes exactly the four calendar tools, and the published
 *   `parameters` JSON Schema carries the declared types, requiredness, and array
 *   element types.
 * - Argument validation happens in the registry, so a schema violation never
 *   reaches the service: the wrongly typed case opens no socket at all.
 * - A schema violation is reported as an error result naming the offending path,
 *   which is what lets a model correct itself instead of retrying blindly.
 * - A well-formed call reaches the service and returns its value as the canonical
 *   tool value, and a domain failure surfaces as an error result whose message
 *   explains the fix.
 *
 * Example:
 * Input: `execute({ name: 'calendar_list_events', arguments: { start:
 *   '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z' } })` against the fixture.
 * Process: the registry validates both required strings, then dispatches to the
 *   service, which queries the fixture.
 * Result: `isError: false` with `value.total === 1`.
 *
 * Architectural boundaries:
 * - Test only. It asserts the published contract; it does not reimplement schema
 *   validation or reach into service internals.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CalendarService from '../src/host.js'
import * as calendarTools from '../src/tools.js'
import { startCaldavStub, type StubServer } from './caldav-stub.js'

const HOME = '/123/calendars/home/'

const contexts: Context[] = []
const stubs: StubServer[] = []

afterEach(async () => {
  for (const context of contexts.splice(0)) await context.fiber.dispose()
  for (const stub of stubs.splice(0)) await stub.close()
  vi.unstubAllEnvs()
})

const EVENT = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//stub//EN',
  'BEGIN:VEVENT',
  'UID:standup-1',
  'DTSTART:20260105T090000Z',
  'DTEND:20260105T093000Z',
  'RRULE:FREQ=DAILY;COUNT=5',
  'SUMMARY:Standup',
  'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n')

/**
 * Minimal stand-in for the prompt service the tool registry injects.
 *
 * The registry declares `inject = ['systemPrompt']` and, in its default native
 * mode, only registers one prompt callback through `tools()`. Supplying that one
 * method is enough to mount the real registry, so the test exercises the real
 * validation and dispatch path without standing up the whole prompt subsystem.
 * The registry's own schema wiring is never invoked because no model request is
 * assembled here.
 */
class SystemPromptStub extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  tools(_callback: unknown): void {}
}

/**
 * Mounts the registry, the service, and the tools against a fresh fixture.
 *
 * External calls and effects: binds a loopback port and sets a stubbed
 * environment variable; teardown disposes the context and closes the stub.
 *
 * @returns the context, its tool registry, and the fixture.
 */
async function fixture() {
  const stub = await startCaldavStub({
    account: { username: 'me@example.com', password: 'app-pass' },
    calendars: [{ path: HOME, name: 'Home' }],
    objects: { [HOME]: [{ path: 'standup.ics', ics: EVENT }] },
  })
  stubs.push(stub)
  vi.stubEnv('ICLOUD_APP_PASSWORD', 'app-pass')
  const context = new Context()
  contexts.push(context)
  await context.plugin(SystemPromptStub)
  await context.plugin(ToolRuntime)
  await context.plugin(CalendarService, { account: 'me@example.com', serverUrl: stub.url, timeoutMs: 5000, calendars: [], passwordEnv: 'ICLOUD_APP_PASSWORD' })
  await context.plugin(calendarTools)
  return { context, tools: context.tools, stub }
}

/** Dispatches one call through the registry with a caller-owned signal. */
async function call(context: Context, name: string, args: unknown) {
  return context.tools.execute({ callId: ToolCallId(`call-${name}`), name, arguments: args, signal: new AbortController().signal })
}

/** Joins the text blocks of a result for message assertions. */
function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('published schema', () => {
  it('publishes exactly the four calendar tools', async () => {
    const { tools } = await fixture()
    expect(tools.schemas().map(schema => schema.name).sort()).toEqual([
      'calendar_create_event',
      'calendar_list_calendars',
      'calendar_list_events',
      'calendar_status',
    ])
  })

  it('declares types, requiredness, and array element types for the query tool', async () => {
    const { tools } = await fixture()
    const schema = tools.schemas().find(entry => entry.name === 'calendar_list_events')!
    expect(schema.parameters).toMatchObject({
      type: 'object',
      properties: {
        start: { type: 'string' },
        end: { type: 'string' },
        calendars: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer' },
      },
    })
    expect(new Set(schema.parameters.required as string[])).toEqual(new Set(['start', 'end']))
    expect(schema.description).toContain('Recurring events are expanded')
  })

  it('describes the exclusive all-day end for event creation', async () => {
    const { tools } = await fixture()
    const schema = tools.schemas().find(entry => entry.name === 'calendar_create_event')!
    expect(schema.description).toContain('exclusive')
    expect(schema.parameters).toMatchObject({
      type: 'object',
      properties: { summary: { type: 'string' }, start: { type: 'string' }, end: { type: 'string' }, calendar: { type: 'string' } },
    })
    expect(new Set(schema.parameters.required as string[])).toEqual(new Set(['summary', 'start', 'end']))
  })
})

describe('dispatch', () => {
  it('runs a valid query and returns the canonical value', async () => {
    const { context } = await fixture()
    const result = await call(context, 'calendar_list_events', { start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z' })
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect((result.value as { total: number }).total).toBe(1)
    expect(textOf(result)).toContain('Standup')
  })

  it('rejects a wrongly typed argument before the service opens a socket', async () => {
    const { context, stub } = await fixture()
    const result = await call(context, 'calendar_list_events', { start: '2026-01-05T00:00:00Z', end: '2026-01-06T00:00:00Z', limit: 'many' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('limit')
    expect(stub.requests).toHaveLength(0)
  })

  it('rejects a missing required argument', async () => {
    const { context, stub } = await fixture()
    const result = await call(context, 'calendar_list_events', { end: '2026-01-06T00:00:00Z' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('start')
    expect(stub.requests).toHaveLength(0)
  })

  it('reports configuration through the status tool without leaking the password', async () => {
    const { context } = await fixture()
    const result = await call(context, 'calendar_status', {})
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect((result.value as { configuration: { configured: boolean } }).configuration.configured).toBe(true)
    expect(textOf(result)).not.toContain('app-pass')
  })

  it('lists calendars through the registry', async () => {
    const { context } = await fixture()
    const result = await call(context, 'calendar_list_calendars', {})
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect((result.value as Array<{ name: string }>).map(calendar => calendar.name)).toEqual(['Home'])
  })

  it('creates an event and reports its UTC instant', async () => {
    const { context, stub } = await fixture()
    const result = await call(context, 'calendar_create_event', { calendar: 'Home', summary: 'Design review', start: '2026-01-05T09:00:00+08:00', end: '2026-01-05T10:00:00+08:00' })
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect((result.value as { start: string }).start).toBe('2026-01-05T01:00:00.000Z')
    expect(stub.puts).toHaveLength(1)
  })

  it('surfaces a domain failure as an error result explaining the fix', async () => {
    const { context } = await fixture()
    const result = await call(context, 'calendar_list_events', { start: '2026-01-06T00:00:00Z', end: '2026-01-05T00:00:00Z' })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toContain('must be after start')
  })
})
