---
name: titan-mk
description: Build, configure, review, and test HTTP/1.1 services in Titan 0.6 (tested on 0.6.1) using titan-mk 0.1.1 (mk, mk.router, mk.log, and the 10 mk.middleware.* modules). Covers PEG route registration without inline constraints, Context and JSON-only Bind with logical module names, HttpError flow, buffered, streaming, and WebSocket handlers, OS worker thread pools and sessions with Titan closure transfer rules, structured JSON-line logging, App:test vs App:listen_test, and LuaRocks and static consumer linking. Load alongside titan-programmer when writing .titan code that imports mk.
---

# Using `titan-mk`

Use this skill when writing, reviewing, or testing Titan 0.6 (tested on 0.6.1) applications that import `mk`, `mk.router`, `mk.log`, or `mk.middleware.*` from `titan-mk 0.1.1`. Load `titan-programmer` first for core Titan syntax, types, and idioms.

## Navigate the Installed Manual

When `titan-mk` is installed via LuaRocks, `doc/` and `skills/` live side by side in the rock directory (`luarocks show --rock-dir titan-mk`). The online edition lives at `https://mk.titan-lang.dev`.

| Need | Read |
| --- | --- |
| Manual map and scope boundaries | [`doc/index.md`](../../doc/index.md) |
| Step-by-step first HTTP service | [`doc/tutorials/first-service.md`](../../doc/tutorials/first-service.md) |
| Install, consumer layout, `--static` linking | [`doc/how-to/install-and-build.md`](../../doc/how-to/install-and-build.md) |
| Routing, `Context`, JSON `Bind`, `HttpError` | [`doc/how-to/routes-and-json-apis.md`](../../doc/how-to/routes-and-json-apis.md) |
| Middleware stack, `mk.log`, static serving, timeouts | [`doc/how-to/middleware-and-logging.md`](../../doc/how-to/middleware-and-logging.md) |
| Streaming responses, raw bodies, WebSockets | [`doc/how-to/streaming-and-websockets.md`](../../doc/how-to/streaming-and-websockets.md) |
| Worker pools, sessions, `on_start`, shutdown | [`doc/how-to/worker-threads-and-sessions.md`](../../doc/how-to/worker-threads-and-sessions.md) |
| `App:test`, `App:listen_test`, line coverage | [`doc/how-to/testing-and-coverage.md`](../../doc/how-to/testing-and-coverage.md) |
| Exact `mk` API signatures and defaults | [`doc/reference/mk.md`](../../doc/reference/mk.md) |
| Exact `mk.router` grammar and `RouteError` codes | [`doc/reference/mk-router.md`](../../doc/reference/mk-router.md) |
| Exact `mk.log` API and drop rules | [`doc/reference/mk-log.md`](../../doc/reference/mk-log.md) |
| Exact `mk.middleware.*` APIs (all 10 modules) | [`doc/reference/mk-middleware.md`](../../doc/reference/mk-middleware.md) |
| PEG routing design and why constraints are rejected | [`doc/explanation/peg-routing.md`](../../doc/explanation/peg-routing.md) |
| Request, observer, `Bind`, and error lifecycle | [`doc/explanation/request-lifecycle.md`](../../doc/explanation/request-lifecycle.md) |
| Shared-nothing worker and closure-transfer model | [`doc/explanation/worker-architecture.md`](../../doc/explanation/worker-architecture.md) |

## Quickstart Pattern

Keep `build_app` and request record types in a library module (for example `src/service/app.titan`, logical module `"service.app"`) and keep `main` in `src/service/main.titan`. That lets native tests import `"service.app"` without importing a `main` entry point and keeps `ctx:bind():named(...)` logical module names unambiguous. Because `mk` imports `titan.uv`, standalone executables start Titan's async bootstrap automatically—never call `async.loop()` inside `main` or handlers.

```titan
-- src/service/app.titan (logical module: "service.app")
local mk = import "mk"
local log = import "mk.log"
local recover = import "mk.middleware.recover"
local requestid = import "mk.middleware.requestid"
local logger_mw = import "mk.middleware.logger"

record ItemInput
  const title: string
end

local function create_item(ctx: mk.Context)
  -- Always pass the full logical module name + record name.
  local input = ctx:bind():named("service.app.ItemInput") as ItemInput
  local out: {string: string} = {
    ["title"] = input.title,
    ["request_id"] = ctx:request_id(),
  }
  ctx:status(201):json(out)
end

function build_app(app_logger: log.Logger?): mk.App
  local app = mk.App(mk.Config {
    app_name = "demo",
    logger = app_logger,
    error_handler = mk.json_error_handler,
  })
  app:use(requestid.new(), recover.new(), logger_mw.new())
  app:post("/items", create_item):name("items.create")
  return app
end
```

```titan
-- src/service/main.titan
local log = import "mk.log"
local service = import "service.app"

function main(_args: {string}): integer
  local app_logger = log.Logger("info")
  defer app_logger:close()
  local app = service.build_app(app_logger)
  app:listen("127.0.0.1:8080")
  return 0
end
```

## Non-Negotiable Rules & Footguns

### 1. Routing (`mk.router`)
- **No inline routing constraints:** `:id<int>` is rejected at registration time with `RouteError.code == "routing_constraints_unsupported"`. Validate in the handler (`ctx:param_int("id")`).
- **Tokens:** `:name`, `:name?`, `*` (`"*"` / `"*1"`), `+` (`"+"` / `"+1"`), escapes `\:`, `\?`, `\*`, `\+`, `\\`, `\<`, literal `::name`, atomic `%XX` (`%00` forbidden). A whole-segment `/*` makes the leading `/` optional (`/assets/*` matches `/assets` with `* == ""`).
- **Two-tier matching:** Deterministic routes compile to a single-pass `peg.Pattern`. Prefix middleware containing wildcards, in-segment wildcards or delimiters, optional params, or multiple or non-terminal wildcards use the `O((M + L) · A)` general evaluator.
- **Defaults, `404`, and `405`:** `case_sensitive = false`, `strict_routing = false`, `unescape_path = true`, `auto_head = true` (explicit `HEAD` or `all(...)` wins over `GET` fallback). When the middleware chain exhausts without an endpoint running, path-matching routes (`*` excluded) produce `405` with first-occurrence deduplicated `Allow`; otherwise `404` with message `"Cannot <METHOD> <path>"`. Both carry `code == nil`.
- **Route freeze & mounts:** Register all middleware, groups, mounts, and routes before `App:start()`, `App:listen()`, or `App:test()`. `App:mount` snapshots the sub-app at call time; mounted route names are not prefixed, and the parent's `on_route` hooks fire for mounted routes.
- **Malformed targets:** Malformed request targets do not auto-`400`; `ctx:target_error()` exposes the reason and routing matches the raw path.

### 2. `Context`, JSON-Only `Bind`, Responses, and `HttpError`
- **JSON-only body binding with exact logical names:** `ctx:bind()` decodes JSON only (`json`, `named`, `object`, `array`). Pass the full logical module name to `named(...)` (for `src/service/app.titan`, `"service.app.ItemInput"`—not `"service.ItemInput"`). Never invent form or query struct binders; use `ctx:param*`, `ctx:query*`, `ctx:get`, and `ctx:cookie*`.
- **Exact `Bind` errors:** `415` (`not ctx:is_json()`), `413` (`> body_limit`; sets `Connection: close` before commit so `titan.http` skips unread-body drain and closes normally without aborting), `400` (empty body `"empty_body"` or JSON syntax, UTF-8, escape, duplicate-key, or limit error), `422` (schema or type mismatch). Programmer schema or option bugs (`unknown_type`, `constructor_unavailable`, `unsupported_type`, `invalid_option`) and non-`json.Error` constructor errors **re-raise unchanged**.
- **Map literals & content types:** `ctx:json(val)` takes `value`, which gives no contextual Map type—annotate the local (`local body: {string: value} = { ... }`) or pass a nominal `record`. `ctx:json` sets `application/json` (no charset), whereas `ctx:type("json")` sets `application/json; charset=utf-8`. `send_string` preserves an existing `Content-Type`; `html` overwrites it; `redirect` defaults to `303`.
- **`send_file` streams and is unconfined:** `ctx:send_file(path)` commits headers immediately and streams through `send_stream`—it is **not** buffered, so `status`/`set` afterward raise `"mk: response headers have already been committed"`. It also follows symlinks (`fs.stat`); use `mk.middleware.static` for user-supplied paths.
- **Task ownership:** Using `ctx` from a different Task raises `"context ownership revoked"`.
- **Errors & `json_error_handler`:** Signal expected HTTP failures with `raise mk.HttpError(status, message?, code?, cause?)`. Statuses outside `200..999` normalize to `500` first (defaulting message to `"Internal Server Error"`). `json_error_handler` emits sorted keys (`code`, `message`, `status`) and omits `code` when `nil`. Never swallow `async.CancellationReason`.
- **Observers, route, and peer metadata:** Both `ctx:on_before_commit` (header mutation before wire write, including before `reject_upgrade`) and `ctx:on_complete` (post-response observation) run in **LIFO order**. `ctx:classified_route()` exposes the dispatched route pattern even before endpoint execution. `ctx:peer_address()` and `meta:peer_address()` return the direct socket `net.Address?` (`nil` in `App:test` or if disconnected before capture; `X-Forwarded-For` and `trusted_proxies` are intentionally omitted). `Config.trust_forwarded_headers` defaults to `false`; enable only behind a trusted reverse proxy stripping client `X-Forwarded-Proto` and `X-Forwarded-Host`.
- **Optional logger bindings and closing:** `ctx:logger()` and `wctx.logger` are `log.Logger?` (`nil` when `Config.logger` is omitted). Bind them with `local logger? = ctx:logger()` or `local logger? = wctx.logger` (omitting `?` asserts non-nil and raises when unset), or call `ctx:log(...)` which no-ops without a logger. `mk` never closes `Config.logger`—always `defer app_logger:close()` in the application.

### 3. Worker Threads (`WorkerMode`) and Transfer Constraints
- **Modes & identity (critical):** `WorkerMode` values are unions that compare by **identity**. Two separate calls to `WorkerMode.pool(...)` or `WorkerMode.session(...)` create **separate** dispatchers and thread pools. Bind one `WorkerMode` to a local variable and reuse that same value across routes or groups to share a pool.
- **Lazy option validation:** `Config.workers` is validated in `App.new`; route and group `PoolOptions`/`SessionOptions` are validated at route freeze.
- **Per-worker state:** Store DB pools, `http.Client` handles, and caches in module-level `local` variables initialized in `on_start(wctx)` and closed in `wctx:defer_cleanup(fn)` (LIFO). `App:start()` blocks until every pool worker finishes `on_start` and fails with `"mk: pool worker N failed to start: ..."` if one errors.
- **What crosses to workers and closure transfer rules:** Every overlapping middleware (**all** middleware when `Config.workers` is a pool or session), every worker route handler, `Config.error_handler` (always), `on_start`, and any user closures inside middleware `Config` records must be transferable:
  - *Allowed captures:* scalars, plain transferable public records and unions, transferable closures, mutable upvalues (copied as fresh independent cells, losing aliasing), packet-scoped reference-counted endpoints (`thread.Sender<|T|>`, `thread.Receiver<|T|>`), and manual-handoff records with custom transfer hooks (such as `net.Connection`, `ssl.Connection`, `fs.File`, `sqlite3.Connection`, `http.Exchange`, and `websocket.Connection`, which detach source ownership).
  - *Rejected captures:* cycles, direct Arrays or Maps, Interfaces, `owned` foreign storage, `local` nominal types, non-nil Lua Udata, Lua closures, C closures with upvalues, and hookless records with `local` fields (`http.Server`, `mk.App`).
  - *Parent-only:* `SessionOptions.session_id` and `on_exit` never cross threads.
  - `mk` wraps callbacks with `TransferableHandler`, `TransferableErrorHandler`, and `TransferableWorkerInit` (and `keyauth.CustomExtractor` for custom extractors).
- **Session selector, idle lifetime, and retirement:** Return `nil` (never `""`) from `SessionExtractor` when a request has no session. If `session_id` raises `mk.HttpError` (or `503` `no_workers`, `max_sessions`, or `shutting_down`, or `500` `no_session`), `mk` runs the parent-reachable middleware chain first before `Config.error_handler`; non-`HttpError` exceptions from a selector escape the `http` handler. Session workers have **no idle eviction** (one OS thread lives until `ctx:retire_worker()`, `App:stop_worker`, crash, or shutdown). Call `ctx:retire_worker()` in a session handler for immediate causal retirement (no-op on `parent` and `pool`). Keep-alive connections stay on the worker under `idle_timeout_ms` until the next request's headers are parsed, then return via `return_pipe` for fresh parent classification. Pool worker exit outside shutdown **fails the whole `App`**; session worker exit stays isolated to that session and runs `on_exit` after OS join.
- **Shutdown and hooks:** Call `app:initiate_shutdown()` inside handlers, hooks, or monitors (non-blocking). `app:shutdown()` waits for retirement and **raises** if called from an active handler or lifecycle hook. `shutdown_timeout_ms` bounds only parent in-flight requests—worker in-flight requests get no drain grace period. `on_pre_shutdown` and `on_post_shutdown` also run during startup rollback (where `on_post_shutdown` receives `nil`) and on `App:shutdown()` of a never-started `App` (after which `App:start()` raises `"already been started"`), so keep hook teardown idempotent.

### 4. Built-in Middleware Quick Reference (`mk.middleware.*`)

| Module | Key notes |
| --- | --- |
| `env` | `GET` and `HEAD` `{"vars":{...}}` from explicit `export_vars` allowlist; other methods `405` with `Allow: GET, HEAD`. |
| `healthcheck` | `LIVENESS_ENDPOINT` (`"/livez"`), `READINESS_ENDPOINT`, `STARTUP_ENDPOINT`; `FORMAT_TEXT` and `FORMAT_JSON`; `Cache-Control: no-store`. |
| `helmet` | Security headers; `""` omits a header; HSTS (`hsts_max_age > 0`) emitted on `ctx:secure()` only. |
| `keyauth` | `Extractor.{auth_header, header, single_header, query, cookie, chain, custom}`; delegates check to `validator` (use `keyauth.constant_time_equal`); `token_from_context(ctx)`. |
| `logger` | Pass-through when neither `sink_sender` nor `Config.logger` is set. `PHASE_COMPLETION` (`on_complete`, `matched_route()` with `classified_route()` fallback before `"<unmatched>"`) or `PHASE_ADMISSION` (`classified_route()`); `include_path` defaults `false`; built-in fields win over `extra_fields`. |
| `recover` | Converts non-`HttpError` exceptions to `500` (`"internal_error"`); preserves `HttpError` and `async.CancellationReason`. |
| `requestid` | Validates VCHAR `0x21..0x7E` (`1..256`), up to **3 total generator attempts**, then 16-byte CSPRNG hex fallback; `from_context(ctx)` and `ctx:request_id()`. |
| `responsetime` | Sets `X-Response-Time` (`%.3fms`) via `on_before_commit`. |
| `static` | Path served: matched `*` or `+` wildcard first (`app:get("/assets/*", static.new(root))`), else below `ctx:mount_path()`, else full request path (`use_path` does **not** strip prefix). Does **not** fall through on misses (raises `404` unless `not_found_handler` calls `ctx:next()`), **serves and lists dotfiles**, applies `byte_range` to `GET` only, and enforces `lstat` + `realpath` confinement. |
| `timeout` | `timeout.new(handler, ms, cfg?)` (when `next(ctx)` is `true`, calls `handler(ctx)` without deadline) vs `timeout.middleware(ms, cfg?)` (when `next(ctx)` is `true`, calls `ctx:next()`). Already committed or aborted responses return at expiry without calling `on_timeout` or raising `503`. |

## Testing and Building Consumers

- **In-memory (`parent` routes only):** `app:test(mk.TestRequest("GET", "/path"), mk.TestConfig?)` — **raises** on routes dispatched to `pool` or `session` workers; `ctx:upgrade_websocket(...)` raises `HttpError(501, ..., "upgrade_unavailable")` inside the handler, returning a **`501` response** via the error handler. Defaults: `Host: example.com`, auto `Content-Length`, uppercased method, `1000 ms` timeout with `fail_on_timeout = true` (raises `"mk: App:test timed out after 1000 ms"`; set `fail_on_timeout = false` to return committed output or `TestResponse(0, <empty headers>, "")` if nothing committed).
- **Real loopback (workers, TLS, keep-alive, streaming, WebSockets):** `local ts = app:listen_test(); defer ts:close(); ts:request("GET", "/path")` (binds ephemeral `127.0.0.1:0`; `App:start("127.0.0.1:0")` likewise populates `ListenData.port` with the OS-assigned port; note `listen_test` swallows the fatal `serve` error).
- **Native test filter syntax:** `./build/my-tests --filter=PATTERN` or `-f PATTERN` (repeatable Lua patterns, OR semantics).
- **Dynamic consumer build:** `titanc --incremental --tree src -o build --exe build/app service.main`.
- **Static consumer build (`--static` on Linux and macOS with system-OpenSSL SDK):**
  ```sh
  TITAN_EXTRA_CPPFLAGS="$(pkg-config --cflags openssl)" \
  TITAN_EXTRA_LDFLAGS="$(pkg-config --libs openssl)" \
    titanc --static --tree src -o build --exe build/app service.main
  ```
  (Bundled-OpenSSL SDKs require no extra OpenSSL flags.)
- **Install and uninstall rock:** `luarocks install titan-mk` (or `luarocks make titan-mk-0.1.1-1.rockspec` from a checkout); remove with `titan-uninstall titan-mk` (`titan-uninstall.bat titan-mk` on Windows).
