# calendar-plugins

Private calendar plugin family for Mozi agents.

This repository owns **calendar** as a capability class. Each package inside it
integrates one calendar provider and exposes it to a Mozi/Harness deployment as a
Host-plane service plus model-facing tools. Provider packages share the
normalized vocabulary declared in [`types.ts`](packages/calendar-icloud-plugin/src/types.ts)
so an agent sees the same event shape no matter which provider answered.

| Package | Provider | Status |
| --- | --- | --- |
| [`@moziforge/calendar-icloud-plugin`](packages/calendar-icloud-plugin/README.md) | Apple iCloud Calendar via CalDAV | implemented |

## Requirements

- Node.js `^22.19.0 || >=24.0.0`
- pnpm 12
- For iCloud: an Apple ID with two-factor authentication and an **app-specific
  password**

## iCloud credentials

CalDAV is the only programmatic route into iCloud Calendar; there is no public
REST API. Apple requires a separate secret for third-party clients, because the
Apple ID password is refused once two-factor authentication is on:

1. Sign in at <https://appleid.apple.com>.
2. Open **Sign-In and Security → App-Specific Passwords**.
3. Generate one and copy the `abcd-efgh-ijkl-mnop` value.
4. Export it where the agent runs:

   ```sh
   export ICLOUD_ACCOUNT="you@example.com"
   export ICLOUD_APP_PASSWORD="abcd-efgh-ijkl-mnop"
   ```

Never commit those values. Only `.env.example` is tracked, and the plugin reads
the password from the environment — never from a config file, a preset, or a tool
argument — so it cannot be written into a session log.

## Mounting into a deployment

A Host-plane preset mounts the service and the tools as two rows, mirroring how
`human-request-plugin` and `sleep-loop-plugin` are composed:

```yaml
- insert:
    - id: calendar-icloud-host
      name: '@moziforge/calendar-icloud-plugin/host'
      config:
        account: you@example.com
        # Optional: restrict every read and write to these calendars.
        calendars: [Home, Work]

    - id: calendar-icloud-tools
      name: '@moziforge/calendar-icloud-plugin/tools'
```

The two rows are separable on purpose: a deployment can mount the service for
plugin code to use without exposing any calendar tool to a model.

## Tools

| Tool | Purpose |
| --- | --- |
| `calendar_status` | Report whether access is configured and reachable. Never returns a secret. |
| `calendar_list_calendars` | List calendars with id, name, default zone, color, components. |
| `calendar_list_events` | List occurrences in a window, with recurring series expanded. |
| `calendar_create_event` | Create one event in one calendar. |

## Semantics worth knowing

- **Instants.** Timed events report UTC ISO-8601 values plus the event's own IANA
  zone in `timeZone`. All-day events report date-only `YYYY-MM-DD` values with an
  exclusive `end`, matching RFC 5545 DTEND.
- **Recurrence.** Series are expanded client-side with `ical.js`, so RRULE, RDATE,
  and EXDATE are applied together, per-occurrence overrides replace the master,
  and individually cancelled occurrences disappear.
- **Rate limits.** A query costs exactly one `calendar-query` REPORT per calendar,
  and a calendar listing is cached for five minutes. The client never retries
  automatically; iCloud rate-limits CalDAV, and a surfaced failure is safer than
  an unobserved retry storm.
- **Allowlist.** A configured `calendars` list is a hard boundary: naming a
  calendar outside it fails instead of silently reading a different one.

## Verification

```sh
pnpm install
pnpm run typecheck
pnpm run lint
pnpm test
```

Tests are black-box: they drive the service and the real tool registry against an
in-process CalDAV fixture, so they need no Apple ID and no network access. A live
iCloud round trip is deliberately not part of the suite, because it would require
committing a credential to CI.

## Documentation rules

Every package provides a `README.md` (responsibility, entry points, usage,
dependencies, verification) and an `AGENTS.md` (module-specific development
rules). See [`AGENTS.md`](AGENTS.md).
