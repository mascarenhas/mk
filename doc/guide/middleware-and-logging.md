# Chapter 3: Middleware and Logging

This chapter covers how `titan-mk`'s middleware chain executes, how `on_before_commit` and `on_complete` hooks observe responses without intercepting exceptions, how `mk.log` handles bounded non-suspending JSON logging across threads, and how to compose the 10 built-in middleware modules.

For exact signatures, defaults, and error messages, see the [`mk.log`](../reference/mk-log.md) and [`mk.middleware.*`](../reference/mk-middleware.md) references.

## How the Middleware Chain Executes

Middleware functions have the same `mk.Handler` type as route handlers (`function (mk.Context): ()`). Register them globally with `app:use(...)`, on a path prefix with `app:use_path("/api", ...)`, on a [`Group`](routing-and-handlers.md#groups-group-and-groupoptions), or inline ahead of an endpoint handler (`app:post("/items", auth_mw, create_item)`).

Each middleware calls `ctx:next()` to continue down the chain:

```titan
local function require_json(ctx: mk.Context)
  if ctx:method() == "POST" and not ctx:is_json() then
    raise mk.HttpError(415, "JSON required", "unsupported_media_type")
  end
  ctx:next()
end
```

- Calling `ctx:next()` runs the next matching middleware or endpoint in registration order.
- Returning **without** calling `ctx:next()` short-circuits the rest of the chain and commits whatever response was staged.
- Most built-in middleware `Config` records accept `next: (function (mk.Context): boolean)?`: when `next(ctx)` returns `true`, the middleware skips its own work and calls `ctx:next()` (the sole exception is `timeout.new(handler, ...)`, which invokes its wrapped `handler(ctx)` directly without a deadline).

## Non-Intercepting Observers: `on_before_commit` and `on_complete`

In GoFiber-style frameworks, wrapping `ctx:next()` in a `try`/`catch` inside every logging or timing middleware creates brittle ordering bugs with `Config.error_handler`. `titan-mk` solves this with two explicit observer hooks on `Context`:

- **`ctx:on_before_commit(hook)`:** Runs immediately before response headers leave the server—across buffered responses, error-handler responses, streamed `flush_headers()` / `write_chunk()`, and WebSocket `101` handshakes. Hooks may read `ctx:status_code()` and add or update response headers. `mk.middleware.responsetime` uses this hook so `X-Response-Time` appears on error responses and streams alike without touching exceptions.
- **`ctx:on_complete(hook)`:** Runs in **LIFO order** after the response finishes or aborts, including after `Config.error_handler`, unhandled exceptions, or Task cancellation. Failures inside an `on_complete` hook are logged as `"on_complete_failed"` without replacing the request outcome, while `async.CancellationReason` propagates. `mk.middleware.logger` uses this hook in `PHASE_COMPLETION` mode so logged statuses always reflect the final wire status.

## Recommended Stack Order

Register outer correlation, recovery, and observability middleware before security headers, auth, deadlines, and endpoints:

```titan
local mk = import "mk"
local helmet = import "mk.middleware.helmet"
local logger_mw = import "mk.middleware.logger"
local recover = import "mk.middleware.recover"
local requestid = import "mk.middleware.requestid"
local responsetime = import "mk.middleware.responsetime"

app:use(
  requestid.new(),      -- 1. establish X-Request-ID first
  recover.new(),        -- 2. convert unexpected panics to 500 HttpError
  logger_mw.new(),      -- 3. observe final status/latency via on_complete
  responsetime.new(),   -- 4. attach X-Response-Time via on_before_commit
  helmet.new()          -- 5. apply default security response headers
)
```

Because `logger` and `responsetime` register non-intercepting hooks rather than catching errors, `recover` converts unexpected failures to `mk.HttpError(500, nil, "internal_error", failure)`, `Config.error_handler` formats the `500` response, `responsetime` stamps `X-Response-Time` before commit, and `logger` logs status `500`, `error_code = "internal_error"`, and `request_id` on completion.

## Structured JSON-Line Logging (`mk.log`)

`mk.log` writes strictly JSON-encoded lines terminated by `\n` (capped at `16384` bytes), each carrying `event`, `level`, and UTC ISO-8601 `timestamp` plus optional fields:

```titan
local log = import "mk.log"

local app_logger = log.Logger("info")
defer app_logger:close()

app_logger:info("service_ready", { ["port"] = 8080 })
```

Key design properties:

- **Non-suspending admission:** `emit` / `info` / `error` / `accept` never yield; they enqueue into a bounded buffer (`1024` lines by default) drained in order by one owned writer Task.
- **Drop accounting instead of backpressure stalls:** If the queue fills, encoding fails (invalid UTF-8, cycles, oversized lines), or a non-blocking sink refuses a line, callers never fail or stall—the logger increments a drop counter and the writer Task emits `{"event":"log_dropped","level":"error","count":N,"timestamp":"..."}` around its next delivered line or at `Logger:close()`.
- **Automatic cross-thread forwarding:** Passing `logger = app_logger` in `mk.Config` automatically wires a non-blocking `log.forward(...)` logger into every `pool` and `session` worker (`wctx.logger`, `ctx:logger()`, `ctx:log(...)`). Always `defer app_logger:close()` in `main` so buffered lines flush before exit.

## Composing the 10 Built-in Middlewares

### Request Logging: Admission vs. Completion

`mk.middleware.logger` supports two phases via `Phase`:

- **`PHASE_COMPLETION` (default):** Registers `ctx:on_complete` before `ctx:next()`. Logs `method` (standard HTTP method or `"OTHER"`), `route` (`ctx:matched_route()`, or `"<unmatched>"`), `status`, `latency_ms`, optional `aborted` (`true` when aborted), `error_code` (from `ctx:last_error()`), `request_id` (unless disabled), `worker_id` (on workers), and `path` (only when `include_path = true`, keeping URL parameters out of logs by default).
- **`PHASE_ADMISSION`:** Writes the log line *before* calling `ctx:next()`, using `ctx:classified_route()` (the route pattern classified at dispatch, known before endpoint handlers execute) so even outer middleware sees the matched route pattern.

Use `skip` (evaluated when a line would be written) to suppress noisy health-probe logs without skipping downstream work.

### Error Recovery and Deadlines

- **`mk.middleware.recover`:** Catches unexpected non-`HttpError` exceptions while letting `mk.HttpError` and `async.CancellationReason` propagate untouched with their original tracebacks. Enable `enable_stack_trace = true` to log `"panic_recovered"` via `ctx:logger()` (or stderr) with the traceback, or supply custom `stack_trace_handler` / `exception_handler`.
- **`mk.middleware.timeout`:** Wraps either one handler (`timeout.new(handler, 5000)`) or the rest of the chain (`timeout.middleware(5000)`) using `ctx:run_with_timeout(...)`. When the deadline expires, `mk` revokes `Context` ownership from the timed-out Task, aborts blocked socket I/O before joining, and runs `on_timeout` (default `HttpError(503, ..., "timeout")`).

### Authentication, Security Headers, and Probes

- **`mk.middleware.keyauth`:** Extracts tokens from `Authorization` (`auth_header("Bearer")`), `header`, `single_header`, `query`, `cookie`, a `chain` of extractors, or a transferable `CustomExtractor`, then delegates secret verification to your `validator(ctx, key)` callback (use `keyauth.constant_time_equal(key, expected)` inside `validator` for timing-safe comparison). On rejection, sets `WWW-Authenticate` and raises `401` (`"missing_api_key"` or `"invalid_api_key"`). Downstream handlers read the validated key via `keyauth.token_from_context(ctx)`.
- **`mk.middleware.helmet`:** Sets conservative GoFiber-style security response headers (`X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `Cross-Origin-*`, optional `Content-Security-Policy` / report-only, and HTTPS-only `Strict-Transport-Security` when `hsts_max_age > 0`). Pass `""` for any header field to omit it.
- **`mk.middleware.healthcheck`:** Mount at `LIVENESS_ENDPOINT` (`"/livez"`), `READINESS_ENDPOINT` (`"/readyz"`), or `STARTUP_ENDPOINT` (`"/startupz"`). Responds to `GET`/`HEAD` with `Cache-Control: no-store` and `200` / `503` in plain text (`FORMAT_TEXT`) or JSON (`FORMAT_JSON`).
- **`mk.middleware.env`:** Mount on an internal admin route to return `{"vars": {...}}` for an explicit allowlist of environment variables (`GET`/`HEAD` only; other methods return `405` with `Allow: GET, HEAD`).

### Confined Static File Serving (`mk.middleware.static`)

Always pay attention to **which path `static` serves**:

1. **Wildcard route (recommended for prefixed assets):** `app:get("/assets/*", static.new("/srv/public"))` serves the raw `*`/`+` wildcard capture, mapping `/assets/app.js` to `/srv/public/app.js`.
2. **Mounted sub-app:** Inside `app:mount("/assets", sub_app)`, `static` serves the path below `ctx:mount_path()`.
3. **Full path fallback:** `app:use_path("/assets", static.new("/srv/public"))` has neither a wildcard nor a mount path, so it serves the **full** request path—mapping `/assets/app.js` to `/srv/public/assets/app.js`.

`static` enforces strict confinement (`fs.lstat` non-symlink leaf + `fs.realpath` component-boundary check under `canonical_root`), validates basenames and Windows reserved device names, supports conditional `ETag`/`Last-Modified` (`304`), optional single-range `206`/`416`, `max_age` caching, `download`, `browse` HTML directory listings, and 64 KiB streaming.

Next: [Chapter 4: Workers and Sessions](workers-and-sessions.md).
