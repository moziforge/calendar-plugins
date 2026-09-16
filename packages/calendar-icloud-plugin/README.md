# @moziforge/calendar-icloud-plugin

A DSH plugin that reads and writes Apple iCloud Calendar over CalDAV.

## Responsibility

- Own the CalDAV transport to iCloud, including the `/.well-known/caldav`
  discovery handshake.
- Normalize iCloud's iCalendar payloads — recurring series, time zones, all-day
  values, cancellations — into one event shape.
- Provide a cordis service (`ctx.calendar`) and, separately, four model-facing
  tools.
- Hold the credential boundary: the app-specific password is read from the
  environment and never returned, logged, or embedded in an error.

It does **not** own prompt text, caching across processes, or any calendar
provider other than iCloud.

## Entry points

| Export | Module | Purpose |
| --- | --- | --- |
| `default`, `CalendarService`, `Config`, `name` | `./host` | The `ctx.calendar` service plugin. |
| `apply`, `name` | `./tools` | Registers the four calendar tools; injects `tools` and `calendar`. |
| `ICloudCalendarClient` | `./client` | The CalDAV session, if you need transport directly. |
| `parseCalendarObject`, `sortEvents`, `instantString` | `./ical` | iCalendar parsing and expansion. |
| everything | `.` | Barrel re-export of the above plus the shared types. |

## Usage

```yaml
- insert:
    - id: calendar-icloud-host
      name: '@moziforge/calendar-icloud-plugin/host'
      config:
        account: you@example.com
        calendars: [Home, Work]   # optional allowlist
        timeoutMs: 20000          # optional
    - id: calendar-icloud-tools
      name: '@moziforge/calendar-icloud-plugin/tools'
```

### Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `account` | `''` | Apple ID; falls back to `ICLOUD_ACCOUNT`. |
| `passwordEnv` | `ICLOUD_APP_PASSWORD` | Name of the variable holding the app-specific password. |
| `serverUrl` | `https://caldav.icloud.com/` | CalDAV entry point; `ICLOUD_CALDAV_SERVER_URL` overrides. |
| `calendars` | `[]` | Allowlist of names or ids; empty exposes every calendar. |
| `timeoutMs` | `20000` | Per-request deadline. |

### Service API

```ts
ctx.calendar.status(): CalendarStatus
ctx.calendar.listCalendars(signal?): Promise<CalendarSummary[]>
ctx.calendar.listEvents({ start, end, calendars?, limit? }, signal?): Promise<ListEventsResult>
ctx.calendar.createEvent({ summary, start, end, calendar?, location?, description? }, signal?): Promise<CreatedEvent>
```

### Tools

| Tool | Parameters | Returns |
| --- | --- | --- |
| `calendar_status` | none | configuration readiness, connection state, cached count, last error |
| `calendar_list_calendars` | none | calendar summaries (cached five minutes) |
| `calendar_list_events` | `start`, `end` required; `calendars`, `limit` optional | window, calendars, events, `total`, `truncatedSeries` |
| `calendar_create_event` | `summary`, `start`, `end` required; `calendar`, `location`, `description` optional | created uid, calendar, URL, start, end, `allDay` |

## Behavior contract

- **Times.** Timed events are UTC ISO-8601 instants plus the event's IANA zone in
  `timeZone`. All-day events are date-only with an exclusive `end`. Comparisons
  use `ICAL.Time.toUnixTime()`, so results never depend on the host time zone.
- **Recurrence.** Expanded client-side: RRULE, RDATE, and EXDATE together;
  per-occurrence overrides replace the master; individually cancelled occurrences
  are omitted. Expansion is bounded at 10,000 occurrences per series and reports
  `truncatedSeries` rather than silently returning nothing.
- **Zones.** A `TZID` resolves against the VTIMEZONE in the same resource, which
  is what iCloud sends. A resource missing its VTIMEZONE falls back to treating
  the wall clock as UTC; the original `TZID` still appears in `timeZone`, so the
  discrepancy is visible.
- **Windows.** Both bounds are required, `end` must be after `start`, and a window
  longer than 366 days is rejected. Validation precedes every network call.
- **Errors.** Stable codes: `CALENDAR_NOT_CONFIGURED`, `CALENDAR_AUTH_FAILED`,
  `CALENDAR_UNKNOWN_CALENDAR`, `CALENDAR_INVALID_INPUT`, `CALENDAR_UPSTREAM_FAILED`,
  `CALENDAR_ABORTED`. A missing or wrong credential is never cached, so fixing the
  environment recovers on the next call without remounting.
- **Requests.** One `calendar-query` REPORT per calendar per query; a listing is
  cached for five minutes. No automatic retries.
- **Reminders lists.** iCloud publishes a Reminders list as a CalDAV collection
  that accepts only `VTODO`. It is listed, so its `components` are visible, but it
  is skipped by a broad read rather than spending a rate-limited request, and
  naming it explicitly for reading or writing is rejected with that reason.
- **Writes.** `createEvent` requires exactly one target calendar that accepts
  `VEVENT` and a fresh UUID-based UID, so a write can never overwrite an existing
  event or land in a collection that cannot hold it. Timed events are stored as
  UTC; all-day events as floating `VALUE=DATE`.

## Dependencies

- `tsdav` — DAV discovery and request construction.
- `ical.js` — iCalendar parsing, recurrence expansion, time arithmetic.
- `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/schemastery`,
  `@deepseek-ai/dsh-util-values` — plugin, tool, and config surfaces.

## Verification

```sh
pnpm --dir ../.. install
pnpm run typecheck
pnpm run lint
pnpm run test:unit
```

53 tests across three black-box suites:

- `tests/ical.test.ts` — expansion, zones, all-day, window boundaries, degenerate
  resources, ordering.
- `tests/host.test.ts` — discovery, caching, request counts, credentials, limits,
  creation, and status against the in-process CalDAV fixture.
- `tests/tools.test.ts` — the published schema and the real dispatch path through
  `ToolRuntime`.

A live iCloud round trip is intentionally not automated: it would require a real
app-specific password in CI. Verify manually by exporting credentials and calling
`calendar_status` followed by `calendar_list_events`.

## Known limitations

- Writes require an explicit end; zero-duration events and reminders are not
  supported.
- Timed events are stored in UTC rather than with a `VTIMEZONE`, because ical.js
  ships no IANA database. The instant is exact; the stored zone name is not.
- Only iCloud is implemented; the shared vocabulary is provider-neutral, but no
  second provider exercises it yet.

## License

Apache-2.0. See the [repository LICENSE](../../LICENSE).
