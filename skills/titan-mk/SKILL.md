---
name: titan-mk
description: Build, configure, review, and test HTTP/1.1 services in Titan 0.6.0 using the titan-mk micro-framework (mk, mk.router, mk.log, and the 10 mk.middleware.* modules). Covers PEG route registration without inline constraints, Context and JSON-only Bind, HttpError flow, buffered/streaming/WebSocket handlers, OS worker thread pools and sessions with Titan closure transfer constraints, structured JSON-line logging, App:test vs App:listen_test, and LuaRocks/static consumer linking. Load alongside titan-programmer when writing .titan code that imports mk.
---

# Using `titan-mk`

Use this skill when writing, reviewing, or testing Titan 0.6.0 applications that import `mk`, `mk.router`, `mk.log`, or `mk.middleware.*`. Load `titan-programmer` first for core Titan syntax, types, and idioms.

## Navigate the Installed Manual

When `titan-mk` is installed via LuaRocks, `doc/` and `skills/` live side by side in the rock directory:

| Need | Read |
| --- | --- |
| Full manual map & scope boundaries | [`doc/index.md`](../../doc/index.md) |
| Install, project layout, `--static` linking, tests | [`doc/guide/getting-started.md`](../../doc/guide/getting-started.md) |
| Routing, `Context`, JSON `Bind`, errors, streams, WebSockets | [`doc/guide/routing-and-handlers.md`](../../doc/guide/routing-and-handlers.md) |
| Middleware ordering, hooks, `mk.log`, built-in middlewares | [`doc/guide/middleware-and-logging.md`](../../doc/guide/middleware-and-logging.md) |
| `parent`/`pool`/`session`, `on_start`, transfer rules, shutdown | [`doc/guide/workers-and-sessions.md`](../../doc/guide/workers-and-sessions.md) |
| Exact `mk` API signatures & defaults | [`doc/reference/mk.md`](../../doc/reference/mk.md) |
| Exact `mk.router` grammar & `RouteError` codes | [`doc/reference/mk-router.md`](../../doc/reference/mk-router.md) |
| Exact `mk.log` API & drop rules | [`doc/reference/mk-log.md`](../../doc/reference/mk-log.md) |
| Exact `mk.middleware.*` APIs (all 10 modules) | [`doc/reference/mk-middleware.md`](../../doc/reference/mk-middleware.md) |

## Quickstart Pattern

Separate `build_app` from `main` so native tests reuse the exact same routing and middleware setup. Do not wrap `async.loop()` around `main`—Titan's async bootstrap runs automatically.

```titan
local mk = import "mk"
local log = import "mk.log"
local recover = import "mk.middleware.recover"
local requestid = import "mk.middleware.requestid"
local logger_mw = import "mk.middleware.logger"

record ItemInput
  const title: string
end

local function create_item(ctx: mk.Context)
  local input = ctx:bind():named("app.ItemInput") as ItemInput
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

function main(_args: {string}): integer
  local app_logger = log.Logger("info")
  defer app_logger:close()
  local app = build_app(app_logger)
  app:listen("127.0.0.1:8080")
  return 0
end
```

## Non-Negotiable Rules & Footguns

### 1. Routing (`mk.router`)
- **No inline routing constraints:** `:id<int>` is rejected at registration time with `RouteError.code == "routing_constraints_unsupported"`. Validate in the handler (`ctx:param_int("id")`).
- **Tokens:** `:name`, `:name?`, `*` (`"*"` / `"*1"`), `+` (`"+"` / `"+1"`), escapes `\:`, `\?`, `\*`, `\+`, `\\`, `\<`, literal `::name`, atomic `%XX` (`%00` forbidden).
- **Defaults:** `case_sensitive = false`, `strict_routing = false`, `unescape_path = true`, `auto_head = true` (explicit `HEAD` or `all(...)` wins over `GET` fallback). Unmatched methods raise `405` with first-occurrence deduplicated `Allow`.
- **Route freeze:** Register all middleware, groups, mounts, and routes before `App:start()`, `App:listen()`, or `App:test()`.

### 2. `Context`, JSON-Only `Bind`, and `HttpError`
- **JSON-only body binding:** `ctx:bind()` decodes JSON only (`json`, `named`, `object`, `array`). Never invent form/query struct binders—use `ctx:param*`, `ctx:query*`, `ctx:get`, `ctx:cookie*`.
- **Exact `Bind` errors:** `415` (`not ctx:is_json()`), `413` (`> body_limit`), `400` (empty body or JSON syntax/limit error), `422` (schema/type mismatch). Programmer schema/option bugs (`unknown_type`, `constructor_unavailable`, `unsupported_type`, `invalid_option`) and non-`json.Error` constructor errors **re-raise unchanged**.
- **Map literals to `ctx:json`:** `ctx:json` takes `value`, which gives no contextual Map type—annotate the local (`local body: {string: value} = { ... }`) or pass a nominal `record`.
- **Errors:** Signal expected HTTP failures with `raise mk.HttpError(status, message?, code?, cause?)`. Out-of-range statuses normalize to `500` first (defaulting message to `"Internal Server Error"`). Never swallow `async.CancellationReason`.
- **Observers:** Use `ctx:on_before_commit` (header mutation before wire write) and `ctx:on_complete` (LIFO post-response observation) instead of wrapping `ctx:next()` in `catch`.
- **Forwarded headers:** `Config.trust_forwarded_headers` defaults to `false`; enable only behind a trusted reverse proxy stripping client `X-Forwarded-*`.

### 3. Worker Threads (`WorkerMode`) and Transfer Constraints
- **Modes:** `WorkerMode.parent()` (default), `WorkerMode.pool(PoolOptions { size?, queue_capacity?, on_start? })`, `WorkerMode.session(SessionOptions { session_id, queue_capacity?, max_sessions?, ephemeral?, on_start?, on_exit? })`.
- **Per-worker state:** Store DB pools, `http.Client`s, and caches in ordinary per-state module `local` variables initialized in `on_start(wctx)` and closed in `wctx:defer_cleanup(fn)` (LIFO).
- **Closure transfer rules (closures reaching `pool`/`session` workers):**
  - *Allowed captures:* scalars, plain transferable records/unions, transferable closures, mutable upvalues (become fresh independent cells, losing aliasing), `thread.Sender<|T|>`/`Receiver<|T|>` endpoints (retain fresh reference; source stays valid), and manual-handoff hook records (`net.Connection`, `fs.File`—transfer/detach ownership).
  - *Rejected captures:* cycles, direct Arrays or Maps (even `const`), Interfaces, `owned` C storage, `local` nominal types, non-nil Lua Udata, and hookless records with `local` fields (`http.Server`, `mk.App`).
  - *Parent-only:* `SessionOptions.session_id` and `on_exit` never cross threads.
  - `mk` wraps callbacks with `TransferableHandler`, `TransferableErrorHandler`, and `TransferableWorkerInit` (and `keyauth.CustomExtractor` for custom extractors).
- **Session retirement & isolation:** Call `ctx:retire_worker()` in a session handler for immediate causal retirement (no-op on `parent`/`pool`). Keep-alive connections stay on the worker under `idle_timeout_ms` until the next request's headers are parsed, then return via `return_pipe` for fresh parent classification. Pool worker exit outside shutdown **fails the whole `App`**; session worker exit stays isolated to that session and runs `on_exit` after OS join.
- **Shutdown:** Call `app:initiate_shutdown()` inside handlers/hooks/monitors (non-blocking). `app:shutdown()` waits for full retirement and **raises** if called from a handler or lifecycle hook.

### 4. Built-in Middleware Quick Reference (`mk.middleware.*`)

| Module | Key notes |
| --- | --- |
| `env` | `GET`/`HEAD` `{"vars":{...}}` from explicit `export_vars` allowlist; other methods `405`. |
| `healthcheck` | `LIVENESS_ENDPOINT` (`"/livez"`), `READINESS_ENDPOINT`, `STARTUP_ENDPOINT`; `FORMAT_TEXT` / `FORMAT_JSON`; `Cache-Control: no-store`. |
| `helmet` | Security headers; `""` omits a header; HSTS (`hsts_max_age > 0`) emitted on `ctx:secure()` only. |
| `keyauth` | `Extractor.{auth_header, header, single_header, query, cookie, chain, custom}`; delegates check to your `validator` (use `keyauth.constant_time_equal` inside `validator`); `token_from_context(ctx)`. |
| `logger` | `PHASE_COMPLETION` (`on_complete`, `matched_route()`) or `PHASE_ADMISSION` (`classified_route()`); `include_path` defaults `false`; built-in fields win over `extra_fields`. |
| `recover` | Converts non-`HttpError` exceptions to `500` (`"internal_error"`); preserves `HttpError` and `async.CancellationReason`. |
| `requestid` | Validates VCHAR `0x21..0x7E` (`1..256`), 3 generator retries, 16-byte CSPRNG fallback; `from_context(ctx)` / `ctx:request_id()`. |
| `responsetime` | Sets `X-Response-Time` (`%.3fms`) via `on_before_commit`. |
| `static` | Path served: matched `*`/`+` wildcard first (`app:get("/assets/*", static.new(root))`), else below `ctx:mount_path()`, else full request path (`use_path` does **not** strip prefix). Strict `lstat` + `realpath` confinement. |
| `timeout` | `timeout.new(handler, ms, cfg?)` (when `next(ctx)` is `true`, calls `handler(ctx)` without deadline) vs `timeout.middleware(ms, cfg?)` (when `next(ctx)` is `true`, calls `ctx:next()`). |

## Testing and Building Consumers

- **In-memory (`parent` routes only):** `app:test(mk.TestRequest("GET", "/path"), mk.TestConfig?)` — rejects `pool`/`session` routes and `upgrade_websocket` (`501`).
- **Real loopback (workers, TLS, keep-alive, WebSockets):** `local ts = app:listen_test(); defer ts:close(); ts:request("GET", "/path")`.
- **Native test filter syntax:** `./build/my-tests --filter=pattern` or `-f pattern` (bare `--filter pattern` is rejected by `titan.test`).
- **Dynamic consumer build:** `titanc --incremental --tree src -o build --exe build/app app.main`.
- **Static consumer build (`--static` on Linux/macOS with system-OpenSSL SDK):**
  ```sh
  TITAN_EXTRA_CPPFLAGS="$(pkg-config --cflags openssl)" \
  TITAN_EXTRA_LDFLAGS="$(pkg-config --libs openssl)" \
    titanc --static --tree src -o build --exe build/app app.main
  ```
  (Bundled-OpenSSL SDKs require no extra OpenSSL flags.)
- **Install / uninstall rock:** `luarocks make titan-mk-0.1.0-1.rockspec` / `titan-uninstall titan-mk`.
