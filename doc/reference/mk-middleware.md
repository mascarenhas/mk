# `mk.middleware.*` Module Reference

All ten built-in middleware modules live under `mk.middleware.*` and compile into the single `mk` provider. Every middleware captures its configuration as transferable snapshots so handlers work on `parent`, `pool`, and `session` worker threads.

Most `Config` records accept `next: (function (mk.Context): boolean)?`: when `next(ctx)` returns `true`, the middleware skips its logic and calls `ctx:next()` (**exception:** `timeout.new(handler, ...)` runs its wrapped `handler(ctx)` directly without a deadline instead of calling `ctx:next()`).

See [Chapter 3: Middleware and Logging](../guide/middleware-and-logging.md) for stack ordering and usage patterns.

---

## 1. `mk.middleware.env`

Import: `local env = import "mk.middleware.env"` (`src/mk/middleware/env.titan`).

```text
record Config
  const export_vars: {string: string}?   -- env name -> default when unset
end
function new(config: Config?): mk.Handler
```

- Validates every key in `export_vars` is non-empty and contains no `=` or NUL, and every default contains no NUL.
- Responds to `GET` and `HEAD` with `200` JSON `{"vars": { ... }}`, resolving each key as `os.getenv(name) or default` (empty object `{}` when `export_vars` is omitted).
- Any other method sets `Allow: GET, HEAD` and raises `mk.HttpError(405)`.

---

## 2. `mk.middleware.healthcheck`

Import: `local healthcheck = import "mk.middleware.healthcheck"` (`src/mk/middleware/healthcheck.titan`).

```text
const LIVENESS_ENDPOINT: string = "/livez"
const READINESS_ENDPOINT: string = "/readyz"
const STARTUP_ENDPOINT: string = "/startupz"

union ResponseFormat
  text()   -- "OK" / "Service Unavailable" via ctx:send_status
  json()   -- {"status":"ok"} / {"status":"unavailable"}
end
const FORMAT_TEXT: ResponseFormat
const FORMAT_JSON: ResponseFormat

record Config
  const next: (function (mk.Context): boolean)?
  const probe: (function (mk.Context): boolean)?   -- default: always true
  const response_format: ResponseFormat?           -- default FORMAT_TEXT
end
function new(config: Config?): mk.Handler
```

- Requests skipped by `next` or with methods other than `GET`/`HEAD` continue the chain via `ctx:next()`.
- On `GET`/`HEAD`, sets `Cache-Control: no-store` and responds with `200` when `probe == nil or probe(ctx)`, else `503`.

---

## 3. `mk.middleware.helmet`

Import: `local helmet = import "mk.middleware.helmet"` (`src/mk/middleware/helmet.titan`).

```text
record Config
  const next: (function (mk.Context): boolean)?
  const xss_protection: string?                -- default "0"
  const content_type_nosniff: string?          -- default "nosniff"
  const x_frame_options: string?               -- default "SAMEORIGIN"
  const hsts_max_age: integer?                 -- default 0 (>= 0; HTTPS only)
  const hsts_exclude_subdomains: boolean?      -- default false
  const hsts_preload_enabled: boolean?         -- default false
  const content_security_policy: string?       -- default ""
  const csp_report_only: boolean?              -- default false
  const referrer_policy: string?               -- default "no-referrer"
  const permission_policy: string?             -- default ""
  const cross_origin_embedder_policy: string?  -- default "require-corp"
  const cross_origin_opener_policy: string?    -- default "same-origin"
  const cross_origin_resource_policy: string?  -- default "same-origin"
  const origin_agent_cluster: string?          -- default "?1"
  const x_dns_prefetch_control: string?        -- default "off"
  const x_download_options: string?            -- default "noopen"
  const x_permitted_cross_domain: string?      -- default "none"
end
function new(config: Config?): mk.Handler
```

- Setting any string option to `""` omits that header.
- Raises on `hsts_max_age < 0` or `hsts_preload_enabled == true and hsts_exclude_subdomains == true`.
- `Strict-Transport-Security` is emitted only when `hsts_max_age > 0` and `ctx:secure()` is `true` (appending `; includeSubDomains` unless excluded, and `; preload` when enabled).
- `csp_report_only = true` emits `Content-Security-Policy-Report-Only` instead of `Content-Security-Policy`.

---

## 4. `mk.middleware.keyauth`

Import: `local keyauth = import "mk.middleware.keyauth"` (`src/mk/middleware/keyauth.titan`).

Extracts API keys or bearer tokens, delegates validation to a caller-supplied `validator`, and provides `constant_time_equal` for timing-safe secret checks.

```text
record CustomExtractor
function CustomExtractor.new(fn: function (mk.Context): (string?)): CustomExtractor
function CustomExtractor:to_transfer_payload(): string
function CustomExtractor.from_transfer_payload(payload: string): CustomExtractor

union Extractor
  auth_header(scheme: string)     -- Authorization: <scheme> <key> (case-insensitive scheme)
  header(name: string)            -- first value of header
  single_header(name: string)     -- header present exactly once (duplicates count as missing)
  query(name: string)             -- first value of query parameter
  cookie(name: string)            -- request cookie
  chain(items: {Extractor})       -- first non-empty key in order (requires >= 1 item)
  custom(extractor: CustomExtractor)
end

record Config
  const next: (function (mk.Context): boolean)?
  const extractor: Extractor?                  -- default Extractor.auth_header("Bearer")
  const validator: function (mk.Context, string): boolean
  const realm: string?                         -- default "Restricted"
  const challenge: string?                     -- explicit WWW-Authenticate override
  const error_code: string?                    -- "", "invalid_request", "invalid_token", "insufficient_scope"
  const error_description: string?
  const error_uri: string?
  const scope: string?
  const success_handler: mk.Handler?
  const error_handler: mk.ErrorHandler?
end

function new(config: Config): mk.Handler
function token_from_context(ctx: mk.Context): string
function constant_time_equal(left: string, right: string): boolean
```

- Missing/malformed key produces `mk.HttpError(401, "missing or malformed API key", "missing_api_key")`; rejected key produces `mk.HttpError(401, "invalid API key", "invalid_api_key")`.
- On rejection, sets `WWW-Authenticate` (using explicit `challenge`, else `<scheme> realm="<realm>"` plus RFC 6750 error/scope parameters when an `auth_header` scheme is present, else `ApiKey realm="<realm>"`) and calls `error_handler(ctx, err)` or raises `err`.
- On success, stores the validated key for `token_from_context(ctx)` (returns `""` if absent) and invokes `success_handler(ctx)` if provided, else `ctx:next()`.

---

## 5. `mk.middleware.logger`

Import: `local logger_mw = import "mk.middleware.logger"` (`src/mk/middleware/logger.titan`).

```text
union Phase
  completion()   -- log via ctx:on_complete after final status/abort
  admission()    -- log before ctx:next() using ctx:classified_route()
end
const PHASE_COMPLETION: Phase
const PHASE_ADMISSION: Phase

record Config
  const next: (function (mk.Context): boolean)?
  const skip: (function (mk.Context): boolean)?
  const sink_sender: thread.Sender<|string|>?  -- nil uses ctx:log(...)
  const level: string?                         -- default "info" (validated via log.resolve_level)
  const event: string?                         -- default "http_request" (must be non-empty)
  const phase: Phase?                          -- default PHASE_COMPLETION
  const include_path: boolean?                 -- default false
  const include_request_id: boolean?           -- default true
  const extra_fields: (function (mk.Context): {string: value}?)?
end
function new(config: Config?): mk.Handler
```

- `next` skips the middleware entirely at entry; `skip` suppresses emitting the log line when evaluated (on admission or inside `on_complete`). Neither mode catches or consumes exceptions.
- **Logged fields:** `method` (standard HTTP method `GET`..`PATCH` or `"OTHER"`), `route` (`ctx:classified_route()` in admission mode, `done:matched_route()` in completion mode, or `"<unmatched>"`), optional `path` (when `include_path = true`), optional `request_id` (when `include_request_id = true` and non-empty), optional `worker_id` (when non-zero). Completion lines add `status`, `latency_ms`, `aborted` (when `true`), and `error_code` (from `done:last_error().code` when present). Built-in fields win over keys returned by `extra_fields`.
- When `sink_sender` is set, encodes via `log.format_line` and sends non-blocking with `sink_sender:try_send(line)` (dropping lines `> log.MAX_LINE_BYTES + 1`, full/closed channels, or encoding errors without affecting the request).

---

## 6. `mk.middleware.recover`

Import: `local recover = import "mk.middleware.recover"` (`src/mk/middleware/recover.titan`).

```text
record Config
  const next: (function (mk.Context): boolean)?
  const enable_stack_trace: boolean?           -- default false
  const stack_trace_handler: (function (mk.Context, value, string): ())?
  const exception_handler: (function (mk.Context, value, string): mk.HttpError)?
end
function new(config: Config?): mk.Handler
```

- Lets `mk.HttpError` and `async.CancellationReason` propagate untouched with their original tracebacks.
- For any other exception: when `enable_stack_trace = true`, invokes `stack_trace_handler(ctx, failure, trace)` or defaults to `ctx:log("error", "panic_recovered", { error, traceback, method, route })` (falling back to `os.stderr:write` if `ctx:logger() == nil`). Then raises `exception_handler(ctx, failure, trace)` if provided, else `mk.HttpError(500, nil, "internal_error", failure)`.

---

## 7. `mk.middleware.requestid`

Import: `local requestid = import "mk.middleware.requestid"` (`src/mk/middleware/requestid.titan`).

```text
record Config
  const next: (function (mk.Context): boolean)?
  const header: string?                        -- default "X-Request-ID" (must be HTTP token)
  const generator: (function (): string)?      -- default 16-byte CSPRNG hex via uv.random
end
function new(config: Config?): mk.Handler
function from_context(ctx: mk.Context): string
```

- Validates incoming and generated IDs as `1..256` graphic ASCII VCHAR bytes (`0x21..0x7E`, no spaces or controls).
- If an incoming header is absent or invalid, invokes `generator` up to 3 times before falling back to 16 random bytes formatted as 32 lowercase hex characters via `uv.random`.
- Echoes the ID in response header `header` and stores it for `from_context(ctx)` and `ctx:request_id()`.

---

## 8. `mk.middleware.responsetime`

Import: `local responsetime = import "mk.middleware.responsetime"` (`src/mk/middleware/responsetime.titan`).

```text
record Config
  const next: (function (mk.Context): boolean)?
  const header: string?                        -- default "X-Response-Time" (must be HTTP token)
end
function new(config: Config?): mk.Handler
```

- Registers a `ctx:on_before_commit` hook before calling `ctx:next()`, setting `header` to `strings.format("%.3fms", elapsed_ms)` using `uv.hrtime()`. Never catches exceptions; works on buffered, error, streamed, and WebSocket `101` responses.

---

## 9. `mk.middleware.static`

Import: `local static = import "mk.middleware.static"` (`src/mk/middleware/static.titan`).

```text
record Config
  const next: (function (mk.Context): boolean)?
  const index_names: {string}?                 -- default {"index.html"}
  const browse: boolean?                       -- default false
  const byte_range: boolean?                   -- default false
  const download: boolean?                     -- default false
  const max_age: integer?                      -- default 0 (>= 0)
  const modify_response: mk.Handler?
  const not_found_handler: mk.Handler?
end
function new(root: string, config: Config?): mk.Handler
```

- **Path selection (which path is served):**
  1. If the matched route has a raw `*` or `+` wildcard capture (e.g. `app:get("/assets/*", static.new(root))`), serves that wildcard capture (`/assets/app.js` -> `<root>/app.js`).
  2. Otherwise, if inside a sub-app mounted via `App:mount`, serves the path below `ctx:mount_path()`.
  3. Otherwise, serves the **full** request path (`app:use_path("/assets", static.new(root))` maps `/assets/app.js` -> `<root>/assets/app.js`).
- **Confinement & validation:**
  - `new(root, config?)` requires `root ~= ""`, `max_age >= 0`, and each `index_names` entry to be a single valid basename (non-empty, not `.` or `..`, not a Windows reserved device name, and free of `/`, `\`, `:`, NUL).
  - Resolves `canonical_root = fs.realpath(root)` lazily per worker (`404` if missing or non-directory; because `titan.fs` is path-based without `openat`/`O_NOFOLLOW`, `root` must be a deployment-trusted directory not concurrently mutated by untrusted local processes).
  - Non-`GET`/`HEAD` requests call `ctx:next()`.
  - Selected paths split on `/`, skip empty raw segments, percent-decode each non-empty segment once (`400` `"invalid_path"` on invalid `%XX`), and reject (`404` / `not_found_handler`) any decoded segment equal to `.` or `..`, containing NUL, `/`, `\`, or `:`, or matching a Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9`, case-insensitive, with or without extension or trailing spaces).
  - Joined candidates require `fs.lstat` non-symlink leaves (or directories probing validated `index_names`) **and** `fs.realpath(candidate)` matching a strict path-component boundary under `canonical_root`.
- **Serving behavior:**
  - Regular files emit MIME `Content-Type`, weak `ETag` and `Last-Modified` (`304` conditional), optional `Cache-Control` (`max_age`), `Content-Disposition` (`download`), and single-range `206`/`416` (`byte_range`), run `modify_response` before commit, and stream in 64 KiB chunks (`HEAD` omits body; mid-stream truncation aborts).
  - Directory `browse = true` HTML-escapes names (`&`, `<`, `>`, `"`, `'`), URL-encodes links with `router.percent_encode_segment`, and omits symlinks.

---

## 10. `mk.middleware.timeout`

Import: `local timeout = import "mk.middleware.timeout"` (`src/mk/middleware/timeout.titan`).

```text
record Config
  const next: (function (mk.Context): boolean)?
  const on_timeout: mk.Handler?   -- default: HttpError(503, ..., "timeout")
end
function new(handler: mk.Handler, timeout_ms: integer, config: Config?): mk.Handler
function middleware(timeout_ms: integer, config: Config?): mk.Handler
```

- Requires `timeout_ms >= 0`.
- Delegates to `ctx:run_with_timeout(timeout_ms, action, config.on_timeout)` (owner-Task revocation + abort-before-join cleanup).
- When `config.next(ctx)` returns `true`, `timeout.new` invokes `handler(ctx)` directly without a deadline, whereas `timeout.middleware` calls `ctx:next()`.
