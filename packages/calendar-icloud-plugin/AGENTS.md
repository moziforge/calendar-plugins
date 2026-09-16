# Module rules

Inherit [repository rules](../../AGENTS.md). Responsibility, entry points, and the
behavior contract are in [README.md](README.md).

## Boundaries

- `types.ts` — vocabulary only, no imports. Keep it dependency-free.
- `errors.ts` — error codes and classification only. All library message
  inspection lives in `toCalendarError`; nothing else may pattern-match on
  dependency text.
- `config.ts` — configuration and credential resolution. The password is read
  from the environment here and nowhere else.
- `client.ts` — HTTP and DAV only. No iCalendar semantics, no caching.
- `ical.ts` — parsing, expansion, normalization. No network.
- `host.ts` — orchestration, caching, validation, iCalendar serialization for
  writes. Registers no tools.
- `tools.ts` — schemas and delegation only. No provider logic.

## Rules

- Keep the four tool descriptions aligned with the README tool table and with the
  schemas in the same change.
- Any new code path that touches the password needs a test asserting the password
  does not appear in an error message, in `status()`, or in tool output.
- State measured request counts in the comment that owns the call and assert them
  in `tests/host.test.ts`; a claim of "one request" that is not asserted will drift.
- Extend `tests/caldav-stub.ts` rather than mocking the client. The fixture is the
  only place protocol dialect is encoded.
- When a tool's parameters change, update `tools.ts`, the README table, and the
  schema assertions in `tests/tools.test.ts` together.

## Verification

```sh
pnpm run typecheck
pnpm run lint
pnpm run test:unit
```
