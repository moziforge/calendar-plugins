# Security policy

## Reporting a vulnerability

Open a [private security advisory](https://github.com/moziforge/calendar-plugins/security/advisories/new)
rather than a public issue. Please include the affected package, a reproduction,
and the impact you believe it has.

## Credential model

These plugins authenticate to a calendar provider with a **long-lived app-specific
password** stored in an environment variable. Treat it as a full-access secret:

- It grants access to the entire iCloud Calendar account. CalDAV has no
  per-calendar permission, so an allowlist in the plugin config restricts what the
  agent *does*, not what the credential *can*.
- It is read from the environment at request time and is never returned by the
  plugin, written to a log, or embedded in an error message. A missing credential
  is reported by variable name only.
- Revoke it at <https://appleid.apple.com> if it is ever exposed. Revocation takes
  effect immediately and does not affect your other sessions.
- Enable two-factor authentication on the Apple ID. App-specific passwords require
  it, and without it the account password itself becomes usable over CalDAV.

Do not commit credentials, paste them into an agent conversation, or pass them as
tool arguments. The plugins read them from the environment only, and that is
deliberate: it keeps them out of profile files and session logs.

## Network behaviour

The plugins talk only to the CalDAV endpoint you configure (`serverUrl`,
defaulting to `https://caldav.icloud.com/`). They perform DAV discovery,
`PROPFIND`, `REPORT`, and — only when an agent calls `calendar_create_event` — one
`PUT`. No telemetry is sent anywhere, and no data is written outside the calendar
account.

## Scope

The example commands in the documentation use placeholder credentials. Test
suites use an in-process fixture and never contact a real account.
