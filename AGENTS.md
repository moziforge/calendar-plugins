# Development rules

This repository owns the **calendar** capability class for Mozi agents. Read each
package's `README.md` and `AGENTS.md` before editing it.

## Structure

- One package per provider, named `@moziforge/calendar-<provider>-plugin`.
- All packages speak the normalized vocabulary; a provider-only field must not
  leak into a tool schema. Extend the shared types deliberately instead.
- The service and the tools are separate exports so a deployment can mount the
  capability without exposing it to a model.

## Secrets and runtime boundaries

- Never read, print, test, or commit a real credential. Only `.env.example` is
  tracked, and tests use fixture credentials only.
- The app-specific password is read from the environment at call time and must
  never be returned, logged, or embedded in an error message. A test asserting
  that a password does not appear in an error or in `status()` is mandatory for
  any code path that handles it.
- A missing credential is a normal state, not a crash: the plugin stays mounted
  and only the calendar tools fail, with a message naming the variable to set.

## Protocol correctness

- Compare times with `ICAL.Time.toUnixTime()`, never `toJSDate()`, which resolves
  floating times in the host zone and would make results machine-dependent.
- Never call `ICAL.Event.iterator(startTime)`. It replaces DTSTART and shifts the
  series time of day; iterate from the series start and bound the walk instead.
- All-day values are calendar dates, not instants. Keep them date-only end to end.
- Reject an ambiguous calendar name, an ambiguous write target, and a timestamp
  without an explicit offset. Guessing is worse than an error here.

## External calls

- Every request carries a deadline; combine the caller's signal with a timeout.
- Do not add automatic retries. iCloud rate-limits CalDAV; document any future
  retry policy together with the observed limits that justify it.
- Keep one round trip per calendar per query. State the measured request count in
  the comment that owns the call, and assert it in a test.

## Testing

- Tests are black-box: public service methods, the real tool registry, observed
  HTTP requests, and accepted request bodies. Do not assert on private fields.
- Use the in-process CalDAV fixture; never point a test at a real account.
- Every abnormal path needs a case: auth failure, timeout, server error, unknown
  calendar, ambiguous calendar, invalid window, and rejected write.
- Clean up owned resources: dispose the context and close the fixture in teardown.

## Documentation

- Non-trivial source files start with an English `Purpose:` header describing
  flow, behavior, example, and boundaries. Document definitions where the reason
  is not obvious from the code.
- Keep the README tool table, the tool descriptions, and the schemas consistent
  in the same change.
- Record verification commands and their actual results; a build passing is not
  evidence that documented behavior is correct.

## Commands

```sh
pnpm run typecheck
pnpm run lint
pnpm test
```
