# `mk` Module Reference

Import with `local mk = import "mk"`. `mk` is a folder module (`src/mk/mk.titan` plus contributors `app`, `bind`, `context`, `errors`, `group`, `hooks`, `mime`, `testing`, and `workers`).

See [Part I: Guide](../index.md#part-i--guide) for conceptual walkthroughs and idioms.

---

## Handlers, Errors, and Status Catalog

```text
type Handler = function (Context): ()
type ErrorHandler = function (Context, HttpError): ()

record HttpError
  const status: integer
  const message: string
  const code: string?
  const cause: value
end
function HttpError.new(status: integer, message: string?,
                       code: string?, cause: value): HttpError

function status_message(status: integer): string
function default_error_handler(ctx: Context, err: HttpError)
function json_error_handler(ctx: Context, err: HttpError)
```

- **`HttpError.new`:** Normalizes any `status` outside `200..999` to `500` first, then defaults `message` to `status_message(normalized_status)` (so out-of-range statuses default to `"Internal Server Error"`).
- **`status_message(status)`:** Returns the standard HTTP reason phrase (`100..511` catalog) or `"Unknown Status Code"`.
- **`default_error_handler(ctx, err)`:** Writes `ctx:status(err.status):type("text/plain", "utf-8"):send_string(err.message)`.
- **`json_error_handler(ctx, err)`:** Writes `ctx:status(err.status):json({ ["status"] = err.status, ["message"] = err.message, ["code"] = err.code })`.

---

## Application (`App`, `Config`, `ListenConfig`)

```text
record Config
  const app_name: string?                   -- default ""
  const server_header: string?              -- default nil
  const case_sensitive: boolean?            -- default false
  const strict_routing: boolean?            -- default false
  const unescape_path: boolean?             -- default true
  const auto_head: boolean?                 -- default true
  const body_limit: integer?                -- default 4194304 (4 MiB, >= 1)
  const header_limit: integer?              -- default 65536 (64 KiB, >= 1)
  const idle_timeout_ms: integer?           -- default 10000 (>= 0; 0 disables)
  const shutdown_timeout_ms: integer?       -- default 10000 (>= 0)
  const json_max_depth: integer?            -- default 64 (>= 1)
  const trust_forwarded_headers: boolean?   -- default false
  const error_handler: ErrorHandler?        -- default default_error_handler
  const logger: log.Logger?                 -- default nil
  const workers: WorkerMode?                -- default WorkerMode.parent()
end

record ListenConfig
  const backlog: integer?
  const reuse_port: boolean?
  const cert_file: string?
  const key_file: string?
end

record App
function App.new(config: Config?): App

-- Introspection & URL building
function App:config(): Config
function App:hooks(): Hooks
function App:logger(): log.Logger?
function App:routes(): const {RouteInfo}
function App:route_url(name: string, params: {string: string}?): string
function App:is_running(): boolean

-- Middleware, groups, chains, mounting, and routes (must precede start/test)
function App:use(handler: Handler, ...: Handler): App
function App:use_path(prefix: string, handler: Handler, ...: Handler): App
function App:mount(prefix: string, sub_app: App): App
function App:group(prefix: string, ...: Handler): Group
function App:group_with(prefix: string, options: GroupOptions, ...: Handler): Group
function App:route_chain(path: string): RouteChain

function App:get(path: string, handler: Handler, ...: Handler): RouteHandle
function App:head(path: string, handler: Handler, ...: Handler): RouteHandle
function App:post(path: string, handler: Handler, ...: Handler): RouteHandle
function App:put(path: string, handler: Handler, ...: Handler): RouteHandle
function App:delete(path: string, handler: Handler, ...: Handler): RouteHandle
function App:connect(path: string, handler: Handler, ...: Handler): RouteHandle
function App:options(path: string, handler: Handler, ...: Handler): RouteHandle
function App:trace(path: string, handler: Handler, ...: Handler): RouteHandle
function App:patch(path: string, handler: Handler, ...: Handler): RouteHandle
function App:all(path: string, handler: Handler, ...: Handler): RouteHandle
function App:add(methods: {string}, path: string,
                 handler: Handler, ...: Handler): {RouteHandle}

-- Lifecycle & shutdown
function App:start(addr: string, listen_config: ListenConfig?)
function App:serve()
function App:listen(addr: string, listen_config: ListenConfig?)
function App:initiate_shutdown()
function App:shutdown()

-- Worker supervision
function App:pool_workers(): const {WorkerInfo}
function App:pool_next_index(): integer
function App:session_worker(session_id: string): WorkerInfo?
function App:active_session_ids(): const {string}
function App:is_worker_alive(worker_id: integer): boolean
function App:stop_worker(worker_id: integer): boolean
```

- **`App:start(addr, listen_config?)`:** Freezes routes, binds `http.listen` (or `http.listen_tls` when `cert_file ~= nil`), resolves an ephemeral port `0` via `server:local_address().port` (so `ListenData.port` carries the OS-assigned port), sets `read_ahead(false)` and `header_limit`, spawns pool workers and supervision Tasks, and runs `on_listen` hooks. Raises if already started. If startup fails after binding the listener (for example during worker startup or an `on_listen` hook), `App:start` rolls back by running full shutdown (including `on_pre_shutdown` and `on_post_shutdown`) before re-raising.
- **`App:serve()`:** Runs the accept loop until shutdown closes the listener, joins shutdown retirement, and re-raises any fatal failure (such as a pool worker exit outside shutdown).
- **`App:listen(addr, listen_config?)`:** Calls `start` then `serve`.
- **`App:initiate_shutdown()`:** Begins shutdown asynchronously without waiting (safe inside handlers, lifecycle hooks, and monitors). Idempotent once shutdown has begun.
- **`App:shutdown()`:** Begins shutdown and waits for complete retirement. Raises if called inside an active request handler or lifecycle hook. Calling `shutdown()` on a never-started `App` (including one whose `App:start()` failed before listener bind) still executes `on_pre_shutdown` and `on_post_shutdown` once.
- **`App:stop_worker(worker_id)`:** Cancels a live worker thread (`false` if not alive). Retires only that session for a `session` worker; triggers forced shutdown of the `App` without logging `"worker_failed"` for a `pool` worker outside shutdown.

---

## Groups, Route Chains, and Handles

```text
record GroupOptions
  const name: string?
  const workers: WorkerMode?
end

record Group
function Group:use(handler: Handler, ...: Handler): Group
function Group:use_path(prefix: string, handler: Handler, ...: Handler): Group
function Group:group(prefix: string, ...: Handler): Group
function Group:group_with(prefix: string, options: GroupOptions, ...: Handler): Group
function Group:route_chain(path: string): RouteChain
function Group:get(path: string, handler: Handler, ...: Handler): RouteHandle
-- plus head, post, put, delete, connect, options, trace, patch, all, add(methods, ...)
function Group:pool_workers(): const {WorkerInfo}
function Group:pool_next_index(): integer
function Group:session_worker(session_id: string): WorkerInfo?
function Group:active_session_ids(): const {string}

record RouteHandle
function RouteHandle:name(route_name: string): RouteHandle
function RouteHandle:workers(mode: WorkerMode): RouteHandle
function RouteHandle:info(): RouteInfo

record RouteChain
function RouteChain:get(handler: Handler, ...: Handler): RouteChain
-- plus head, post, put, delete, connect, options, trace, patch, all, add(methods, ...)
function RouteChain:route_chain(sub_path: string): RouteChain
```

---

## Lifecycle Hooks and Metadata Snapshots

```text
record ListenData
  const host: string
  const port: integer
  const tls: boolean
  const app_name: string
  const handler_count: integer
  const pid: integer
end

record RouteInfo
  const method: string
  const path: string
  const name: string
  const group_prefix: string
  const params: const {string}
end

record GroupInfo
  const prefix: string
  const name: string
end

record WorkerInfo
  const id: integer
  const session_id: string?
  const alive: boolean
end

record Hooks
function Hooks:on_route(fn: function (RouteInfo): ())
function Hooks:on_name(fn: function (RouteInfo): ())
function Hooks:on_group(fn: function (GroupInfo): ())
function Hooks:on_listen(fn: function (ListenData): ())
function Hooks:on_pre_shutdown(fn: function (): ())
function Hooks:on_post_shutdown(fn: function (async.Error?): ())
```

`on_pre_shutdown` and `on_post_shutdown` run once during shutdown, including during startup rollback when `App:start()` fails after binding the listener and when `App:shutdown()` (or `App:initiate_shutdown()`) is called on a never-started `App`. Keep hook-owned resource teardown idempotent and tolerant of unstarted or partially initialized state.

---

## `RequestMeta`, `Cookie`, `Context`, and `Bind`

### `RequestMeta`

```text
record RequestMeta
  const method: string
  const path: string
  const original_url: string
  const scheme: string
  const host: string
end
function RequestMeta:peer_address(): net.Address?
function RequestMeta:param(name: string, default_val: string?): string
function RequestMeta:param_opt(name: string): string?
function RequestMeta:query(name: string, default_val: string?): string
function RequestMeta:query_opt(name: string): string?
function RequestMeta:query_values(name: string): {string}
function RequestMeta:get(name: string, default_val: string?): string
function RequestMeta:get_headers(name: string): {string}
function RequestMeta:cookie(name: string, default_val: string?): string
```

`RequestMeta` also stores the classified `route_pattern` internally (populated at dispatch and updated by `Context:restart_routing()`), exposed publicly via `Context:classified_route()`, and the direct socket `peer: net.Address?` captured via `http.Request:peer_address()` while the exchange was live (exposed via `RequestMeta:peer_address()` and `Context:peer_address()`, preserved across worker-thread `ExchangeEnvelope` handoff and `on_complete` hooks; `nil` in `App:test` or if the peer disconnected before capture; `X-Forwarded-For` / `trusted_proxies` are intentionally omitted). When `Config.trust_forwarded_headers = true`, the first comma-separated entry of `X-Forwarded-Proto` (`"http"`/`"https"`, ASCII case-insensitive) and non-empty `X-Forwarded-Host` override `scheme` and `host`.

### `Cookie`

```text
record Cookie
  const name: string
  const value: string
  const path: string?          -- default "/"
  const domain: string?
  const max_age: integer?      -- negative clamped to Max-Age=0
  const expires_unix: integer?
  const secure: boolean?
  const http_only: boolean?
  const same_site: string?     -- "Lax", "Strict", or "None"
end
```

### `Context`

```text
record Context

-- Navigation & lifecycle
function Context:next()
function Context:restart_routing()
function Context:method(): string
function Context:path(): string
function Context:original_url(): string
function Context:base_url(): string
function Context:full_url(): string
function Context:scheme(): string
function Context:secure(): boolean
function Context:host(): string
function Context:hostname(): string
function Context:port(): integer
function Context:protocol(): string
function Context:is_websocket(): boolean
function Context:is_upgrade_offer(): boolean
function Context:is_preflight(): boolean
function Context:matched_route(): string
function Context:classified_route(): string
function Context:peer_address(): net.Address?
function Context:endpoint(): RouteInfo?
function Context:route_name(): string
function Context:mount_path(): string
function Context:target_error(): string?
function Context:start_time_ns(): integer
function Context:elapsed_ms(): float
function Context:deadline_ns(): integer?
function Context:last_error(): HttpError?
function Context:on_before_commit(hook: function (Context): ())
function Context:on_complete(hook: function (Context): ())
function Context:run_with_timeout(timeout_ms: integer, action: Handler, on_timeout: Handler?)

-- Params, query, headers, cookies, locals
function Context:param(name: string, default_val: string?): string
function Context:param_opt(name: string): string?
function Context:param_int(name: string, default_val: integer?): integer
function Context:params(): {string: string}
function Context:override_param(name: string, val: string)
function Context:query(name: string, default_val: string?): string
function Context:query_opt(name: string): string?
function Context:query_values(name: string): {string}
function Context:queries(): {string: string}
function Context:query_int(name: string, default_val: integer?): integer
function Context:query_float(name: string, default_val: float?): float
function Context:query_bool(name: string, default_val: boolean?): boolean
function Context:get(name: string, default_val: string?): string
function Context:header_opt(name: string): string?
function Context:get_headers(name: string): {string}
function Context:has_header(name: string): boolean
function Context:req_headers(): http.Headers
function Context:content_type(): string
function Context:media_type(): string
function Context:is_json(): boolean
function Context:accepts(offers: {string}): string?
function Context:bearer(): string?
function Context:cookie(name: string, default_val: string?): string
function Context:cookie_opt(name: string): string?
function Context:cookies(): {string: string}
function Context:set_cookie(cookie: Cookie)
function Context:clear_cookie(name: string, cookie_path: string?, domain: string?)
function Context:set_local(key: string, item: value)
function Context:get_local(key: string): value
function Context:request_id(): string

-- Body & JSON binding
function Context:body(): string
function Context:read_body_chunk(): string?
function Context:bind(): Bind

-- Buffered response & explicit commit
function Context:status(code: integer): Context
function Context:status_code(): integer
function Context:set(name: string, contents: string): Context
function Context:append(name: string, contents: string): Context
function Context:remove_header(name: string): Context
function Context:resp_header(name: string): string?
function Context:resp_headers(): http.Headers
function Context:vary(field: string, ...: string): Context
function Context:type(extension_or_mime: string, charset: string?): Context
function Context:location(target_url: string): Context
function Context:attachment(filename: string?): Context
function Context:send(data: string): Context
function Context:send_string(text: string): Context
function Context:html(markup: string): Context
function Context:send_status(code: integer): Context
function Context:no_content(): Context
function Context:json(payload: value, ...: json.EncodeOption): Context
function Context:json_raw(encoded_json: string): Context
function Context:redirect(target_url: string, code: integer?): Context
function Context:send_file(file_path: string, download: boolean?)
function Context:reset_body()
function Context:commit()

-- Streaming, abort, & WebSocket takeover
function Context:committed(): boolean
function Context:aborted(): boolean
function Context:flush_headers()
function Context:write_chunk(data: string)
function Context:send_stream(reader: io.Reader, content_length: integer?)
function Context:abort()
function Context:upgrade_websocket(options: websocket.AcceptOptions?): websocket.Connection
function Context:reject_upgrade(code: integer)

-- Worker context, logging, & session retirement
function Context:worker_id(): integer
function Context:session_id(): string?
function Context:logger(): log.Logger?
function Context:log(level: string, event: string, fields: {string: value}?)
function Context:retire_worker()
```

- **`Context:classified_route()` vs. `Context:matched_route()`:** `classified_route()` returns the declared pattern of the endpoint route the request classified to at dispatch (or `""`), available even in outer admission middleware before endpoint execution. `matched_route()` returns the pattern of the endpoint route once `ctx:next()` reaches it (or `""` beforehand / if unmatched).
- **`Context:peer_address(): net.Address?`:** Returns the captured client socket address (see [`RequestMeta`](#requestmeta)).
- **`Context:logger(): log.Logger?`:** Returns `nil` when `Config.logger` is unset. Bind with `local logger? = ctx:logger()` (omitting `?` in Titan asserts non-nil and raises when no logger is configured), or use `ctx:log(...)` which is a no-op without a logger.
- **Closing exchanges & `413` completion:** When a closing condition (such as uncommitted `413 Content Too Large`, shutdown, retiring/ephemeral session worker, or explicit `Connection: close`) or the client request announces `Connection: close`, `titan.http` closes the connection after the response finishes without reading the unread request body, so `mk` completes normally without calling `response:abort()`. If a response was already committed as persistent before a close decision or if bounded request-body drain fails, `mk` aborts the transport.
- **`Context:type(extension_or_mime, charset?)` and MIME defaults (`src/mk/mime.titan`):** Accepts a full MIME type (containing `/`), dotted extension (`".json"`), or bare extension (`"json"`). Unknown extensions fall back to `"application/octet-stream"`. Text-like media types (`text/*`, `application/json`, `application/javascript`, `application/xml`, `image/svg+xml`, `application/yaml`) default to `; charset=utf-8` unless `charset` is supplied or a `;` parameter is already present. (`mime.titan` exports no public symbols of its own.)

### `Bind`

```text
record Bind
function Bind:json(schema: reflect.Type?, ...: json.DecodeOption): value
function Bind:named(type_name: string, ...: json.DecodeOption): value
function Bind:object(...: json.DecodeOption): {string: value}
function Bind:array(...: json.DecodeOption): {value}
```

| Condition | Result |
| --- | --- |
| `not ctx:is_json()` | `HttpError(415, "Unsupported Media Type", "unsupported_media_type")` |
| Body exceeds `Config.body_limit` | `HttpError(413, "Content Too Large", "body_too_large")` |
| Empty body `""` | `HttpError(400, "empty JSON request body", "empty_body")` |
| `json.Error` syntax/UTF-8/escape/duplicate-key/limit code | `HttpError(400, err.message, err.code, err)` |
| `json.Error` schema mismatch (`type_mismatch`, `missing_field`, `unknown_field`, `invalid_union`, `unknown_variant`, `non_integral`, plus `integer_range`/`number_range` when `schema ~= nil`) | `HttpError(422, err.message, err.code, err)` |
| Programmer error (`unknown_type`, `constructor_unavailable`, `unsupported_type`, `invalid_option`) or non-`json.Error` from `Record.new` | Re-raised unchanged |

---

## Workers and Supervision

```text
type SessionExtractor = function (RequestMeta): (string?)
type WorkerInit = function (WorkerContext): ()
type SessionExitHook = function (string, integer, boolean): ()

record WorkerContext
  const id: integer
  const session_id: string?
  const logger: log.Logger?
end
function WorkerContext:defer_cleanup(cleanup: function (): ())

record PoolOptions
  const size: integer?             -- default 1 (>= 1)
  const queue_capacity: integer?   -- default 128 (>= 1)
  const on_start: WorkerInit?
end

record SessionOptions
  const session_id: SessionExtractor
  const queue_capacity: integer?   -- default 64 (>= 1)
  const max_sessions: integer?     -- optional cap (>= 1; 503 "max_sessions")
  const ephemeral: boolean?        -- default false
  const on_start: WorkerInit?
  const on_exit: SessionExitHook?
end

union WorkerMode
  parent()
  pool(options: PoolOptions?)
  session(options: SessionOptions)
end

record TransferableHandler
function TransferableHandler.new(fn: Handler): TransferableHandler
function TransferableHandler:call(ctx: Context)
function TransferableHandler:to_transfer_payload(): string
function TransferableHandler.from_transfer_payload(payload: string): TransferableHandler

record TransferableErrorHandler
function TransferableErrorHandler.new(fn: ErrorHandler): TransferableErrorHandler
function TransferableErrorHandler:call(ctx: Context, err: HttpError)
function TransferableErrorHandler:to_transfer_payload(): string
function TransferableErrorHandler.from_transfer_payload(payload: string): TransferableErrorHandler

record TransferableWorkerInit
function TransferableWorkerInit.new(fn: WorkerInit): TransferableWorkerInit
function TransferableWorkerInit:call(wctx: WorkerContext)
function TransferableWorkerInit:to_transfer_payload(): string
function TransferableWorkerInit.from_transfer_payload(payload: string): TransferableWorkerInit
```

`WorkerContext.logger` is `log.Logger?` (`nil` when `Config.logger` is unset). Inside `on_start(wctx)`, bind it with `local logger? = wctx.logger` rather than `local logger = wctx.logger` (which asserts non-nil in Titan and raises when no logger is configured).

*(Note: `workers.titan` also declares nominal wire records `ExchangeEnvelope`, `ExchangePipe`, `RetireNotice`, `EntrySpec`, `WorkerSettings`, and `WorkerBootstrap` for internal `protobuf`/`thread` cross-state transport; applications do not construct them directly.)*

---

## Testing

```text
record TestRequest
  const method: string
  const target: string
  const headers: http.Headers?
  const body: string?
  const tls: boolean?
end

record TestConfig
  const timeout_ms: integer?        -- default 1000 (0 disables)
  const fail_on_timeout: boolean?   -- default true
end

record TestResponse
  const status: integer
  const headers: http.Headers
  const body: string
end
function TestResponse:header(name: string): string?
function TestResponse:json(schema: reflect.Type?, ...: json.DecodeOption): value

record TestServer
  const host: string
  const port: integer
  const base_url: string
end
function TestServer:request(method: string, target: string,
                            options: http.RequestOptions?): TestResponse
function TestServer:close()

function App:test(req: TestRequest, config: TestConfig?): TestResponse
function App:listen_test(host: string?, listen_config: ListenConfig?): TestServer
```

`App:listen_test(host?, listen_config?)` binds an OS-assigned ephemeral loopback port (`port = 0`, defaulting `host` to `"127.0.0.1"`), starts serving in a background Task, and populates `TestServer.port` and `TestServer.base_url` from the bound listener address.
