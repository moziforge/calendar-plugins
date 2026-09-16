/**
 * Purpose: Publish the plugin's public entry points for a Harness preset.
 *
 * High-level flow: a Host-plane preset mounts two modules from this package —
 * `@moziforge/calendar-icloud-plugin/host` for the service and
 * `@moziforge/calendar-icloud-plugin/tools` for the model-facing tools. This
 * barrel re-exports both plus the vocabulary a consumer needs to type its own
 * integration, so callers never import a `dist/` path directly.
 *
 * Example:
 * Input: a preset row `name: '@moziforge/calendar-icloud-plugin/host'` with
 *   `config: { account: 'me@example.com' }`.
 * Process: the loader resolves the `./host` export to `dist/host.js` and mounts
 *   the default-exported `CalendarService`.
 * Result: `ctx.calendar` and the three calendar tools are available to every
 *   agent in that deployment.
 *
 * Architectural boundaries:
 * - Re-exports only; this module holds no logic of its own.
 */

export { CalendarService as default, CalendarService, Config, name, CALENDAR_CACHE_TTL_MS, DEFAULT_EVENT_LIMIT, MAX_WINDOW_MS, buildEventCalendar, resolveEventTimes, resolveWindow } from './host.js'
export type { CalendarStatus, ListEventsRequest, ListEventsResult } from './host.js'
export { ICloudCalendarClient } from './client.js'
export type { RemoteCalendarObject } from './client.js'
export { describeConfiguration, resolveCredentials } from './config.js'
export type { Config as CalendarConfig, ConfigurationDescription, Credentials } from './config.js'
export { CalendarError, toCalendarError } from './errors.js'
export type { CalendarErrorCode } from './errors.js'
export { MAX_OCCURRENCES_PER_SERIES, instantString, parseCalendarObject, parseCalendarObjects, sortEvents } from './ical.js'
export type { CalendarObjectInput, ParseContext, ParseResult } from './ical.js'
export type { CalendarEvent, CalendarSummary, CreateEventRequest, CreatedEvent, EventStatus, EventWindow } from './types.js'
