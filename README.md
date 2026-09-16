# calendar-plugins

[DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) plugins that connect agents
to calendar providers.

Each package integrates one provider and exposes it to a DSH profile as a cordis
service plus model-facing tools. Providers share the normalized event vocabulary
declared in [`types.ts`](packages/calendar-icloud-plugin/src/types.ts), so an
agent sees the same event shape no matter which provider answered.

| Package | Provider | Status |
| --- | --- | --- |
| [`@moziforge/calendar-icloud-plugin`](packages/calendar-icloud-plugin/README.md) | Apple iCloud Calendar via CalDAV | implemented |

## What you get

Four tools an agent can call:

| Tool | Purpose |
| --- | --- |
| `calendar_status` | Report whether access is configured and reachable. Never returns a secret. |
| `calendar_list_calendars` | List calendars with id, name, default zone, color, components. |
| `calendar_list_events` | List occurrences in a window, with recurring series expanded. |
| `calendar_create_event` | Create one event in one calendar. |

Recurring events are expanded into one entry per occurrence, cancelled
occurrences disappear, all-day values stay date-only, and timed events report a
UTC instant plus the event's own IANA zone. See the
[package README](packages/calendar-icloud-plugin/README.md) for the full behavior
contract.

## Requirements

- Node.js `^22.19.0 || >=24.0.0`
- pnpm 12 to build from source
- A DSH installation to mount the plugins into
- For iCloud: an Apple ID with two-factor authentication and an **app-specific
  password**

## Build

```sh
git clone https://github.com/moziforge/calendar-plugins.git
cd calendar-plugins
pnpm install
pnpm build
```

`pnpm build` compiles each package into its own `dist/`. DSH loads the compiled
JavaScript, so a profile must point at a built checkout.

## iCloud credentials

CalDAV is the only programmatic route into iCloud Calendar; there is no public
REST API. Apple requires a separate secret for third-party clients, because the
Apple ID password is refused once two-factor authentication is on:

1. Sign in at <https://appleid.apple.com>.
2. Open **Sign-In and Security → App-Specific Passwords**.
3. Generate one and copy the `abcd-efgh-ijkl-mnop` value — it is shown once.
4. Make it available to the process that runs DSH:

   ```sh
   export ICLOUD_ACCOUNT="you@example.com"
   export ICLOUD_APP_PASSWORD="abcd-efgh-ijkl-mnop"
   ```

The plugin reads the password from the environment variable you name in its
config — never from a config file, a profile, or a tool argument — so it cannot be
written into a session log. `ICLOUD_ACCOUNT` is the Apple ID email, not a
password.

## Mounting into a DSH profile

Add two rows to your profile (or `--patch` overlay):

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

The two rows are separable on purpose: the `host` row alone gives plugin code
`ctx.calendar` without exposing any calendar tool to a model.

The `name:` field is resolved as a module specifier from the profile directory, so
the package must be resolvable there — install it into that profile's
dependencies, or point `name:` at an absolute path to the built entry file. The
`/host` and `/tools` subpaths are package exports; `/host` can also be omitted,
since the barrel export `.` re-exports the same service.

## Configuration reference

| Field | Default | Meaning |
| --- | --- | --- |
| `account` | `''` | Apple ID; falls back to the `ICLOUD_ACCOUNT` environment variable. |
| `passwordEnv` | `ICLOUD_APP_PASSWORD` | Name of the variable holding the app-specific password. |
| `serverUrl` | `https://caldav.icloud.com/` | CalDAV entry point; `ICLOUD_CALDAV_SERVER_URL` overrides. |
| `calendars` | `[]` | Allowlist of calendar names or ids; empty exposes every calendar. |
| `timeoutMs` | `20000` | Per-request deadline. |

## Troubleshooting

- **`CALENDAR_NOT_CONFIGURED`** — the account or password variable is missing. The
  environment is read when a request runs, but it is fixed when the process
  starts, so export the variables (or reload your `.env`) and restart DSH.
- **`CALENDAR_AUTH_FAILED`** — iCloud rejected the credentials. Use the
  app-specific password, not the Apple ID password, and confirm the account
  address matches the one you sign in with.
- **No calendars found** — confirm Calendar is enabled for the Apple ID and that
  the account owns at least one calendar.
- **A calendar is rejected as unsupported** — iCloud publishes a Reminders list as
  a CalDAV collection that accepts only `VTODO`. It holds no events, so it is
  skipped by broad reads and rejected when named explicitly.

## Verification

```sh
pnpm install
pnpm run typecheck
pnpm run lint
pnpm test
```

Tests are black-box: they drive the service and the real tool registry against an
in-process CalDAV fixture, so they need no Apple ID and no network access.

## License

Apache-2.0. See [LICENSE](LICENSE).
