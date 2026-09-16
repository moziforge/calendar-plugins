/**
 * Purpose: Own the single plugin configuration surface and turn it into the
 * concrete credentials and connection policy the CalDAV client needs.
 *
 * High-level flow:
 * 1. Cordis validates the mounted plugin config against `Config` and fills
 *    schemastery defaults, so the service always receives complete fields.
 * 2. `resolveCredentials` combines those fields with the process environment on
 *    every call rather than at construction. Reading late is deliberate: the
 *    Host may load this plugin before the operator exports a secret, and a
 *    plugin that captured a missing password at startup could never recover.
 * 3. `describeConfiguration` produces a credential-free snapshot for status
 *    reporting and logs.
 *
 * Important behavior:
 * - The app-specific password is only ever read from the environment variable
 *   named by `passwordEnv`; it is never a config field, so it cannot be written
 *   into a preset file, a session log, or a tool argument.
 * - Missing credentials raise `CALENDAR_NOT_CONFIGURED` naming the exact
 *   variable to set. This is a normal first-run state, not a crash, so the
 *   plugin stays mounted and only the calendar tools fail.
 *
 * Example:
 * Input: config `{ account: '', passwordEnv: 'ICLOUD_APP_PASSWORD', serverUrl:
 *   'https://caldav.icloud.com/', calendars: [], timeoutMs: 20000 }` and
 *   environment `{ ICLOUD_ACCOUNT: 'me@example.com', ICLOUD_APP_PASSWORD: 'abcd-efgh-ijkl-mnop' }`.
 * Process: `account` is empty, so the resolver falls back to `ICLOUD_ACCOUNT`;
 *   the password is read from the configured variable name.
 * Result: `{ account: 'me@example.com', password: 'abcd-…', serverUrl:
 *   'https://caldav.icloud.com/', calendars: [], timeoutMs: 20000 }`. The
 *   returned object is passed straight to the DAV client and never logged.
 *
 * Edge-case Example:
 * Input: the same config with `ICLOUD_APP_PASSWORD` unset.
 * Process: the password lookup yields `undefined`, which is not a non-empty string.
 * Result: `CalendarError('CALENDAR_NOT_CONFIGURED', ... ICLOUD_APP_PASSWORD ...)`.
 *   The message names the variable and the Apple ID page that issues the value,
 *   and contains no secret, so it is safe to show in a chat transcript.
 *
 * Architectural boundaries:
 * - Configuration and credential resolution only. Connecting, caching, retrying,
 *   and parsing belong to `client.ts`, `ical.ts`, and `host.ts`.
 */

import z from '@deepseek-ai/schemastery'
import { CalendarError } from './errors.js'

/** Mounted plugin configuration; every field is defaulted by `Config`. */
export interface Config {
  /** Apple ID owning the calendars; empty means "read `ICLOUD_ACCOUNT`". */
  account: string
  /** Name of the environment variable holding the app-specific password. */
  passwordEnv: string
  /** CalDAV entry point; iCloud discovery redirects from here. */
  serverUrl: string
  /** Optional allowlist of calendar display names or ids; empty means all. */
  calendars: string[]
  /** Per-request deadline in milliseconds, covering discovery and queries. */
  timeoutMs: number
}

export const Config: z<Config> = z.object({
  account: z.string().default('').description('Apple ID (email) owning the calendars. Falls back to the ICLOUD_ACCOUNT environment variable.'),
  passwordEnv: z.string().default('ICLOUD_APP_PASSWORD').description('Name of the environment variable holding the app-specific password generated at https://appleid.apple.com. The Apple ID password does not work over CalDAV.'),
  serverUrl: z.string().default('https://caldav.icloud.com/').description('CalDAV entry point. iCloud discovery redirects through /.well-known/caldav.'),
  calendars: z.array(z.string()).default([]).description('Optional allowlist of calendar display names or ids. Empty exposes every calendar in the account.'),
  timeoutMs: z.number().default(20000).description('Per-request deadline in milliseconds.'),
})

/** Fully resolved connection settings handed to the DAV client. */
export interface Credentials {
  account: string
  password: string
  serverUrl: string
  calendars: string[]
  timeoutMs: number
}

/**
 * Resolves mount configuration plus environment into connectable credentials.
 *
 * Logic:
 * 1. Prefer the explicit `account` config field, else `ICLOUD_ACCOUNT`.
 * 2. Read the password from `env[config.passwordEnv]` only.
 * 3. Prefer `ICLOUD_CALDAV_SERVER_URL` over the built-in default so a redirected
 *    account host can be pinned without editing the preset.
 * 4. Fail with `CALENDAR_NOT_CONFIGURED` naming the missing variable.
 *
 * External calls and effects: reads `process.env` (passed in explicitly so the
 * caller owns the environment and tests need no global stubbing). No network.
 *
 * @param config - the mounted, defaulted plugin config.
 * @param env - environment map to read credentials from.
 * @returns credentials ready for `ICloudCalendarClient.connect`.
 * @throws CalendarError `CALENDAR_NOT_CONFIGURED` when account or password is absent.
 */
export function resolveCredentials(config: Config, env: NodeJS.ProcessEnv): Credentials {
  const account = (config.account || env.ICLOUD_ACCOUNT || '').trim()
  const password = (env[config.passwordEnv] ?? '').trim()
  const missing: string[] = []
  if (!account) missing.push('ICLOUD_ACCOUNT (or the account config field)')
  if (!password) missing.push(`${config.passwordEnv} (app-specific password from https://appleid.apple.com)`)
  if (missing.length > 0) {
    throw new CalendarError('CALENDAR_NOT_CONFIGURED', `iCloud calendar access is not configured. Set: ${missing.join(', ')}.`)
  }
  return {
    account,
    password,
    serverUrl: (env.ICLOUD_CALDAV_SERVER_URL || config.serverUrl).trim(),
    calendars: config.calendars,
    timeoutMs: config.timeoutMs,
  }
}

/** Credential-free view of the current configuration, safe to log or return. */
export interface ConfigurationDescription {
  configured: boolean
  /** Apple ID, or `null` when unset. Never a password. */
  account: string | null
  passwordEnv: string
  /** Whether the named variable currently holds a non-empty value. */
  passwordPresent: boolean
  serverUrl: string
  calendars: string[]
}

/**
 * Reports configuration readiness without exposing any secret.
 *
 * Logic: reuses `resolveCredentials` to decide `configured`, then reports only
 * presence booleans and the environment variable name. The password value is
 * never copied into the result, so this object is safe in logs and tool output.
 *
 * @param config - the mounted, defaulted plugin config.
 * @param env - environment map to inspect.
 * @returns a snapshot describing readiness.
 */
export function describeConfiguration(config: Config, env: NodeJS.ProcessEnv): ConfigurationDescription {
  const account = (config.account || env.ICLOUD_ACCOUNT || '').trim()
  let configured = true
  try {
    resolveCredentials(config, env)
  } catch {
    configured = false
  }
  return {
    configured,
    account: account || null,
    passwordEnv: config.passwordEnv,
    passwordPresent: (env[config.passwordEnv] ?? '').trim().length > 0,
    serverUrl: (env.ICLOUD_CALDAV_SERVER_URL || config.serverUrl).trim(),
    calendars: [...config.calendars],
  }
}
