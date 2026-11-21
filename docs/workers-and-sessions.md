# Workers and Sessions

`titan-mk` executes HTTP handlers in one of three modes modeled by `mk.WorkerMode`: directly on the `parent` event loop, across a pre-spawned `pool` of OS worker threads, or inside on-demand per-`session` OS worker threads. Each worker runs in its own isolated Lua state via `titan.thread`, receiving live HTTP connections through `titan.http.Exchange` manual handoff.

## `WorkerMode`: `parent`, `pool`, and `session`

```text
union WorkerMode
  parent()
  pool(options: PoolOptions?)
  session(options: SessionOptions)
end

record PoolOptions
  const size: integer?             -- default 1 (>= 1)
  const queue_capacity: integer?   -- default 128 (>= 1)
  const on_start: WorkerInit?
end

record SessionOptions
  const session_id: SessionExtractor
  const queue_capacity: integer?   -- default 64 (>= 1)
  const max_sessions: integer?     -- optional active-session cap (>= 1)
  const ephemeral: boolean?        -- default false
  const on_start: WorkerInit?
  const on_exit: SessionExitHook?
end
```

Assign a `WorkerMode` at any granularity before `App:start()` / `App:listen()`:

- **Application default:** `mk.Config { workers = mode }` (defaults to `mk.WorkerMode.parent()`).
- **Route group:** `app:group_with("/api", mk.GroupOptions { workers = mode })` (inherited by nested groups and routes in the group).
- **Single route:** `app:post("/jobs", run_job):workers(mode)`.
- **Mounted sub-app:** `app:mount(prefix, sub_app)` preserves each mounted route's explicit mode or `sub_app`'s `Config.workers`.

### `WorkerMode.parent()`

Requests execute directly in Tasks on the parent HTTP server's `async` Runtime without serializing closures or detaching sockets. This is the default mode and the only mode that runs in memory under `App:test(...)`.

### `WorkerMode.pool(options?)`

Pre-spawns `size` OS worker threads (default `1`, queue capacity `128` exchanges per worker) during `App:start()`. Incoming exchanges dispatch round-robin across live, non-retiring pool slots. If no live pool slot is available (or the app is shutting down), the parent replies with `503 Service Unavailable` (`"no_workers"` or `"shutting_down"`).

### `WorkerMode.session(options)`

Routes requests for the same logical session to a dedicated OS worker thread spawned on demand:

1. On the parent, `options.session_id(meta)` runs with read-only [`RequestMeta`](context-and-binding.md#requestmeta-and-trust_forwarded_headers) before detaching the socket:
   - Returning a `string` selects (or spawns) that session's worker (enforcing `max_sessions` with `503` `"max_sessions"` when full).
   - Returning `nil` falls back to `Config.workers` without spawning a session worker (if the root dispatcher itself is a `session` dispatcher, `mk` raises `HttpError(500, ..., "no_session")`).
   - Raising `mk.HttpError` runs `Config.error_handler` in place on the parent.
2. When `options.ephemeral = true`, the spawned session worker retires around its first exchange—useful for one-shot isolated workloads. If handoff fails or cancels before delivering an exchange to a newly spawned ephemeral worker, the parent retires that unused worker immediately so it never idles forever.
3. `options.on_exit` (`function (session_id: string, worker_id: integer, failed: boolean): ()`) runs **only on the parent** after the session worker's OS thread has joined.

### Immediate Session Retirement (`Context:retire_worker()`)

Inside a session worker handler, call `ctx:retire_worker()` to retire that session worker causally:

- Marks the current response's connection to close after completion (`Connection: close`).
- Signals the parent immediately to detach the session slot from the active session table and close its intake pipe, so any subsequent request for the same `session_id` spawns a fresh worker immediately without racing with the retiring worker's cleanup.
- On `parent` or `pool` workers, `ctx:retire_worker()` is a safe no-op.

### Keep-Alive Return Across Worker Modes

After a worker finishes a reusable HTTP/1.1 exchange (without `retire_worker()`, `abort()`, `Connection: close`, or WebSocket takeover), the worker keeps the idle keep-alive connection and waits under `idle_timeout_ms` for the next request's headers. Once that follow-up request's headers are parsed, the worker sends the already-parsed exchange back to the parent through the internal `return_pipe`, where the parent classifies it fresh and dispatches it to any route or worker mode.

## Titan Cross-State Transfer Constraints and `Transferable*` Wrappers

Every `pool` and `session` worker runs in an independent Lua state on its own OS thread. When `App:start()` (or on-demand session spawn) creates a worker, it sends a `WorkerBootstrap` packet over `titan.thread` / `titan.transfer`:

- **Closure snapshot rules:** Every `Handler`, `ErrorHandler`, `WorkerInit` (`on_start`), and middleware callback reaching a worker thread must satisfy Titan's cross-state closure transfer rules:
  - Allowed captures include scalars, plain transferable records/unions, transferable closures, mutable upvalues (which become fresh independent cells on the destination, losing aliasing), and records with custom transfer hooks (such as `thread.Sender<|T|>`, `net.Connection`, or `fs.File`, which transfer ownership).
  - Rejected captures include reference cycles, direct Arrays or Maps (even `const`), Interfaces, `owned` C storage, `local` nominal types, non-nil Lua Udata, and records with `local` fields and no custom transfer hooks (such as `http.Server` and `mk.App`).
  - Note that `SessionOptions.session_id` and `SessionOptions.on_exit` run **only on the parent** and never cross thread boundaries.
- **`Transferable*` wrappers:** `mk` exports `TransferableHandler`, `TransferableErrorHandler`, and `TransferableWorkerInit` (each implementing `to_transfer_payload()` and `from_transfer_payload()` over `transfer.TransferValue` + `protobuf`) to carry typed callbacks inside `WorkerBootstrap` (and `mk.middleware.keyauth.CustomExtractor` follows the same pattern).
- **Socket handoff safety:** Detached `http.Exchange` payloads cross between parent and workers exclusively through single-consumer `ExchangePipe` queues using synchronous `try_send` / `try_receive` with capacity-1 wake signals, ensuring Task cancellation never races an inline packet commit or leaks a detached OS socket descriptor.

## Per-State Module Locals Initialized in `on_start`

`titan-mk` intentionally has no global service registry. Because each worker thread owns a separate Lua state, store per-worker mutable resources—such as SQLite connections, outbound `http.Client` pools, or in-memory caches—in ordinary module-level `local` variables initialized inside `on_start(wctx: WorkerContext)`:

```titan
local http = import "http"
local mk = import "mk"

-- One independent variable per Lua state (parent + each worker thread).
local worker_client: http.Client? = nil

local function init_worker(wctx: mk.WorkerContext)
  local client = http.Client()
  worker_client = client
  wctx:defer_cleanup(function ()
    worker_client = nil
    client:close()
  end)
end

local function proxy_status(ctx: mk.Context)
  local client? = worker_client
  if client == nil then raise mk.HttpError(503, "worker not initialized") end
  local res = client:request("GET", "https://example.invalid/health")
  defer res:close()
  ctx:status(res.status):send_string("upstream ok")
end
```

`WorkerContext` fields and methods:

- `wctx.id: integer` — unique worker ID (`>= 1`; `ctx:worker_id()` returns `0` on the parent and in `App:test`).
- `wctx.session_id: string?` — active session ID for session workers, `nil` for pool workers (also accessible via `ctx:session_id()`).
- `wctx.logger: log.Logger?` — non-blocking cross-thread forwarding logger wired to the parent's `Config.logger` when configured (also accessible via `ctx:logger()` / `ctx:log(...)`).
- `wctx:defer_cleanup(fn)` — registers cleanup callbacks executed in **LIFO order** when the worker thread exits.

## Pool Failure vs. Session Isolation

`mk` treats pool worker failures and session worker failures differently by design:

| Event outside shutdown | `pool` worker | `session` worker |
| --- | --- | --- |
| Uncaught thread error / panic or `App:stop_worker(id)` | **Fails the entire `App`:** logs `"worker_failed"` (on error; `stop_worker` cancels without logging `"worker_failed"`), triggers forced shutdown, and causes `App:serve()` / `App:listen()` to raise the failure error. A pool never silently loses capacity. | **Isolated to that session:** logs `"worker_failed"` (on error), detaches the session slot, runs `on_exit(session_id, worker_id, failed)` after OS join, discards unread queued exchanges, and lets future requests spawn a fresh worker. |
| Normal handler `HttpError` | Handled by `Config.error_handler`; worker stays alive. | Handled by `Config.error_handler`; worker stays alive. |
| Unhandled non-`HttpError` in a request (without `recover`) | Aborts that connection and logs `"http_request_failed"`; worker stays alive. | Aborts that connection and logs `"http_request_failed"`; worker stays alive. |

## Lifecycle, Supervision, and Shutdown

### Starting and Serving

```titan
app:start("127.0.0.1:8080", mk.ListenConfig {
  backlog = 128,
  reuse_port = false,
  cert_file = nil,
  key_file = nil,
})
app:serve()
-- Or equivalently: app:listen("127.0.0.1:8080", listen_config)
```

`App:start(addr, listen_config?)` freezes routes, opens the `http.Server` (or `http.listen_tls` when `cert_file` is supplied), configures `read_ahead(false)` and `header_limit`, spawns pool workers and supervision Tasks, and invokes `Hooks:on_listen(ListenData)` hooks.

### `App:initiate_shutdown()` vs. `App:shutdown()`

- **`app:initiate_shutdown()`:** Begins shutdown asynchronously and returns immediately without waiting. Safe to call from **request handlers, lifecycle hooks, signal handlers, and monitors**.
- **`app:shutdown()`:** Begins shutdown and awaits complete retirement of listeners, parent requests, worker threads, and log forwarding. **Raises** if called from inside an active request handler or a lifecycle hook (call `initiate_shutdown()` instead to avoid self-deadlock).

### Ordered Shutdown Sequence

1. Close the `http.Server` listener (no new connections accepted; any in-flight arrival sees `503` `"shutting_down"`).
2. Run `Hooks:on_pre_shutdown` hooks.
3. Drain active parent requests up to `Config.shutdown_timeout_ms` (default 10 s), then `force_abort()`, cancel, and join any remaining parent Tasks and adopted keep-alive Tasks.
4. Close every worker pipe, cancel and join every pool and session worker thread and monitor (running worker `defer_cleanup` callbacks and session `on_exit` hooks), and close and join the retirement listener.
5. Close and drain `return_pipe` and adopted connections, discarding any undelivered `http.Exchange` payloads cleanly.
6. Close and drain the cross-worker log forwarder into the parent's `Config.logger`.
7. Run `Hooks:on_post_shutdown(first_failure?)` hooks.

### Worker Inspection APIs

On `App` (root dispatcher or cross-dispatcher) and `Group` (scoped to that group's dispatcher):

- `app:is_running(): boolean`
- `app:pool_workers(): const {WorkerInfo}` / `group:pool_workers()`
- `app:pool_next_index(): integer` / `group:pool_next_index()`
- `app:session_worker(session_id): WorkerInfo?` / `group:session_worker(session_id)`
- `app:active_session_ids(): const {string}` / `group:active_session_ids()`
- `app:is_worker_alive(worker_id): boolean`
- `app:stop_worker(worker_id): boolean` (stopping a session worker retires only that session; stopping a pool worker outside shutdown fails the `App`)
