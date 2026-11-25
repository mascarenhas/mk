# `mk.middleware.*` Module Reference

All ten built-in middleware modules live under `mk.middleware.*` and
compile into the single `mk` provider. Each module snapshots its scalar
configuration so handlers can transfer to `pool` and `session` worker
threads; any caller-supplied closures in a `Config` record (`next`, `skip`,
`probe`, `validator`, `generator`, `extra_fields`, `stack_trace_handler`,
`exception_handler`, `on_timeout`, `modify_response`, `not_found_handler`,
`success_handler`, `error_handler`, or `CustomExtractor`) must themselves
satisfy Titan's cross-state closure transfer rules when deployed on
workers.

Most `Config` records accept `next: (function (mk.Context): boolean)?`.
When `next(ctx)` returns `true`, the middleware bypasses its behavior and
calls `ctx:next()` (exception: `timeout.new(handler, ...)` invokes
`handler(ctx)` directly without a deadline instead of calling `ctx:next()`).

See [How to Compose Middleware and Structured Logging](../how-to/middleware-and-logging.md)
for stack ordering and configuration recipes.

## `mk.middleware.env`

Import: `local env = import "mk.middleware.env"`
(`src/mk/middleware/env.titan`).

```titan
record Config
  const export_vars: {string: string}?  -- env name -> default
end

function new(config: Config?): mk.Handler
```

- `new(config?)` validates that every key in `export_vars` is non-empty and
  contains no `=` or NUL byte, and that every default value contains no NUL
  byte (raising `"env: ..."` errors otherwise). Internally serializes
  `export_vars` as a NUL-separated string so the handler transfers across
  worker threads.
- On `GET` and `HEAD`, responds with status `200` JSON
  `{"vars": { ... }}`, resolving each key as `os.getenv(name) or default`
  (producing `{"vars":{}}` when `export_vars` is omitted or empty).
- On any other method, sets `Allow: GET, HEAD` and raises
  `mk.HttpError(405)`.

## `mk.middleware.healthcheck`

Import: `local healthcheck = import "mk.middleware.healthcheck"`
(`src/mk/middleware/healthcheck.titan`).

```titan
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
  const probe: (function (mk.Context): boolean)?  -- default: true
  const response_format: ResponseFormat?          -- default FORMAT_TEXT
end

function new(config: Config?): mk.Handler
```

- Requests skipped by `next` and requests with methods other than `GET` or
  `HEAD` continue via `ctx:next()`.
- On `GET` and `HEAD`, sets `Cache-Control: no-store` and evaluates
  `healthy = probe == nil or probe(ctx)`.
- `FORMAT_TEXT` responds via `ctx:send_status(200)` (`"OK"`) or
  `ctx:send_status(503)` (`"Service Unavailable"`). `FORMAT_JSON` responds
  via `ctx:json_raw` with status `200` (`{"status":"ok"}`) or `503`
  (`{"status":"unavailable"}`).

## `mk.middleware.helmet`

Import: `local helmet = import "mk.middleware.helmet"`
(`src/mk/middleware/helmet.titan`).

```titan
record Config
  const next: (function (mk.Context): boolean)?
  const xss_protection: string?                -- "0"
  const content_type_nosniff: string?          -- "nosniff"
  const x_frame_options: string?               -- "SAMEORIGIN"
  const hsts_max_age: integer?                 -- 0 (>= 0; HTTPS only)
  const hsts_exclude_subdomains: boolean?      -- false
  const hsts_preload_enabled: boolean?         -- false
  const content_security_policy: string?       -- ""
  const csp_report_only: boolean?              -- false
  const referrer_policy: string?               -- "no-referrer"
  const permission_policy: string?             -- ""
  const cross_origin_embedder_policy: string?  -- "require-corp"
  const cross_origin_opener_policy: string?    -- "same-origin"
  const cross_origin_resource_policy: string?  -- "same-origin"
  const origin_agent_cluster: string?          -- "?1"
  const x_dns_prefetch_control: string?        -- "off"
  const x_download_options: string?            -- "noopen"
  const x_permitted_cross_domain: string?      -- "none"
end

function new(config: Config?): mk.Handler
```

- Default headers emitted when `config` is omitted: `X-XSS-Protection: 0`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`,
  `Referrer-Policy: no-referrer`,
  `Cross-Origin-Embedder-Policy: require-corp`,
  `Cross-Origin-Opener-Policy: same-origin`,
  `Cross-Origin-Resource-Policy: same-origin`, `Origin-Agent-Cluster: ?1`,
  `X-DNS-Prefetch-Control: off`, `X-Download-Options: noopen`, and
  `X-Permitted-Cross-Domain-Policies: none`. CSP and Permissions-Policy are
  omitted by default (`""`).
- Setting any string option to `""` omits that header.
- Raises `"helmet: hsts_max_age must be non-negative"` when
  `hsts_max_age < 0` and
  `"helmet: hsts_preload_enabled requires subdomains to be included"` when
  `hsts_preload_enabled == true and hsts_exclude_subdomains == true`.
- Emits `Strict-Transport-Security` only when `hsts_max_age > 0` and
  `ctx:secure()` is `true`, appending `; includeSubDomains` unless
  `hsts_exclude_subdomains` is `true`, and `; preload` when
  `hsts_preload_enabled` is `true`.
- When `csp_report_only` is `true`, emits
  `Content-Security-Policy-Report-Only` instead of
  `Content-Security-Policy`.
- Headers are set before `ctx:next()` and persist through
  `Config.error_handler` because `ctx:reset_body()` keeps response headers.

## `mk.middleware.keyauth`

Import: `local keyauth = import "mk.middleware.keyauth"`
(`src/mk/middleware/keyauth.titan`).

```titan
record CustomExtractor
  -- opaque; construct with CustomExtractor.new(fn)
end

function CustomExtractor.new(
  fn: function (mk.Context): (string?)
): CustomExtractor
function CustomExtractor:to_transfer_payload(): string
function CustomExtractor.from_transfer_payload(
  payload: string
): CustomExtractor

union Extractor
  auth_header(scheme: string)    -- Authorization: <scheme> <key>
  header(name: string)           -- first value of header
  single_header(name: string)    -- present once (duplicates = missing)
  query(name: string)            -- first query value (empty = missing)
  cookie(name: string)           -- non-empty request cookie
  chain(items: {Extractor})      -- first non-nil result (>= 1 item)
  custom(extractor: CustomExtractor)
end

record Config
  const next: (function (mk.Context): boolean)?
  const extractor: Extractor?                  -- auth_header("Bearer")
  const validator: function (mk.Context, string): boolean
  const realm: string?                         -- "Restricted"
  const challenge: string?                     -- header override
  const error_code: string?                    -- RFC 6750 error code
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

- `config` is required (not optional) and must provide `validator`.
- **Extraction rules:** `auth_header(scheme)` requires `<scheme>` followed
  by a single space and a non-empty trimmed key (scheme match is ASCII
  case-insensitive). `header(name)` takes the first header value.
  `single_header(name)` requires the header to appear exactly once. `query`
  and `cookie` reject empty values. `chain(items)` requires at least one
  extractor and returns the first non-`nil` result.
- **Configuration validation:** Auth scheme and header names must be valid
  HTTP tokens; query and cookie names must be non-empty; `error_code` must
  be `""`, `"invalid_request"`, `"invalid_token"`, or
  `"insufficient_scope"`; challenge parameters cannot contain control
  characters other than TAB.
- **Failure handling:** A missing or malformed key produces
  `mk.HttpError(401, "missing or malformed API key", "missing_api_key")`; a
  rejected key produces
  `mk.HttpError(401, "invalid API key", "invalid_api_key")`. Before calling
  `error_handler(ctx, err)` (which stops the chain) or raising `err`,
  `keyauth` sets `WWW-Authenticate` to `challenge` if provided; else, when
  the extractor (or the first `auth_header` in a `chain`) specifies a
  scheme, `<Scheme> realm="<realm>"` plus any quoted and escaped
  `error`, `error_description`, `error_uri`, and `scope` parameters; else
  `ApiKey realm="<realm>"` (default realm `"Restricted"`).
- **Success handling:** Stores the validated key in request local
  `"keyauth.token"` (read via `token_from_context(ctx)`, returning `""` if
  unset), then invokes `success_handler(ctx)` if provided (stopping the
  chain unless that handler calls `ctx:next()`), else calls `ctx:next()`.
- **`constant_time_equal(left, right)`:** Compares two byte strings in time
  proportional to the longer string.

## `mk.middleware.logger`

Import: `local logger_mw = import "mk.middleware.logger"`
(`src/mk/middleware/logger.titan`).

```titan
union Phase
  completion()   -- log via ctx:on_complete after final status or abort
  admission()    -- log before ctx:next() using ctx:classified_route()
end

const PHASE_COMPLETION: Phase
const PHASE_ADMISSION: Phase

record Config
  const next: (function (mk.Context): boolean)?
  const skip: (function (mk.Context): boolean)?
  const sink_sender: thread.Sender<|string|>?  -- nil uses ctx:log(...)
  const level: string?                         -- "info"
  const event: string?                         -- "http_request"
  const phase: Phase?                          -- PHASE_COMPLETION
  const include_path: boolean?                 -- false
  const include_request_id: boolean?           -- true
  const extra_fields: (function (mk.Context): {string: value}?)?
end

function new(config: Config?): mk.Handler
```

- `level` is validated with `log.resolve_level(level, nil, "logger: level")`.
  An empty `event` raises `"logger: event must not be empty"`.
- **Pass-through behavior:** When `sink_sender == nil` and
  `ctx:logger() == nil`, the middleware is a pass-through and emits no
  records.
- `next` skips the middleware at entry. `skip` is evaluated when the log
  line would be emitted (at admission or inside `on_complete`). Neither
  phase catches or consumes request exceptions.
- **Logged fields:** `extra_fields(ctx)` is merged first; built-in fields
  always overwrite colliding keys:
  - `method`: one of the nine standard HTTP methods (`GET` through `PATCH`),
    else `"OTHER"`.
  - `route`: `ctx:classified_route()` in admission mode; in completion
    mode, `done:matched_route()`, falling back to `done:classified_route()`
    when empty, and `"<unmatched>"` when both are empty.
  - `path`: included only when `include_path` is `true`.
  - `request_id`: included when `include_request_id` is `true` and
    `ctx:request_id()` is non-empty.
  - `worker_id`: included when `ctx:worker_id()` is non-zero.
  - Completion-only fields: `status`, `latency_ms` (float), `aborted = true`
    (included only when aborted), and `error_code` (from
    `done:last_error().code` when present).
- When `sink_sender` is set, encodes via `log.format_line` and sends
  non-blocking with `sink_sender:try_send(line)`, silently dropping lines
  exceeding `log.MAX_LINE_BYTES + 1`, full or closed channels, or encode
  failures without affecting the request.

## `mk.middleware.recover`

Import: `local recover = import "mk.middleware.recover"`
(`src/mk/middleware/recover.titan`).

```titan
record Config
  const next: (function (mk.Context): boolean)?
  const enable_stack_trace: boolean?           -- false
  const stack_trace_handler:
    (function (mk.Context, value, string): ())?
  const exception_handler:
    (function (mk.Context, value, string): mk.HttpError)?
end

function new(config: Config?): mk.Handler
```

- Wraps `ctx:next()`. Re-raises `async.CancellationReason` and `mk.HttpError`
  untouched with their original tracebacks.
- For any other exception: when `enable_stack_trace` is `true`, invokes
  `stack_trace_handler(ctx, failure, trace)` if set; otherwise logs event
  `"panic_recovered"` with fields `error`, `traceback`, `method`, `route`,
  and `worker_id` through `ctx:log` (falling back to `"panic: ..."` on
  `os.stderr` when no logger is configured).
- After optional trace handling, raises
  `exception_handler(ctx, failure, trace)` if provided, else
  `mk.HttpError(500, nil, "internal_error", failure)` (message
  `"Internal Server Error"`).

## `mk.middleware.requestid`

Import: `local requestid = import "mk.middleware.requestid"`
(`src/mk/middleware/requestid.titan`).

```titan
record Config
  const next: (function (mk.Context): boolean)?
  const header: string?                        -- "X-Request-ID"
  const generator: (function (): string)?      -- 16-byte uv.random hex
end

function new(config: Config?): mk.Handler
function from_context(ctx: mk.Context): string
```

- `header` must be a valid HTTP token; otherwise `new` raises
  `"requestid: header must be an HTTP token"`.
- Reuses the incoming `header` value when it is `1`–`256` bytes with every
  byte in `0x21`–`0x7E` (graphic ASCII VCHAR, no spaces or controls).
- When the incoming header is absent or invalid, invokes `generator` up to
  `3` attempts in total (validating each result against the same byte
  rule), then falls back to `16` random bytes from `uv.random` formatted as
  `32` lowercase hex characters.
- Calls `ctx:set(header, id)` and `ctx:set_local("requestid", id)` before
  `ctx:next()`. `from_context(ctx)` delegates to `ctx:request_id()`.

## `mk.middleware.responsetime`

Import: `local responsetime = import "mk.middleware.responsetime"`
(`src/mk/middleware/responsetime.titan`).

```titan
record Config
  const next: (function (mk.Context): boolean)?
  const header: string?                        -- "X-Response-Time"
end

function new(config: Config?): mk.Handler
```

- `header` is validated as an HTTP token.
- Registers a `ctx:on_before_commit` hook before calling `ctx:next()`,
  setting `header` to `strings.format("%.3fms", elapsed_ms)` measured from
  middleware entry via `uv.hrtime()`.
- Never catches exceptions; attaches to buffered, error-handler, streamed,
  WebSocket `101`, and upgrade-rejection responses.

## `mk.middleware.static`

Import: `local static = import "mk.middleware.static"`
(`src/mk/middleware/static.titan`).

```titan
record Config
  const next: (function (mk.Context): boolean)?
  const index_names: {string}?                 -- {"index.html"}
  const browse: boolean?                       -- false
  const byte_range: boolean?                   -- false
  const download: boolean?                     -- false
  const max_age: integer?                      -- 0 (>= 0)
  const modify_response: mk.Handler?
  const not_found_handler: mk.Handler?
end

function new(root: string, config: Config?): mk.Handler
```

- **Configuration validation:** `new(root, config?)` raises
  `"static: root must not be empty"`,
  `"static: max_age must be non-negative"`, or
  `"static: index name must be a single basename"` (rejecting empty
  strings, `.`, `..`, names containing `/`, `\`, `:`, or NUL, and Windows
  reserved device names). Passing `index_names = {}` disables index files.
- **Served-path precedence:**
  1. If `ctx:matched_route()` contains `*` or `+`, re-extracts the raw
     wildcard capture from `original_url` with a case-insensitive,
     non-unescaping matcher.
  2. Otherwise, if `ctx:mount_path()` is neither `""` nor `"/"`, uses the
     raw path after the mount prefix.
  3. Otherwise, uses the full raw request path
     (`app:use_path("/assets", static.new(root))` maps `/assets/app.js` to
     `<root>/assets/app.js`).
- **Methods and miss behavior:** Requests with methods other than `GET` or
  `HEAD` continue via `ctx:next()`. Missing, invalid, or rejected paths raise
  `mk.HttpError(404)` (or invoke `not_found_handler`); `static` does not
  fall through to `ctx:next()` unless `not_found_handler` calls it.
  Dotfiles are served and listed without filtering.
- **Root resolution and confinement:** Resolves `canonical_root` lazily per
  Lua state on first request (`fs.stat` must report a directory, followed
  by `fs.realpath`). Resolution failures are not cached; requests receive
  `404` and retry on subsequent requests. Segments split on `/` (skipping
  empty segments) and percent-decode once (`400` `"invalid_path"` on
  invalid `%XX`). Decoded basenames equal to `.` or `..`, containing NUL,
  `/`, `\`, or `:`, or matching Windows reserved device names (`CON`,
  `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, ASCII case-insensitive,
  with or without extension or trailing spaces) return `404`. Candidate
  leaves are checked with `fs.lstat` (symlink leaves are rejected) and
  `fs.realpath` must lie inside `canonical_root` at a path-component
  boundary (intermediate symlinked directories stay allowed if their
  resolved path remains inside `canonical_root`).
- **File serving order:**
  1. Computes weak ETag `W/"<size hex>-<mtime hex>"`. Evaluates
     `If-None-Match` (all lines, comma lists, `*`, weak comparison) before
     `If-Modified-Since` (IMF-fixdate only; `mtime <= since`).
  2. On a conditional match, sets `ETag`, `Last-Modified`, and optional
     `Cache-Control`, sets status `304`, runs `modify_response`, and
     returns without a body.
  3. When `byte_range` is `true` and the method is `GET` (not `HEAD`),
     parses a single `bytes=` range. Multiple or malformed ranges are
     ignored (full `200`). An unsatisfiable range sets
     `Content-Range: bytes */<size>` and raises `mk.HttpError(416)`.
  4. Sets `ETag`, `Last-Modified`, `Cache-Control: public, max-age=N`
     (when `max_age > 0`), `Content-Type` via `ctx:type(ext)`,
     `Content-Disposition` (when `download` is `true`),
     `Accept-Ranges: bytes` (only when `byte_range` is `true`), `206` plus
     `Content-Range` for satisfied ranges, and `Content-Length`.
  5. Runs `modify_response(ctx)`. Skips sending a body for `HEAD`, aborted
     or committed responses, or statuses `204`, `205`, or `304` after the
     hook.
  6. Streams file bytes in `64 KiB` chunks. A short read before the range
     start raises
     `mk.HttpError(500, "file changed while it was being served", "file_truncated")`;
     truncation mid-stream aborts the transport.
- **Directory listings (`browse = true`):** Lists sorted regular files and
  directories with valid basenames (omitting symlinks and device names),
  HTML-escapes labels, and builds origin-relative `href`s with collapsed
  slashes and `router.percent_encode_segment`.

## `mk.middleware.timeout`

Import: `local timeout = import "mk.middleware.timeout"`
(`src/mk/middleware/timeout.titan`).

```titan
record Config
  const next: (function (mk.Context): boolean)?
  const on_timeout: mk.Handler?  -- default: 503 "timeout"
end

function new(
  handler: mk.Handler, timeout_ms: integer, config: Config?
): mk.Handler
function middleware(
  timeout_ms: integer, config: Config?
): mk.Handler
```

- Both constructors raise `"timeout: timeout_ms must be non-negative"` when
  `timeout_ms < 0`. `timeout_ms = 0` runs inline with no deadline.
- Both delegate to `ctx:run_with_timeout(timeout_ms, action, on_timeout)`,
  which revokes the child Task's context ownership and aborts blocked
  transports before joining on expiry.
- When `config.next(ctx)` returns `true`, `timeout.new` invokes
  `handler(ctx)` directly without a deadline, whereas `timeout.middleware`
  calls `ctx:next()`.
- On expiry: if the response is already committed or aborted, aborts any
  unfinished stream and returns without calling `on_timeout` or raising
  `503`; otherwise resets the buffered body and runs `on_timeout(ctx)` or
  raises `mk.HttpError(503, "Service Unavailable", "timeout")`.
