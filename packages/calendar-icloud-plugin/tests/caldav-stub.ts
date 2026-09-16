/**
 * Purpose: Provide an in-process CalDAV fixture so the plugin can be exercised
 * end to end without an Apple ID, a network, or any real credential.
 *
 * High-level flow:
 * 1. `startCaldavStub` binds a loopback HTTP server that speaks the subset of
 *    DAV that the client library actually uses: the `/.well-known/caldav`
 *    redirect, `current-user-principal`, `calendar-home-set`, a Depth-1 calendar
 *    listing, per-collection `supported-report-set`, the `calendar-query` REPORT
 *    that returns event resources, and the PUT that creates one.
 * 2. Every route requires HTTP Basic authentication, so a wrong password
 *    produces the real 401 that the plugin must classify as an auth failure.
 * 3. The fixture records every request and every accepted PUT body, so tests
 *    assert on observed protocol traffic and on the bytes actually written
 *    rather than on internal client state.
 *
 * Important behavior:
 * - Responses mirror the dialect the client parses: DAV namespace prefixes are
 *   stripped by the library, so element names such as `d:current-user-principal`
 *   become `currentUserPrincipal`, and property values are read from `propstat`
 *   entries whose status is 2xx.
 * - `failMode` selects one deterministic abnormal behaviour at a time —
 *   `unauthorized` answers 401 everywhere, `server-error` answers 500 to every
 *   DAV request, and `hang` accepts the connection and never responds so the
 *   deadline path can be observed.
 *
 * Example:
 * Input: `startCaldavStub({ account: { username: 'me@example.com', password:
 *   'app-pass' }, calendars: [{ path: '/123/calendars/home/', name: 'Home' }],
 *   objects: { '/123/calendars/home/': [{ path: 'standup.ics', ics: VCALENDAR }] } })`.
 * Process: the plugin connects with those credentials, discovers the home,
 *   lists `Home`, and REPORTs the collection.
 * Result: `stub.requests` shows PROPFIND, PROPFIND, PROPFIND, PROPFIND, REPORT in
 *   that order, and `stub.objectsFor('/123/calendars/home/')` returns the seeded
 *   `standup.ics`.
 *
 * Architectural boundaries:
 * - Test fixture only; never imported by `src/`. It models protocol behaviour,
 *   not iCloud semantics: it does not expand recurrences or filter by time range,
 *   because those are the plugin's responsibilities under test.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'

/** One seeded calendar collection. */
export interface StubCalendar {
  /** Absolute path, for example `/123/calendars/home/`. */
  path: string
  name: string
  description?: string
  color?: string
  /** Default VTIMEZONE body; when set, a `TZID` is advertised. */
  timeZoneId?: string
}

/** One seeded calendar object resource. */
export interface StubObject {
  /** Resource file name, for example `standup.ics`. */
  path: string
  /** Raw iCalendar text. */
  ics: string
}

/** Abnormal behaviour the fixture should simulate. */
export type StubFailMode = 'none' | 'unauthorized' | 'server-error' | 'hang'

export interface StubOptions {
  account: { username: string; password: string }
  calendars?: StubCalendar[]
  /** Seeded resources keyed by owning calendar path. */
  objects?: Record<string, StubObject[]>
  /** Principle directory used in generated hrefs; defaults to `/123/`. */
  principalPath?: string
  failMode?: StubFailMode
  /** Status returned by PUT; defaults to 201. */
  putStatus?: number
}

/** One observed request, sufficient to assert protocol order and shape. */
export interface StubRequest {
  method: string
  path: string
  depth: string | null
  authorized: boolean
}

export interface StubServer {
  /** Origin the client should be pointed at, for example `http://127.0.0.1:PORT/`. */
  url: string
  requests: StubRequest[]
  /** Bodies accepted by PUT, in arrival order. */
  puts: Array<{ path: string; body: string }>
  /** Seeded resources for one collection path. */
  objectsFor(calendarPath: string): StubObject[]
  /** Requests whose method matches, in arrival order. */
  requestsOf(method: string): StubRequest[]
  close(): Promise<void>
}

/**
 * Starts the fixture and returns handles a test needs.
 *
 * External calls and effects: binds a loopback TCP port and holds open sockets
 * until `close` runs. Tests must call `close` in teardown so `vitest` can exit.
 *
 * @param options - account credentials, seeded calendars, seeded objects, failure mode.
 * @returns the running fixture.
 */
export async function startCaldavStub(options: StubOptions): Promise<StubServer> {
  const principalPath = normalizePath(options.principalPath ?? '/123/')
  const principalUrl = `${principalPath}principal/`
  const homeUrl = `${principalPath}calendars/`
  const calendars = options.calendars ?? [{ path: `${homeUrl}home/`, name: 'Home' }]
  const objects = options.objects ?? {}
  const failMode = options.failMode ?? 'none'
  const requests: StubRequest[] = []
  const puts: Array<{ path: string; body: string }> = []
  const expectedAuthorization = `Basic ${Buffer.from(`${options.account.username}:${options.account.password}`).toString('base64')}`
  const hanging: ServerResponse[] = []

  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    const authorized = request.headers.authorization === expectedAuthorization
    requests.push({ method: request.method ?? '', path, depth: header(request, 'depth'), authorized })
    if (failMode === 'hang') {
      hanging.push(response)
      return
    }
    void collect(request).then(body => {
      if (failMode === 'unauthorized' || !authorized) {
        response.writeHead(401, { 'www-authenticate': 'Basic realm="stub"' }).end()
        return
      }
      if (failMode === 'server-error') {
        response.writeHead(500).end('stub failure')
        return
      }
      handle(request.method ?? '', path, body, response)
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const origin = `http://127.0.0.1:${port}`

  /** Routes one authenticated request to its canned DAV response. */
  function handle(method: string, path: string, body: string, response: ServerResponse): void {
    if (method === 'PROPFIND' && path === '/.well-known/caldav') {
      response.writeHead(301, { location: '/' }).end()
      return
    }
    if (method === 'PROPFIND' && path === '/') {
      xml(response, 207, multistatus(principalResponse('/', principalUrl)))
      return
    }
    if (method === 'PROPFIND' && path === principalUrl) {
      xml(response, 207, multistatus(`<d:response><d:href>${escapeXml(principalUrl)}</d:href><d:propstat><d:prop><c:calendar-home-set><d:href>${escapeXml(homeUrl)}</d:href></c:calendar-home-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`))
      return
    }
    if (method === 'PROPFIND' && path === homeUrl) {
      xml(response, 207, multistatus(calendars.map(collectionResponse).join('')))
      return
    }
    if (method === 'PROPFIND' && calendars.some(calendar => calendar.path === path)) {
      xml(response, 207, multistatus(`<d:response><d:href>${escapeXml(path)}</d:href><d:propstat><d:prop><d:supported-report-set><d:supported-report><d:report><c:calendar-query/></d:report></d:supported-report></d:supported-report-set></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`))
      return
    }
    if (method === 'REPORT' && calendars.some(calendar => calendar.path === path)) {
      const entries = objects[path] ?? []
      xml(response, 207, multistatus(entries.map(entry => objectResponse(path, entry)).join('')))
      return
    }
    if (method === 'PUT') {
      puts.push({ path, body })
      response.writeHead(options.putStatus ?? 201).end()
      return
    }
    response.writeHead(404).end('stub: unrouted request')
  }

  return {
    url: `${origin}/`,
    requests,
    puts,
    objectsFor: calendarPath => [...(objects[calendarPath] ?? [])],
    requestsOf: method => requests.filter(request => request.method === method),
    async close() {
      for (const response of hanging.splice(0)) response.destroy()
      await new Promise<void>(resolve => {
        server.closeAllConnections()
        server.close(() => resolve())
      })
    },
  }
}

/** Renders one calendar collection entry for the Depth-1 home listing. */
function collectionResponse(calendar: StubCalendar): string {
  const timezone = calendar.timeZoneId
    ? `<c:calendar-timezone>${escapeXml(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VTIMEZONE\r\nTZID:${calendar.timeZoneId}\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0800\r\nTZOFFSETTO:+0800\r\nTZNAME:CST\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nEND:VCALENDAR\r\n`)}</c:calendar-timezone>`
    : ''
  const description = calendar.description ? `<c:calendar-description>${escapeXml(calendar.description)}</c:calendar-description>` : ''
  const color = calendar.color ? `<ca:calendar-color>${escapeXml(calendar.color)}</ca:calendar-color>` : ''
  return `<d:response><d:href>${escapeXml(calendar.path)}</d:href><d:propstat><d:prop>`
    + `<d:displayname>${escapeXml(calendar.name)}</d:displayname>`
    + `<d:resourcetype><d:collection/><c:calendar/></d:resourcetype>`
    + description + color + timezone
    + `<cs:getctag>ctag-1</cs:getctag>`
    + `<c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>`
    + `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
}

/** Renders one calendar object entry for a calendar-query REPORT. */
function objectResponse(calendarPath: string, object: StubObject): string {
  const href = `${calendarPath}${object.path}`
  return `<d:response><d:href>${escapeXml(href)}</d:href><d:propstat><d:prop>`
    + `<d:getetag>"${escapeXml(object.path)}-etag"</d:getetag>`
    + `<c:calendar-data>${escapeXml(object.ics)}</c:calendar-data>`
    + `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
}

/** Renders the current-user-principal discovery response. */
function principalResponse(href: string, principalUrl: string): string {
  return `<d:response><d:href>${escapeXml(href)}</d:href><d:propstat><d:prop>`
    + `<d:current-user-principal><d:href>${escapeXml(principalUrl)}</d:href></d:current-user-principal>`
    + `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
}

/** Wraps response elements in a namespaced DAV multistatus document. */
function multistatus(body: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n`
    + `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ca="http://apple.com/ns/ical/">`
    + body
    + `</d:multistatus>`
}

/** Sends one XML response with an explicit status code. */
function xml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'content-type': 'application/xml; charset=utf-8' }).end(body)
}

/** Reads one header case-insensitively. */
function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name]
  return typeof value === 'string' ? value : null
}

/** Buffers a request body, which PUT needs and other methods ignore. */
async function collect(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** Ensures a path has a leading slash and no trailing spaces. */
function normalizePath(path: string): string {
  const trimmed = path.trim()
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

/** Escapes the five XML metacharacters so seeded iCalendar text stays valid XML. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
