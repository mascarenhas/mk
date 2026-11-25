# `mk` Module Reference

Import with `local mk = import "mk"`. `mk` is a folder module (`src/mk/mk.titan` plus contributors `app`, `bind`, `context`, `errors`, `group`, `hooks`, `mime`, `testing`, and `workers`). `mime.titan` exports no public symbols.

For task-oriented usage, see [How to Define Routes, Bind JSON, and Return Errors](../how-to/routes-and-json-apis.md), [How to Stream Responses and Upgrade WebSockets](../how-to/streaming-and-websockets.md), [How to Run Handlers on OS Worker Pools and Session Workers](../how-to/worker-threads-and-sessions.md), and [How to Test Services and Measure Line Coverage](../how-to/testing-and-coverage.md).

**Record construction:** `App`, `HttpError`, and `Transferable*` expose public `new` constructors (`mk.App()`, `mk.HttpError(404)`). Pure data records (`Config`, `ListenConfig`, `GroupOptions`, `Cookie`, `TestRequest`, `TestConfig`, `PoolOptions`, `SessionOptions`) expose synthesized public constructors supporting both positional and named-brace calls (`mk.TestRequest("GET", "/x")`, `mk.Config { app_name = "demo" }`). Records with private fields (`Group`, `RouteHandle`, `RouteChain`, `Hooks`, `RequestMeta`, `Context`, `Bind`, `TestServer`, `WorkerContext`) are obtained from `App` methods and cannot be constructed directly.

## Handlers, Errors, and Status Catalog

```titan
type Handler = function (Context): ()
type ErrorHandler = function (Context, HttpError): ()

record HttpError
  const status: integer
  const message: string
  const code: string?
  const cause: value
end

function HttpError.new(
  status: integer,
  message: string?,
  code: string?,
  cause: value
): HttpError

function status_message(status: integer): string
function default_error_handler(ctx: Context, err: HttpError)
function json_error_handler(ctx: Context, err: HttpError)
```

- **`HttpError.new`:** Normalizes any `status` outside `200..999` to `500` first, then defaults `message` to `status_message(normalized)` (so out-of-range statuses default to `"Internal Server Error"`).
- **`status_message(status)`:** Returns the RFC 9110 reason phrase for standard codes (`100..103`, `200..208`, `226`, `300..308` excluding `306`, `400..418`, `421..426`, `428`, `429`, `431`, `451`, `500..508`, `510`, `511`), including `"Content Too Large"` (`413`) and `"Unprocessable Content"` (`422`), or `"Unknown Status Code"` otherwise.
- **`default_error_handler(ctx, err)`:** Writes `ctx:status(err.status):type("text/plain", "utf-8"):send_string(err.message)` (`Content-Type: text/plain; charset=utf-8`).
- **`json_error_handler(ctx, err)`:** Writes `ctx:status(err.status):json(...)` with `status`, `message`, and `code`. JSON keys are encoded in alphabetical order (`code`, `message`, `status`), and `code` is omitted when `nil`.

## Application (`App`, `Config`, `ListenConfig`)

```titan
record Config
  const app_name: string?                  -- default ""
  const server_header: string?             -- default nil
  const case_sensitive: boolean?           -- default false
  const strict_routing: boolean?           -- default false
  const unescape_path: boolean?            -- default true
  const auto_head: boolean?                -- default true
  const body_limit: integer?               -- default 4194304 (4 MiB)
  const header_limit: integer?             -- default 65536 (64 KiB)
  const idle_timeout_ms: integer?          -- default 10000 ms
  const shutdown_timeout_ms: integer?      -- default 10000 ms
  const json_max_depth: integer?           -- default 64
  const trust_forwarded_headers: boolean?  -- default false
  const error_handler: ErrorHandler?       -- default_error_handler
  const logger: log.Logger?                -- default nil
  const workers: WorkerMode?               -- default parent()
end

record ListenConfig
  const backlog: integer?     -- http default 128
  const reuse_port: boolean?  -- ENOTSUP on macOS and Windows
  const cert_file: string?    -- enables TLS (http.listen_tls)
  const key_file: string?     -- defaults to cert_file when nil
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

-- Middleware, groups, chains, mounting, and routes
function App:use(handler: Handler, ...: Handler): App
function App:use_path(
  prefix: string, handler: Handler, ...: Handler
): App
function App:mount(prefix: string, sub_app: App): App
function App:group(prefix: string, ...: Handler): Group
function App:group_with(
  prefix: string, options: GroupOptions, ...: Handler
): Group
function App:route_chain(path: string): RouteChain

function App:get(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function App:head(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function App:post(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function App:put(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function App:delete(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function App:connect(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function App:options(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function App:trace(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function App:patch(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function App:all(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function App:add(
  methods: {string}, path: string, handler: Handler, ...: Handler
): {RouteHandle}

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

### `Config` validation

`App.new` validates `Config` fields eagerly:

- `body_limit < 1` raises `"mk: body_limit must be positive"`.
- `header_limit < 1` raises `"mk: header_limit must be positive"`.
- `idle_timeout_ms < 0` raises `"mk: idle_timeout_ms must be non-negative"` (`0` disables the idle deadline).
- `shutdown_timeout_ms < 0` raises `"mk: shutdown_timeout_ms must be non-negative"` (`0` aborts parent requests immediately on shutdown).
- `json_max_depth < 1` raises `"mk: json_max_depth must be positive"`.
- `unescape_path` and `auto_head` default to `true`; only an explicit `false` disables them.
- `Config.workers` is validated immediately in `App.new`.

### Registration, mounting, and URL building

- **Freeze:** The first `App:start` or `App:test` freezes registration. Any later route, middleware, group, mount, `RouteHandle:name`, or `RouteHandle:workers` call raises `"mk: routes cannot be registered after App:start or App:test"`.
- **Declaration order:** Middleware and routes execute in registration order. Methods are uppercased automatically, and patterns compile immediately (raising `router.RouteError` on invalid syntax or limits).
- **`use_path` prefixes:** Match whole segments only (`/api` does not match `/apix`) and may contain parameters such as `"/api/:version"`.
- **`App:mount(prefix, sub_app)`:** Snapshots `sub_app`'s entries at call time. Mounted routes keep their names unprefixed, fire the parent app's `on_route` hooks, and inherit `sub_app`'s `Config.workers` when they do not declare an explicit mode. Mounting sets `mount_path` without inventing a `group_prefix`.
- **`App:route_url(name, params?)`:** Uses the first route whose name matches `name` and delegates to `CompiledPattern:build`. Raises `"mk: no route named <name>"` if unmatched.
- **`App:routes()`:** Returns endpoint `RouteInfo` snapshots in registration order.

### Lifecycle, address grammar, and shutdown

- **Listen address (`App:start`):** Parses `host:port` (split at the last `:`) or `[v6]:port`. An empty host (such as `":8080"`) binds `0.0.0.0`. Port must be in `0..65535` (`0` requests an OS-assigned ephemeral port). Invalid inputs raise `"mk: listen address must be host:port"`, `"mk: invalid listen address ..."`, or `"mk: invalid listen port in ..."`.
- **`App:start(addr, listen_config?)`:** Raises `"mk: App has already been started"` if started previously or if shutdown has already run (even on a never-started `App`). Freezes routes, binds `http.listen` or `http.listen_tls`, resolves port `0` via `local_address().port`, sets `read_ahead(false)` and `header_limit`, starts supervision channels, spawns every pool worker and waits until every `on_start` completes (failing with `"mk: pool worker N failed to start: ..."`), and runs `on_listen` hooks. Failures after listener bind roll back via full shutdown (`on_pre_shutdown` and `on_post_shutdown`, passing `nil` to `on_post_shutdown` unless a shutdown step itself failed) before re-raising.
- **`App:serve()`:** Raises `"mk: App:serve() requires App:start()"` if `start` was never called. Runs the accept loop, joins retirement, and re-raises any fatal failure (such as a pool worker crash or cancellation outside shutdown).
- **`App:listen(addr, listen_config?)`:** Calls `start` followed by `serve`.
- **`App:is_running()`:** Returns `true` when the listener is active and shutdown has not begun.
- **`App:initiate_shutdown()`:** Begins shutdown asynchronously; safe inside handlers and lifecycle hooks. Idempotent.
- **`App:shutdown()`:** Begins shutdown and waits for full retirement. Raises `"mk: App:shutdown() cannot wait inside an active request handler; use App:initiate_shutdown()"` inside handlers and `"... cannot wait inside a lifecycle hook; use App:initiate_shutdown()"` inside `on_listen`, `on_pre_shutdown`, `on_post_shutdown`, or session `on_exit`. Works on a never-started `App` (running pre- and post-shutdown hooks once and preventing a later `start`).
- **Shutdown order:** (0) Set `closing`—new arrivals run in place with terminal `HttpError(503, "Service Unavailable", "shutting_down")` and `Connection: close`; (1) close the listener; (2) run `on_pre_shutdown` hooks in order (a hook error does not stop later hooks); (3) cancel idle parent keep-alive connections and wait up to `shutdown_timeout_ms` for in-flight parent requests before aborting and joining them; (4) close worker pipes and cancel all live workers (**worker in-flight requests get no drain grace**), join monitors (`on_exit` and `defer_cleanup`), and close the retire listener; (5) stop the keep-alive return pipe; (6) close the worker log channel and join the forwarder (`mk` never closes `Config.logger`); (7) run `on_post_shutdown(first_failure?)` hooks.
- **Supervision:** `App:pool_workers()` and `App:pool_next_index()` inspect the root dispatcher's pool (`{}` if the root is not a pool). `App:session_worker(session_id)` searches the root dispatcher first and then every session dispatcher. `App:active_session_ids()` returns active IDs across all dispatchers. `App:stop_worker(worker_id)` returns `false` if not alive; otherwise cancels the thread (retiring only that session for a session worker, or forcing `App` shutdown without logging `worker_failed` for a pool worker outside shutdown).

## Groups, Route Chains, and Handles

```titan
record GroupOptions
  const name: string?
  const workers: WorkerMode?
end

record Group
function Group:use(handler: Handler, ...: Handler): Group
function Group:use_path(
  prefix: string, handler: Handler, ...: Handler
): Group
function Group:group(prefix: string, ...: Handler): Group
function Group:group_with(
  prefix: string, options: GroupOptions, ...: Handler
): Group
function Group:route_chain(path: string): RouteChain
function Group:get(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function Group:head(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function Group:post(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function Group:put(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function Group:delete(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function Group:connect(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function Group:options(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function Group:trace(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function Group:patch(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function Group:all(
  path: string, handler: Handler, ...: Handler
): RouteHandle
function Group:add(
  methods: {string}, path: string, handler: Handler, ...: Handler
): {RouteHandle}
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
function RouteChain:head(handler: Handler, ...: Handler): RouteChain
function RouteChain:post(handler: Handler, ...: Handler): RouteChain
function RouteChain:put(handler: Handler, ...: Handler): RouteChain
function RouteChain:delete(handler: Handler, ...: Handler): RouteChain
function RouteChain:connect(handler: Handler, ...: Handler): RouteChain
function RouteChain:options(handler: Handler, ...: Handler): RouteChain
function RouteChain:trace(handler: Handler, ...: Handler): RouteChain
function RouteChain:patch(handler: Handler, ...: Handler): RouteChain
function RouteChain:all(handler: Handler, ...: Handler): RouteChain
function RouteChain:add(
  methods: {string}, handler: Handler, ...: Handler
): RouteChain
function RouteChain:route_chain(sub_path: string): RouteChain
```

- Handlers passed to `group` or `group_with` register as middleware at the group's full prefix. Nested groups concatenate both path and name prefixes and inherit the parent group's worker mode unless `GroupOptions.workers` overrides it.
- `Group:pool_workers()`, `Group:pool_next_index()`, `Group:session_worker()`, and `Group:active_session_ids()` inspect the group's own dispatcher (or the root dispatcher if the group did not set a mode).
- `RouteHandle:name(route_name)` prepends the group's name prefix and fires `on_name` hooks synchronously.
- `RouteChain` method helpers take no `path` argument and return the `RouteChain` (including `RouteChain:add`, unlike `App:add` and `Group:add`, which return `{RouteHandle}`).

## Lifecycle Hooks and Metadata Snapshots

```titan
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

- `RouteInfo.method` is the route's first method, with `"*"` rendered as `"ALL"`. `RouteInfo.params` lists parameter and wildcard keys (`"id"`, `"*1"`, `"+1"`).
- `ListenData.host` is the parsed bind host (`"0.0.0.0"` for an empty host; IPv6 without brackets). `ListenData.port` is the bound port (`local_address().port` for `0`). `ListenData.handler_count` sums handlers across all entries, middleware included. `ListenData.pid` comes from `os.pid()`.
- `on_route`, `on_name`, and `on_group` run synchronously during registration. `on_listen` runs inside `App:start` after pool workers finish `on_start`. `on_pre_shutdown` and `on_post_shutdown` run once on shutdown, including startup rollback and shutdown of a never-started `App`.

## `RequestMeta`, `Cookie`, `Context`, and `Bind`

### `RequestMeta`

```titan
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

- `path` is percent-decoded when `Config.unescape_path` is enabled and target parsing succeeds; routing always matches the raw path.
- When `Config.trust_forwarded_headers` is `true`, the first comma-separated entry of `X-Forwarded-Proto` (`"http"` or `"https"`, ASCII case-insensitive) overrides `scheme`, and the first non-empty entry of `X-Forwarded-Host` overrides `host`.
- `peer_address()` returns the socket peer captured once from the live request (carried across worker handoffs and readable in `on_complete`), or `nil` in `App:test` or if the peer disconnected before capture. `X-Forwarded-For` is not consulted.
- Malformed request targets do not auto-reject with `400`; `path` holds the raw text before `?`, query maps are empty, and `Context:target_error()` exposes the failure string.
- Cookie parsing splits on `;`, trims whitespace, strips surrounding double quotes, and keeps the first value per name.

### `Cookie`

```titan
record Cookie
  const name: string
  const value: string
  const path: string?          -- rendered "; Path=<path or />"
  const domain: string?
  const max_age: integer?      -- negative clamped to Max-Age=0
  const expires_unix: integer? -- IMF-fixdate GMT
  const secure: boolean?
  const http_only: boolean?
  const same_site: string?     -- "Lax", "Strict", or "None"
end
```

`set_cookie` and `clear_cookie` raise plain strings on invalid attributes:

- `"mk: invalid cookie name"` (not an RFC token).
- `"mk: invalid cookie value"` (contains a control byte, space, `"`, `,`, `;`, DEL, or `\`).
- `"mk: invalid cookie path"` or `"mk: invalid cookie domain"` (contains `;` or a control byte).
- `"mk: cookie same_site must be Lax, Strict, or None"`.

`clear_cookie(name, path?, domain?)` sets `value=""`, `Max-Age=0`, and `Expires=Thu, 01 Jan 1970 00:00:00 GMT`.

### `Context`

```titan
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
function Context:run_with_timeout(
  timeout_ms: integer, action: Handler, on_timeout: Handler?
)

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
function Context:query_bool(
  name: string, default_val: boolean?
): boolean
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
function Context:clear_cookie(
  name: string, cookie_path: string?, domain: string?
)
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
function Context:type(
  extension_or_mime: string, charset: string?
): Context
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
function Context:send_stream(
  reader: io.Reader, content_length: integer?
)
function Context:abort()
function Context:upgrade_websocket(
  options: websocket.AcceptOptions?
): websocket.Connection
function Context:reject_upgrade(code: integer)

-- Worker context, logging, & session retirement
function Context:worker_id(): integer
function Context:session_id(): string?
function Context:logger(): log.Logger?
function Context:log(
  level: string, event: string, fields: {string: value}?
)
function Context:retire_worker()
```

Key `Context` invariants:

- **Task ownership:** Every mutating method, plus `next`, `body`, `bind`, `read_body_chunk`, `on_before_commit`, `on_complete`, `run_with_timeout`, and `set_local`, checks Task ownership. Calling from another Task (or from a child Task whose `run_with_timeout` expired) raises `"context ownership revoked"`.
- **Chain dispatch (`next` and `restart_routing`):** Middleware matches by prefix regardless of dispatcher; routes match only on this request's dispatcher. When the chain finishes:
  1. Any pending terminal error (`shutting_down`, selector `HttpError`, `no_workers`, `max_sessions`, `no_session`) is raised.
  2. Otherwise, if no endpoint ran and at least one route pattern matches the path, `Allow` is set in first-occurrence order (`*` excluded, `HEAD` inserted right after `GET` when `auto_head` is enabled) and `HttpError(405, "Method Not Allowed", nil)` is raised.
  3. Otherwise, `HttpError(404, "Cannot <METHOD> <decoded path>", nil)` is raised.
  `restart_routing()` re-classifies and restarts from entry 1, raising `HttpError(500, "cannot restart routing across worker dispatchers")` if the new target belongs to another dispatcher.
- **Request inspection:** `protocol()` is always `"HTTP/1.1"`. `hostname()` strips the port and keeps IPv6 brackets; `port()` reads the `Host` port or defaults to `443` (`https`) or `80`. `is_upgrade_offer()` is `true` for any `Upgrade` header, any `Connection: upgrade` token, or method `CONNECT`. `is_websocket()` requires both `Upgrade: websocket` and `Connection: upgrade`. `is_preflight()` requires `OPTIONS` with `Origin` and `Access-Control-Request-Method`.
- **Route queries:** `classified_route()` returns the pattern classified at dispatch (available before any handler runs, or `""` when unmatched); `matched_route()` returns the last entered endpoint pattern (`""` before any). `request_id()` returns local `"requestid"` (or `""` if unset or not a string).
- **Typed parsers and negotiation:** `param_int`, `query_int`, `query_float` (requires finite), and `query_bool` (`true`, `1`, `yes`, or `on`; `false`, `0`, `no`, or `off`, ASCII case-insensitive) raise `HttpError(400, ..., "invalid_parameter")` when missing, empty, or malformed. `override_param` updates only existing keys. `is_json()` matches `application/json` and `*/*+json`. `accepts(offers)` selects the first offer with the highest positive RFC 9110 quality (returning `offers[1]` when `Accept` is absent or empty, `nil` when all have `q=0`, and returning the exact offer string as given). `bearer()` matches `Bearer ` case-insensitively and trims the token.
- **Observers and timeouts:** `on_before_commit` runs LIFO, once, right before headers reach the transport (covering buffered commit, `flush_headers`, `upgrade_websocket` 101 or handshake rejection, and `reject_upgrade`). `on_complete` runs LIFO after finish, error handling, abort, unhandled failure, or cancellation; hook failures log `on_complete_failed` and cancellation propagates. `run_with_timeout(timeout_ms, action, on_timeout?)` runs `action` inline if `timeout_ms <= 0` or an enclosing deadline is already earlier or equal; on expiry it force-aborts committed or socket-blocked I/O, cancels and joins the child Task, then either returns silently (if already committed or aborted) or runs `reset_body()` followed by `on_timeout(ctx)` or `HttpError(503, "Service Unavailable", "timeout")`.
- **Body reading:** `body()` reads and caches the remaining body; `read_body_chunk()` streams until `nil`. Both enforce `body_limit` (declared `Content-Length` or running total) and raise `HttpError(413, "Content Too Large", "body_too_large")`, which is sticky on subsequent reads and marks `Connection: close`. Upgrade offers and `CONNECT` read as `""` and `nil`.
- **Response builders:** Mutating methods after commit raise `"mk: response headers have already been committed"` (or `"mk: response was aborted"`). `status(code)` accepts `200..999` only (raising `"mk: HTTP status must be between 200 and 999"` otherwise). `send(data)` sets no `Content-Type`; `send_string(text)` sets `text/plain; charset=utf-8` only if no `Content-Type` is set; `html(markup)` always sets `text/html; charset=utf-8`; `json(payload, ...)` and `json_raw(encoded)` set `application/json` (no charset). `type(ext_or_mime, charset?)` maps unknown extensions to `application/octet-stream` and appends `; charset=utf-8` to text-like types (`text/*`, `application/json`, `application/javascript`, `application/xml`, `image/svg+xml`, `application/yaml`) when no `;` parameter or explicit charset is present. `redirect(url, code?)` defaults to `303`. `send_status(code)` writes the reason phrase only if the body is empty and `code` is not `204`, `205`, or `304`. `no_content()` sets `204` and clears the body.
- **`send_file(file_path, download?)`:** Not buffered. Calls `fs.stat` (follows symlinks; applies **no path confinement**), raises `HttpError(404, "Not Found", "file_not_found")` when missing or non-file, sets `attachment(file_path)` when `download` is `true` (or sets `Content-Type` from extension if unset), and calls `send_stream(file, size)`, committing headers immediately.
- **Commit rules, streaming, and errors:** At commit, a non-empty body without `Content-Type` gets `text/plain; charset=utf-8`; `204` and `304` strip `Content-Length` and `Transfer-Encoding`; `205` forces `Content-Length: 0`; `HEAD` sends no body bytes and preserves an explicit `Content-Length` on an empty body; `server_header` adds `Server` if absent. `write_chunk` commits first if needed and raises `"mk: response is already complete"` after finish. `send_stream` raises `"mk: send_stream content_length must be non-negative"` on negative lengths. An uncommitted `HttpError` resets the body (keeping headers) and invokes `Config.error_handler` (falling back to `default_error_handler` if the handler raises another `HttpError`); a committed `HttpError` aborts an unfinished stream. Unhandled non-`HttpError` failures on a live server abort the transport and log `http_request_failed`.
- **Closing and draining:** When a response or request carries `Connection: close` (including uncommitted `413`, shutdown, retiring or ephemeral sessions, and `retire_worker`), `mk` skips draining the unread request body and closes cleanly. Otherwise unread body bytes are drained up to `body_limit` (exceeding `body_limit` releases the transport).
- **WebSockets:** `upgrade_websocket(options?)` runs `on_before_commit` hooks, copies buffered headers and `Server` onto the `101` response, and closes the connection when the chain ends. Handshake failures finish the response and raise `HttpError(failure.status or 400, msg, "websocket_handshake", failure)`. `reject_upgrade(code)` accepts `400..599` (otherwise raises `"mk: upgrade rejection status must be 400..599"`) and sends a bodyless response with `Content-Length: 0` and `Connection: close`.
- **Workers and logging:** `worker_id()` is `0` on the parent and in `App:test`. Bind `local logger? = ctx:logger()` (returns `nil` when `Config.logger` is unset); `ctx:log(...)` is a no-op without a logger. `retire_worker()` immediately and causally detaches a session worker and sets `Connection: close`; it is a no-op on the parent and on pool workers.

### `Bind`

```titan
record Bind
function Bind:json(
  schema: reflect.Type?, ...: json.DecodeOption
): value
function Bind:named(
  type_name: string, ...: json.DecodeOption
): value
function Bind:object(...: json.DecodeOption): {string: value}
function Bind:array(...: json.DecodeOption): {value}
```

`Bind:named(type_name, ...)` resolves `reflect.NamedType(type_name)`, which requires the full logical module name followed by the type name (for example, `"service.app.CreateItem"`).

Classification runs in strict order:

| Step and Condition | Result |
| --- | --- |
| 1. `not ctx:is_json()` | `HttpError(415, "Unsupported Media Type", "unsupported_media_type")` |
| 2. Body exceeds `Config.body_limit` | `HttpError(413, "Content Too Large", "body_too_large")` |
| 3. Empty body (`""`) | `HttpError(400, "empty JSON request body", "empty_body")` |
| 4. `json.Error` programmer code (`unknown_type`, `constructor_unavailable`, `unsupported_type`, `invalid_option`) or non-`json.Error` from `Record.new` | Re-raised unchanged |
| 5. `json.Error` schema mismatch (`type_mismatch`, `missing_field`, `unknown_field`, `invalid_union`, `unknown_variant`, `non_integral`, plus `integer_range` or `number_range` when `schema ~= nil`) | `HttpError(422, err.message, err.code, err)` |
| 6. Any other `json.Error` (syntax, UTF-8, escape, duplicate key, or depth and byte limits) | `HttpError(400, err.message, err.code, err)` |

## Workers and Supervision

```titan
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
  const size: integer?            -- default 1 (>= 1)
  const queue_capacity: integer?  -- default 128 (>= 1)
  const on_start: WorkerInit?
end

record SessionOptions
  const session_id: SessionExtractor
  const queue_capacity: integer?  -- default 64 (>= 1)
  const max_sessions: integer?    -- optional cap (>= 1)
  const ephemeral: boolean?       -- default false
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
function TransferableHandler.from_transfer_payload(
  payload: string
): TransferableHandler

record TransferableErrorHandler
function TransferableErrorHandler.new(
  fn: ErrorHandler
): TransferableErrorHandler
function TransferableErrorHandler:call(ctx: Context, err: HttpError)
function TransferableErrorHandler:to_transfer_payload(): string
function TransferableErrorHandler.from_transfer_payload(
  payload: string
): TransferableErrorHandler

record TransferableWorkerInit
function TransferableWorkerInit.new(
  fn: WorkerInit
): TransferableWorkerInit
function TransferableWorkerInit:call(wctx: WorkerContext)
function TransferableWorkerInit:to_transfer_payload(): string
function TransferableWorkerInit.from_transfer_payload(
  payload: string
): TransferableWorkerInit
```

- **Dispatcher identity:** Titan union values compare by reference identity. Each distinct `WorkerMode.pool(...)` or `WorkerMode.session(...)` value creates a separate dispatcher (its own thread pool or session family). Reuse one `WorkerMode` variable to share a pool across routes or groups. `WorkerMode.parent()` always refers to the single parent dispatcher.
- **Lazy validation:** `PoolOptions` and `SessionOptions` integer bounds (`>= 1`) are validated when the dispatcher is created (`App.new` for `Config.workers`; otherwise first freeze or group supervision query).
- **Pool dispatch:** Spawns `size` threads during `App:start` and waits for all `on_start` callbacks before returning. Routes requests round-robin across live, non-retiring slots; keep-alive follow-ups return to the parent for reclassification. No live slot produces `HttpError(503, "Service Unavailable", "no_workers")`. Any pool thread exit outside shutdown fails the `App` (crashes log `worker_failed`).
- **Session dispatch:** `session_id(meta)` runs on the parent before socket handoff. Returning a string selects or spawns that session's worker (there is no idle eviction; avoid returning `""`, which behaves as a session key on the parent but appears as `nil` on the worker). Returning `nil` falls back to the root dispatcher (or raises `HttpError(500, "session selector returned no session for the root dispatcher", "no_session")` if the root itself is a session dispatcher). Reaching `max_sessions` raises `HttpError(503, "Service Unavailable", "max_sessions")`. Raising `HttpError` in `session_id` runs parent-reachable middleware and `Config.error_handler`; non-`HttpError` failures propagate out of the HTTP handler. Crashes and `stop_worker` stay isolated to that session and invoke `on_exit(session_id, worker_id, failed)` on the parent after OS thread join.
- **Ephemeral sessions (`ephemeral = true`):** Each worker handles one exchange, marks `Connection: close`, and retires; queued follow-ups bounce back to the parent and spawn fresh workers.
- **Closure transfer scope:** For each worker dispatcher, `mk` transfers its route handlers, every overlapping middleware (all middleware for a worker root), session route handlers on a worker root (for `nil`-session fallback), `Config.error_handler`, and `on_start`. All transferred closures must satisfy Titan's cross-state transfer rules (no captured `mk.App`, direct Arrays or Maps, Interfaces, `owned` C storage, cycles, or `local` nominal types). `SessionOptions.session_id` and `on_exit` stay on the parent.
- **`WorkerContext`:** `id` starts at `1` and increases across all dispatchers. Bind `local logger? = wctx.logger` (it is `nil` when `Config.logger` is unset). `defer_cleanup` callbacks run LIFO on worker exit; failures log `worker_cleanup_failed`.

*(Note: `workers.titan` also exposes internal wire records `ExchangeEnvelope`, `ExchangePipe`, `RetireNotice`, `EntrySpec`, `WorkerSettings`, and `WorkerBootstrap` for cross-thread transport; applications do not construct them directly.)*

## Testing

```titan
record TestRequest
  const method: string
  const target: string
  const headers: http.Headers?
  const body: string?
  const tls: boolean?
end

record TestConfig
  const timeout_ms: integer?       -- default 1000 ms (0 disables)
  const fail_on_timeout: boolean?  -- default true
end

record TestResponse
  const status: integer
  const headers: http.Headers
  const body: string
end
function TestResponse:header(name: string): string?
function TestResponse:json(
  schema: reflect.Type?, ...: json.DecodeOption
): value

record TestServer
  const host: string
  const port: integer
  const base_url: string
end
function TestServer:request(
  method: string, target: string, options: http.RequestOptions?
): TestResponse
function TestServer:close()

function App:test(
  req: TestRequest, config: TestConfig?
): TestResponse
function App:listen_test(
  host: string?, listen_config: ListenConfig?
): TestServer
```

- **`App:test(req, config?)`:** Freezes registration, copies headers, uppercases `req.method`, adds `Host: example.com` if absent, adds `Content-Length` for non-empty `body` if neither `Content-Length` nor `Transfer-Encoding` is set, and sets scheme `"https"` when `tls == true`. Raises `"mk: App:test runs only parent-dispatched requests in memory; pool and session worker routes need App:listen_test"` when classification lands on a pool or session worker (selector `HttpError`s and `nil`-session fallbacks to a parent root still execute). `upgrade_websocket` raises `HttpError(501, "WebSocket upgrade requires a live server (App:listen_test)", "upgrade_unavailable")`, which `error_handler` renders as a `501` response. `peer_address()` is `nil`. On timeout, `fail_on_timeout == true` raises `"mk: App:test timed out after N ms"`, while `false` returns whatever was committed (or `TestResponse(0, <empty headers>, "")` if nothing committed). An aborted response raises `"mk: connection aborted"`, and unexpected handler errors propagate unchanged.
- **`App:listen_test(host?, listen_config?)`:** Binds `host or "127.0.0.1"` (accepts bare or bracketed IPv6) on port `0` via `App:start`, serves in a background Task that swallows non-cancellation `serve` failures, and populates `TestServer.host`, `TestServer.port`, and `TestServer.base_url` (`https://` when `listen_config.cert_file ~= nil`). `TestServer:request` reads the full response body and closes the response. `TestServer:close()` is idempotent, closes its internal HTTP client, calls `App:shutdown()`, and joins the serve Task.
