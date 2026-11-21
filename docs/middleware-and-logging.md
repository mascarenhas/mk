# Middleware and Logging

`titan-mk` includes a bounded JSON-line logger (`mk.log`) and ten focused middleware modules under `mk.middleware.*`.

## Structured JSON-Line Logging (`mk.log`)

`mk.log` emits strictly JSON-encoded lines terminated by `\n` (capped at `MAX_LINE_BYTES = 16384` bytes). Every line carries `event`, `level`, and UTC ISO-8601 `timestamp` (`YYYY-MM-DDTHH:MM:SSZ`), merged with any caller-supplied `fields: {string: value}?`.

```text
const MAX_LINE_BYTES: integer = 16384

record Logger
function Logger.new(level: string?, sink: (function (string): ())?,
                    capacity: integer?): Logger
function Logger:level(): string
function Logger:emit(level: string, event: string, fields: {string: value}?)
function Logger:error(event: string, fields: {string: value}?)
function Logger:warn(event: string, fields: {string: value}?)
function Logger:info(event: string, fields: {string: value}?)
function Logger:debug(event: string, fields: {string: value}?)
function Logger:accept(encoded: string)
function Logger:close()

function resolve_level(level: string?, allow_warn: boolean?, env_name: string?): string
function format_line(level: string, event: string, fields: {string: value}?): string
function emit(logger: Logger?, level: string, event: string, fields: {string: value}?)
function forward(level: string, lines: thread.Sender<|string|>?): Logger?
function fatal(event: string, reason: string, fields: {string: value}?)
```

### Operational Guarantees

- **Levels:** `"error"` (1), `"warn"` (2), `"info"` (3, default), and `"debug"` (4). `resolve_level(level?, allow_warn?, env_name?)` validates level strings (pass `allow_warn = false` when only `error`/`info`/`debug` are permitted).
- **Non-suspending bounded admission:** `Logger.new` defaults to `"info"`, `os.stderr:write`, and a queue capacity of `1024`. `emit` / `accept` never yield; a single owned writer Task delivers admitted lines to the sink in order.
- **Drop accounting & failure isolation:** Queue overflow, invalid levels, encoding errors (invalid UTF-8, cycles, unsupported values, or lines exceeding `MAX_LINE_BYTES`), or non-blocking sink refusals never raise into callers—they increment a drop counter and the writer Task emits `{"event":"log_dropped","level":"error","count":N,"timestamp":"..."}` around its next delivered line or at `Logger:close()`. An exception from the destination sink disables the logger instead of crashing the application.
- **Cross-thread forwarding:** `log.forward(level, lines)` creates a bounded (`1024`) logger that forwards encoded lines via non-blocking `lines:try_send` without owning or closing the borrowed `Sender`. When `Config.logger` is set on `mk.App`, `mk` automatically wires a forwarding logger into every pool and session worker (`wctx.logger` / `ctx:logger()` / `ctx:log(...)`).
- **Drain on shutdown:** Always `defer logger:close()` so the writer Task flushes every admitted line before the process exits. Use `log.fatal(event, reason, fields?)` for best-effort stderr diagnostics before a `Logger` exists.

## Built-in Middleware (`mk.middleware.*`)

Most middleware `Config` records accept an optional `next: (function (mk.Context): boolean)?` predicate: when `next(ctx)` returns `true`, the middleware skips its own logic and delegates directly to `ctx:next()` (except `timeout.new(handler, ...)`, which runs its wrapped `handler(ctx)` without a deadline instead of calling `ctx:next()`).

A typical global middleware stack registers outer cross-cutting observers first:

```titan
app:use(
  requestid.new(),
  recover.new(),
  logger_mw.new(),
  responsetime.new(),
  helmet.new()
)
```

---

### 1. `mk.middleware.env`

Exposes a selected map of environment variables as JSON on `GET`/`HEAD` (with fallback defaults).

```text
record Config
  const export_vars: {string: string}?
end
function Config.new(export_vars: {string: string}?): Config
function new(config: Config?): mk.Handler
```

- Responds to `GET` and `HEAD` with `200` JSON `{"vars": { ... }}`, resolving each configured key as `os.getenv(key) or fallback` (default `{}`).
- Any other HTTP method sets `Allow: GET, HEAD` and raises `mk.HttpError(405)`.

---

### 2. `mk.middleware.healthcheck`

Provides liveness, readiness, and startup probe handlers.

```text
const LIVENESS_ENDPOINT: string   -- "/livez"
const READINESS_ENDPOINT: string  -- "/readyz"
const STARTUP_ENDPOINT: string    -- "/startupz"

union ResponseFormat
  text()
  json()
end
const FORMAT_TEXT: ResponseFormat
const FORMAT_JSON: ResponseFormat

record Config
  const next: (function (mk.Context): boolean)?
  const probe: (function (mk.Context): boolean)?
  const response_format: ResponseFormat?
end
function Config.new(next: (function (mk.Context): boolean)?,
                    probe: (function (mk.Context): boolean)?,
                    response_format: ResponseFormat?): Config
function new(config: Config?): mk.Handler
```

Mount on `LIVENESS_ENDPOINT`, `READINESS_ENDPOINT`, or `STARTUP_ENDPOINT` (or any custom path). Supply `probe` to check dependencies and return `true` (`200`) or `false` (`503`) in plain text (`FORMAT_TEXT`) or JSON (`FORMAT_JSON`).

---

### 3. `mk.middleware.helmet`

Sets standard HTTP security headers on responses.

```text
record Config
  const next: (function (mk.Context): boolean)?
  const xss_protection: string?                -- default "0"
  const content_type_nosniff: string?          -- default "nosniff"
  const x_frame_options: string?               -- default "SAMEORIGIN"
  const hsts_max_age: integer?                 -- default 0 (must be >= 0)
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

`hsts_max_age` must be `>= 0`; enabling `hsts_preload_enabled = true` together with `hsts_exclude_subdomains = true` is rejected at configuration time.

---

### 4. `mk.middleware.keyauth`

Extracts API keys or bearer tokens, delegates validation to a caller-supplied `validator`, and provides `constant_time_equal` for timing-safe secret checks.

```text
record CustomExtractor
function CustomExtractor.new(fn: function (mk.Context): (string?)): CustomExtractor
function CustomExtractor:to_transfer_payload(): string
function CustomExtractor.from_transfer_payload(payload: string): CustomExtractor

union Extractor
  auth_header(scheme: string)
  header(name: string)
  single_header(name: string)
  query(name: string)
  cookie(name: string)
  chain(items: {Extractor})
  custom(extractor: CustomExtractor)
end

record Config
  const next: (function (mk.Context): boolean)?
  const extractor: Extractor?                  -- default Extractor.auth_header("Bearer")
  const validator: function (mk.Context, string): boolean
  const realm: string?                         -- default "Restricted"
  const challenge: string?                     -- default 'ApiKey realm="Restricted"' when scheme absent
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

- Use `constant_time_equal(supplied, expected)` inside `validator` to avoid timing leaks on secret comparison.
- Downstream handlers retrieve the authenticated token via `keyauth.token_from_context(ctx)`.
- `CustomExtractor` implements `to_transfer_payload` / `from_transfer_payload` so custom extractors transfer cleanly into `pool` and `session` worker threads.

---

### 5. `mk.middleware.logger`

Emits structured JSON request logs via `ctx:logger()` or an optional `sink_sender`.

```text
union Phase
  completion()
  admission()
end
const PHASE_COMPLETION: Phase
const PHASE_ADMISSION: Phase

record Config
  const next: (function (mk.Context): boolean)?
  const skip: (function (mk.Context): boolean)?
  const sink_sender: thread.Sender<|string|>?  -- nil uses ctx:logger()
  const level: string?                         -- default "info"
  const event: string?                         -- default "http_request"
  const phase: Phase?                          -- default Phase.completion()
  const include_path: boolean?                 -- default false (logs declared route pattern or "<unmatched>")
  const include_request_id: boolean?           -- default true
  const extra_fields: (function (mk.Context): {string: value}?)?
end
function new(config: Config?): mk.Handler
```

- In `Phase.completion()` mode (default), registers a `ctx:on_complete` observer before calling `ctx:next()`, recording final response status and latency without catching or altering exceptions.
- `include_path` defaults to `false` to avoid logging sensitive URL parameters; by default it logs the declared route pattern (or `"<unmatched>"`).

---

### 6. `mk.middleware.recover`

Converts unexpected non-`HttpError` exceptions into HTTP error responses without swallowing cooperative cancellation.

```text
record Config
  const next: (function (mk.Context): boolean)?
  const enable_stack_trace: boolean?           -- default false
  const stack_trace_handler: (function (mk.Context, value, string): ())?
  const exception_handler: (function (mk.Context, value, string): mk.HttpError)?
end
function new(config: Config?): mk.Handler
```

- `mk.HttpError` values and `async.CancellationReason` pass straight through untouched.
- Unexpected exceptions invoke `stack_trace_handler` (when `enable_stack_trace = true`) and convert to an `HttpError` via `exception_handler` (or a default `500 Internal Server Error`).

---

### 7. `mk.middleware.requestid`

Extracts, validates, or generates a per-request correlation ID and writes it to the response header and `ctx:request_id()`.

```text
record Config
  const next: (function (mk.Context): boolean)?
  const header: string?                        -- default "X-Request-ID"
  const generator: (function (): string)?      -- default 16-byte CSPRNG hex via uv.random
end
function new(config: Config?): mk.Handler
function from_context(ctx: mk.Context): string
```

Inbound and generated IDs are validated as graphic ASCII VCHAR (`0x21..0x7E`, no spaces or control bytes, length `1..256`). If a custom `generator` returns an invalid ID, `requestid` retries it up to 3 times before falling back to a 16-byte CSPRNG hex token via `uv.random`.

---

### 8. `mk.middleware.responsetime`

Measures elapsed request latency and attaches a response header immediately before headers commit.

```text
record Config
  const next: (function (mk.Context): boolean)?
  const header: string?                        -- default "X-Response-Time"
end
function new(config: Config?): mk.Handler
```

Registers a `ctx:on_before_commit` hook before calling `ctx:next()`—never catching exceptions, and working uniformly across buffered, error, streaming, and WebSocket `101` responses.

---

### 9. `mk.middleware.static`

Serves static files (and optional directory listings) confined under a trusted root directory.

```text
record Config
  const next: (function (mk.Context): boolean)?
  const index_names: {string}?                 -- default {"index.html"}
  const browse: boolean?                       -- default false
  const byte_range: boolean?                   -- default false
  const download: boolean?                     -- default false
  const max_age: integer?                      -- default 0
  const modify_response: mk.Handler?
  const not_found_handler: mk.Handler?
end
function new(root: string, config: Config?): mk.Handler
```

- **Path selection (which path is served):**
  - If the matched route has a raw `*` or `+` wildcard capture (for example `app:get("/assets/*", static.new(root))`), `static` serves that wildcard capture (mapping `/assets/app.js` to `<root>/app.js`).
  - Otherwise, if mounted inside a sub-app via `App:mount`, `static` serves the path below `ctx:mount_path()`.
  - Otherwise, `static` serves the **full** request path (so `app:use_path("/assets", static.new(root))` maps `/assets/app.js` to `<root>/assets/app.js`).
- **Confinement and path validation:**
  - `new(root, config?)` validates `root ~= ""`, `max_age >= 0`, and each `index_names` entry as a single valid basename (non-empty, not equal to `.` or `..`, not a Windows reserved device name, and containing no `/`, `\`, `:`, or NUL).
  - `canonical_root = fs.realpath(root)` is resolved lazily per worker (`404` if missing or not a directory). Because `titan.fs` is path-based without `openat`/`O_NOFOLLOW`, `root` must be a deployment-trusted directory not concurrently mutated by untrusted local processes.
  - Non-`GET`/`HEAD` requests pass through to `ctx:next()`.
  - Selected paths split on `/`, skip empty raw segments, percent-decode each non-empty segment once (`400` on invalid `%XX`), and reject (`404` / `not_found_handler`) any decoded segment that is equal to `.` or `..`, contains NUL, `/`, `\`, or `:`, or matches a Windows reserved device name (`CON`, `PRN`, `AUX`, `NUL`, `COM1`..`COM9`, `LPT1`..`LPT9`, case-insensitive, with or without extension or trailing spaces).
  - Joined candidates require `fs.lstat` non-symlink leaves (or directories probing validated `index_names`) **and** `fs.realpath(candidate)` matching a strict path-component boundary under `canonical_root` (preventing sibling-prefix escapes such as `/srv/public2` under `/srv/public` and intermediate symlink escapes).
- **Serving behavior:**
  - Regular files emit MIME `Content-Type`, weak `ETag` and `Last-Modified` (`304 Not Modified` on conditional match), optional `Cache-Control` (`max_age`), `Content-Disposition` (`download`), and single-range `206`/`416` (`byte_range`), run `modify_response` before commit, and stream in 64 KiB chunks (`HEAD` omits body).
  - Directory `browse = true` HTML-escapes entry names (`&`, `<`, `>`, `"`, `'`), URL-encodes links with `router.percent_encode_segment`, and omits symlinks.

---

### 10. `mk.middleware.timeout`

Applies a cooperative execution deadline to a handler or downstream chain.

```text
record Config
  const next: (function (mk.Context): boolean)?
  const on_timeout: mk.Handler?
end
function new(handler: mk.Handler, timeout_ms: integer, config: Config?): mk.Handler
function middleware(timeout_ms: integer, config: Config?): mk.Handler
```

Both `new` (wrapping a specific handler) and `middleware` (wrapping `ctx:next()`) delegate to `ctx:run_with_timeout(timeout_ms, action, config.on_timeout)`, enforcing owner-Task revocation and abort-before-join cleanup inside `mk`. When `config.next(ctx)` returns `true`, `timeout.new` invokes `handler(ctx)` directly without a deadline, whereas `timeout.middleware` calls `ctx:next()`.
