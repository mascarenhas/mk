# How to Compose Middleware and Structured Logging

Compose `mk.Handler` middleware in registration order, configure
non-suspending JSON-line logging with `mk.log`, and enable the ten built-in
`mk.middleware.*` modules. See the
[`mk.log` Module Reference](../reference/mk-log.md) and
[`mk.middleware.*` Module Reference](../reference/mk-middleware.md) for
complete type signatures and defaults, and
[About the Request, Middleware, and Error Lifecycle](../explanation/request-lifecycle.md)
for the underlying execution model.

## Write and Order Middleware

Middleware handlers share the `mk.Handler` signature
(`function (mk.Context): ()`) and run strictly in registration order.
Register middleware before the routes it wraps; middleware registered after
a route runs only if that route explicitly calls `ctx:next()`.

Write custom middleware by calling `ctx:next()` to pass control downstream,
or return early (or raise `mk.HttpError`) to short-circuit the request:

```titan
local mk = import "mk"

local function require_json(ctx: mk.Context)
  if ctx:method() == "POST" and not ctx:is_json() then
    raise mk.HttpError(
      415, "application/json required", "unsupported_media_type"
    )
  end
  ctx:set_local("checked_media", true)
  ctx:next()
end
```

When middleware needs to inject a header right before commit or record
post-response metrics, attach observers with `ctx:on_before_commit` and
`ctx:on_complete` before calling `ctx:next()`. Both hook lists run in
last-in, first-out (LIFO) order:

- `ctx:on_before_commit(fn)` runs once before headers leave for the
  transport, covering buffered commits, `ctx:flush_headers()`, WebSocket
  `101` upgrades, handshake rejections, and `ctx:reject_upgrade()`.
- `ctx:on_complete(fn)` runs once after the response finishes, error
  handling completes, or the request aborts, fails, or cancels.

Use the following global order for standard services:

```titan
local mk = import "mk"
local helmet = import "mk.middleware.helmet"
local logger_mw = import "mk.middleware.logger"
local recover = import "mk.middleware.recover"
local requestid = import "mk.middleware.requestid"
local responsetime = import "mk.middleware.responsetime"

local function attach_core_stack(app: mk.App)
  app:use(
    requestid.new(),
    recover.new(),
    logger_mw.new(),
    responsetime.new(),
    helmet.new()
  )
end
```

Each position serves a specific dependency:

1. `requestid` runs first so every downstream log line, error response, and
   handler sees `ctx:request_id()`.
2. `recover` wraps the rest of the chain to convert unexpected exceptions
   into `500` `mk.HttpError` values before completion logging runs.
3. `logger` registers its completion observer outside route handlers so it
   records the final status produced by `recover` and `Config.error_handler`.
4. `responsetime` records its start timestamp before security headers and
   route work run, then writes `X-Response-Time` inside `on_before_commit`.
5. `helmet` sets baseline security headers before routes execute, allowing
   individual handlers to override specific headers when needed.

Scope middleware to a path prefix with `app:use_path("/api", mw)` or a
route group with `app:group("/api", mw)`. Prefixes match on whole path
segments only, so `"/api"` matches `"/api/items"` but not `"/apix"`. To
bypass a built-in middleware conditionally per request, pass a
`next: function (mk.Context): boolean` predicate in its `Config`; returning
`true` skips that middleware.

## Configure Structured Logging

Create a bounded `log.Logger`, attach it to `mk.Config`, and close it with
`defer` when the process exits. `mk` forwards worker-thread logs into
`Config.logger`, but `mk` never closes `Config.logger` itself:

```titan
local log = import "mk.log"
local mk = import "mk"

function main(_args: {string}): integer
  local app_logger = log.Logger("info")
  defer app_logger:close()

  local app = mk.App(mk.Config {
    app_name = "orders",
    logger = app_logger,
  })

  app:post("/orders", function (ctx: mk.Context)
    local fields: {string: value} = {
      ["request_id"] = ctx:request_id(),
      ["route"] = ctx:matched_route(),
    }
    ctx:log("info", "order_created", fields)
    ctx:status(201):send_string("created")
  end)

  app:listen("127.0.0.1:8080")
  return 0
end
```

`ctx:log(level, event, fields?)` is a no-op when `Config.logger` is `nil`
and works unchanged on parent, pool, and session workers. If you need the
underlying `log.Logger` directly, bind it as an optional so a `nil` logger
does not trigger a runtime nil assertion:

```titan
local logger? = ctx:logger()
if logger ~= nil then
  logger:warn("slow_upstream", { ["ms"] = 850 })
end
```

Adjust the queue size with `log.Logger.new("debug", nil, 4096)` when burst
volume exceeds the default `1024`-line queue, or supply a custom sink
function instead of `os.stderr:write`. For startup failures before a
`Logger` exists, call `log.fatal("startup_failed", reason)` to write one
JSON error line directly to `os.stderr`.

## Log Requests on Admission or Completion

Import `mk.middleware.logger` under an alias such as `logger_mw` so it does
not shadow a local `logger` variable. By default, `logger_mw.new()` runs in
`logger_mw.PHASE_COMPLETION`, emits `"http_request"` at `"info"` level,
omits the raw path, and includes `request_id` when set.

If neither `sink_sender` nor `Config.logger` is set, the logger middleware
acts as a no-op pass-through.

Use `skip` to suppress noisy routes such as health probes without disabling
other middleware, and enable `include_path = true` only when raw request
paths cannot expose tokens or sensitive identifiers:

```titan
local logger_mw = import "mk.middleware.logger"

local function skip_probes(ctx: mk.Context): boolean
  local p = ctx:path()
  return p == "/livez" or p == "/readyz"
end

app:use(logger_mw.new(logger_mw.Config {
  level = "info",
  skip = skip_probes,
  include_path = false,
  extra_fields = function (ctx: mk.Context): {string: value}?
    return { ["host"] = ctx:host() }
  end,
}))
```

Switch `phase` to `logger_mw.PHASE_ADMISSION` when you need a log line as
soon as a request enters the chain (for example, to trace long-lived
streams or WebSocket sessions before they finish). Admission logs use
`ctx:classified_route()` and emit before `ctx:next()`, so they omit
completion-only fields (`status`, `latency_ms`, `aborted`, and
`error_code`). Built-in field names always win over colliding keys returned
by `extra_fields`.

## Add Authentication, Headers, and Probes

### API-key and bearer authentication (`keyauth`)

Protect a group or route with `mk.middleware.keyauth` and compare secrets
using `keyauth.constant_time_equal` to avoid timing leaks. The default
extractor reads `Authorization: Bearer <token>`; pass `extractor` to read a
custom header, query parameter, cookie, fallback chain, or custom callback:

```titan
local keyauth = import "mk.middleware.keyauth"
local mk = import "mk"

local EXPECTED_KEY = "secret-api-key"

local api = app:group("/api", keyauth.new(keyauth.Config {
  extractor = keyauth.Extractor.chain({
    keyauth.Extractor.auth_header("Bearer"),
    keyauth.Extractor.single_header("X-API-Key"),
  }),
  validator = function (_ctx: mk.Context, token: string): boolean
    return keyauth.constant_time_equal(token, EXPECTED_KEY)
  end,
  realm = "Orders API",
}))

api:get("/me", function (ctx: mk.Context)
  local token = keyauth.token_from_context(ctx)
  local payload: {string: value} = { ["token_len"] = #token }
  ctx:json(payload)
end)
```

Use `Extractor.single_header` instead of `Extractor.header` when duplicate
headers should be rejected as missing rather than resolved by first value.

### Security headers (`helmet`)

`helmet.new()` sets eleven defensive headers before `ctx:next()`, and those
headers remain attached even when `Config.error_handler` renders an error
because `ctx:reset_body()` preserves response headers. Set any string field
to `""` to suppress that header, and configure HSTS only for TLS traffic:

```titan
local helmet = import "mk.middleware.helmet"

app:use(helmet.new(helmet.Config {
  content_security_policy = "default-src 'self'",
  hsts_max_age = 31536000,
  x_frame_options = "",
}))
```

`Strict-Transport-Security` is emitted only when `hsts_max_age > 0` and
`ctx:secure()` is `true` (direct TLS or `X-Forwarded-Proto: https` with
`trust_forwarded_headers = true`). Setting `hsts_preload_enabled = true`
together with `hsts_exclude_subdomains = true` raises at configuration time.

### Health probes (`healthcheck`) and environment inspection (`env`)

Register readiness and liveness probes with the standard endpoint constants:

```titan
local healthcheck = import "mk.middleware.healthcheck"

app:get(healthcheck.LIVENESS_ENDPOINT, healthcheck.new())
app:get(healthcheck.READINESS_ENDPOINT, healthcheck.new(
  healthcheck.Config {
    probe = function (_ctx: mk.Context): boolean
      return true
    end,
    response_format = healthcheck.FORMAT_JSON,
  }
))
```

If an operations endpoint needs to expose selected environment variables,
mount `mk.middleware.env` behind authentication or an internal route with an
explicit allowlist and defaults:

```titan
local env = import "mk.middleware.env"

internal:get("/env", env.new(env.Config {
  export_vars = { ["APP_ENV"] = "development" },
}))
```

### Panic recovery, request IDs, and response timing

- **`recover`**: pass `recover.Config { enable_stack_trace = true }` to log
  `"panic_recovered"` via `ctx:log` (falling back to `os.stderr` when no
  logger is set), or supply `stack_trace_handler` and `exception_handler`.
  `mk.HttpError` and `async.CancellationReason` always propagate untouched.
- **`requestid`**: override `header` (must be a valid HTTP token) or pass a
  custom `generator`. Incoming IDs are reused if they are `1`–`256` graphic
  ASCII bytes (`0x21`–`0x7E`); otherwise `generator` gets up to `3` total
  attempts before falling back to `16` random bytes formatted as `32`
  lowercase hex characters.
- **`responsetime`**: customize the output header name with
  `responsetime.Config { header = "X-Duration" }`.

## Enforce Handler Timeouts

Choose between two constructors in `mk.middleware.timeout`:

- `timeout.new(handler, timeout_ms, cfg?)` wraps a single route handler.
  When `cfg.next(ctx)` returns `true`, it invokes `handler(ctx)` directly
  with no deadline.
- `timeout.middleware(timeout_ms, cfg?)` wraps the rest of the downstream
  middleware and route chain. When `cfg.next(ctx)` returns `true`, it calls
  `ctx:next()` with no deadline.

```titan
local mk = import "mk"
local timeout = import "mk.middleware.timeout"

app:get(
  "/reports",
  timeout.new(generate_report, 2000, timeout.Config {
    on_timeout = function (ctx: mk.Context)
      ctx:status(504):send_string("report timed out")
    end,
  })
)
```

Passing `timeout_ms = 0` disables the deadline and runs inline. When a
deadline expires before headers are committed, `mk` aborts any blocked
transport, cancels and joins the handler Task, resets the buffered body,
and runs `on_timeout(ctx)` (or raises
`mk.HttpError(503, "Service Unavailable", "timeout")`). If the response was
already committed or aborted before expiry, `mk` aborts any unfinished stream
and returns without calling `on_timeout` or raising `503`.

Never pass `ctx` into a Task you spawn yourself. Calling mutating methods on
`ctx` from any Task other than its current owner—including a timed-out
child Task after expiry—raises `"context ownership revoked"`.

## Serve Static Files Safely

Mount `mk.middleware.static` on a wildcard route or inside an `App:mount`
sub-app rather than directly on `app:use_path`:

```titan
local static = import "mk.middleware.static"

app:get("/assets/*", static.new("./public", static.Config {
  max_age = 3600,
  byte_range = true,
}))
```

`static.new(root, cfg?)` selects the relative path to serve using a fixed
three-step precedence:

1. If the matched route contains a `*` or `+` wildcard, `static` uses the
   raw wildcard capture (`/assets/app.js` maps to `./public/app.js`).
2. Otherwise, if inside a sub-app mounted via `App:mount`, `static` uses
   the raw path below `ctx:mount_path()`.
3. Otherwise, `static` uses the full raw request path. Registering
   `app:use_path("/assets", static.new("./public"))` maps `/assets/app.js`
   to `./public/assets/app.js`, not `./public/app.js`.

Account for two behaviors before exposing a directory:

- **No fall-through on misses:** Missing files, rejected basenames, and
  symlink leaves raise `mk.HttpError(404)` (or invoke `not_found_handler`)
  instead of calling `ctx:next()`. If you mount `static` globally with
  `app:use(...)` alongside dynamic routes, supply a `not_found_handler` that
  calls `ctx:next()`:

  ```titan
  app:use(static.new("./public", static.Config {
    not_found_handler = function (ctx: mk.Context)
      ctx:next()
    end,
  }))
  ```

- **Dotfiles are served and listed:** `static` has no hidden-file filter.
  Keep `.env`, `.git`, and private configuration files outside `root`, and
  ensure `root` is a deployment-trusted directory not concurrently modified
  by untrusted local processes.

Pass `index_names = {}` to disable automatic `index.html` resolution, set
`browse = true` to render HTML directory listings (symlinks are omitted),
and use `modify_response` to add custom headers before file bytes stream in
`64 KiB` chunks. For all conditional-request (`ETag`, `If-None-Match`,
`If-Modified-Since`) and range rules, see the
[`mk.middleware.*` Module Reference](../reference/mk-middleware.md#mkmiddlewarestatic).
