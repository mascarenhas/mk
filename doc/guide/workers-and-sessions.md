# Chapter 4: Workers and Sessions

Titan threads are **shared-nothing Lua states** running on OS threads via `titan.thread`. `titan-mk` builds a race-free worker model on top of `titan.thread`, `titan.transfer`, and `titan.http.Exchange` so you can keep lightweight routes on the parent event loop, spread CPU-heavy or blocking work across a worker `pool`, or isolate per-tenant/per-world state inside on-demand `session` workers.

For exact type definitions and inspection methods, see [`mk` Reference — Workers and Supervision](../reference/mk.md#workers-and-supervision).

## Choosing a `WorkerMode`

`mk.WorkerMode` can be set application-wide (`mk.Config { workers = mode }`), per group (`mk.GroupOptions { workers = mode }`), or per route (`RouteHandle:workers(mode)`), and is preserved across `App:mount`:

1. **`mk.WorkerMode.parent()` (default):** Executes directly in Tasks on the parent HTTP server's event loop. Zero serialization or socket handoff overhead; supported by both `App:test` and `App:listen`.
2. **`mk.WorkerMode.pool(mk.PoolOptions { size = 4, queue_capacity = 128, on_start = init })`:** Pre-spawns `size` OS worker threads (default `1`, queue capacity `128`) during `App:start()`. Incoming exchanges dispatch round-robin across live, non-retiring workers (`503` `"no_workers"` if none are available).
3. **`mk.WorkerMode.session(mk.SessionOptions { session_id = extract, ... })`:** Runs `session_id(meta)` on the parent against read-only [`RequestMeta`](routing-and-handlers.md#inspecting-requests-context-and-requestmeta) before detaching the socket:
   - Returning a `string` routes the request to that session's dedicated OS worker (spawning it on demand; enforcing optional `max_sessions` with `503` `"max_sessions"`).
   - Returning `nil` falls back to `Config.workers` without spawning a session worker (raising `HttpError(500, ..., "no_session")` if the root dispatcher itself is a `session` dispatcher).
   - Raising `mk.HttpError` runs `Config.error_handler` in place on the parent.

### Ephemeral Sessions and `Context:retire_worker()`

- **`SessionOptions.ephemeral = true`:** Retires the spawned session worker around its first exchange—ideal for one-shot isolated jobs. If handoff fails or cancels before delivering an exchange to a freshly spawned ephemeral worker, the parent retires that unused worker immediately so it never idles forever.
- **`ctx:retire_worker()`:** Call inside a session worker handler to retire that worker immediately and causally. It closes the response's connection after completion and signals the parent to detach the session slot and close its intake pipe right away, so the next request for the same `session_id` spawns a fresh worker without racing with the retiring worker's teardown. (On `parent` or `pool` workers, `retire_worker()` is a safe no-op.)

### Keep-Alive Across Worker Modes

After a worker finishes a reusable HTTP/1.1 exchange (without `retire_worker()`, `abort()`, `Connection: close`, or WebSocket takeover), the worker keeps the idle keep-alive connection and waits under `idle_timeout_ms` for the next request's headers. Once that follow-up request's headers are parsed, the worker sends the already-parsed exchange back to the parent through the internal `return_pipe`, where the parent classifies it fresh and dispatches it to any route or worker mode.

## Per-State Module Locals Initialized in `on_start`

Because each worker thread runs in its own isolated Lua state, `titan-mk` needs no global service container. Store per-worker mutable state (SQLite handles, outbound `http.Client` pools, caches) in ordinary module-level `local` variables initialized inside `on_start(wctx: mk.WorkerContext)` and torn down via `wctx:defer_cleanup(fn)` (run LIFO on worker exit):

```titan
local http = import "http"
local mk = import "mk"

-- Independent instance in every Lua state (parent + each worker thread).
local upstream_client: http.Client? = nil

local function init_worker(wctx: mk.WorkerContext)
  local client = http.Client()
  upstream_client = client
  wctx:defer_cleanup(function ()
    upstream_client = nil
    client:close()
  end)
end

local function proxy_health(ctx: mk.Context)
  local client? = upstream_client
  if client == nil then raise mk.HttpError(503, "worker not initialized") end
  local res = client:request("GET", "https://example.invalid/health")
  defer res:close()
  ctx:status(res.status):send_string("upstream ok")
end
```

`wctx` also provides `wctx.id` (`>= 1`), `wctx.session_id` (`string?`), and `wctx.logger` (`log.Logger?`, a non-blocking cross-thread forwarding logger wired to `Config.logger`, or `nil` when `Config.logger` is unset). Because `wctx.logger` is optional, bind it with `local logger? = wctx.logger`—omitting `?` asserts non-nil in Titan and raises when no logger is configured.

## Cross-State Closure Transfer Constraints and `Transferable*`

When `App:start()` or on-demand session creation spawns a worker, it sends a `WorkerBootstrap` packet across threads via `titan.thread` / `titan.transfer`. Every `Handler`, `ErrorHandler`, `WorkerInit`, and middleware closure reaching a worker must follow Titan's cross-state closure transfer rules:

- **Allowed captures:** Scalars, plain transferable records/unions, transferable closures, mutable upvalues (which become fresh independent cells on the destination, losing aliasing), `thread.Sender<|T|>` / `Receiver<|T|>` endpoints (which retain a fresh reference and leave the source handle valid), and manual-handoff records with custom transfer hooks (such as `net.Connection` or `fs.File`, which transfer ownership and detach the source).
- **Rejected captures:** Reference cycles, direct Arrays or Maps (even `const`), Interfaces, `owned` C storage, `local` nominal types, non-nil Lua Udata, and records with `local` fields and no custom transfer hooks (such as `http.Server` and `mk.App`).
- **Parent-only callbacks:** `SessionOptions.session_id` and `SessionOptions.on_exit` execute strictly on the parent and never cross thread boundaries.

`mk` wraps callbacks in `TransferableHandler`, `TransferableErrorHandler`, and `TransferableWorkerInit` (each implementing `to_transfer_payload` / `from_transfer_payload` over `transfer.TransferValue` + `protobuf`), and `mk.middleware.keyauth.CustomExtractor` uses the same pattern.

Detached `http.Exchange` payloads travel between parent and workers exclusively through single-consumer `ExchangePipe` queues using synchronous `try_send` / `try_receive` with capacity-1 wake signals, ensuring Task cancellation never races an inline packet commit or leaks a detached OS socket descriptor.

## Pool Failure vs. Session Isolation

| Event outside shutdown | `pool` worker | `session` worker |
| --- | --- | --- |
| Uncaught thread error / panic or `App:stop_worker(id)` | **Fails the entire `App`:** logs `"worker_failed"` (on error; `stop_worker` cancels without logging `"worker_failed"`), triggers forced shutdown, and causes `App:serve()` / `App:listen()` to raise the failure error. A pool never silently loses capacity. | **Isolated to that session:** logs `"worker_failed"` (on error), detaches the session slot, runs `on_exit(session_id, worker_id, failed)` on the parent after OS join, discards unread queued exchanges, and lets future requests spawn a fresh worker. |
| Normal handler `HttpError` | Handled by `Config.error_handler`; worker stays alive. | Handled by `Config.error_handler`; worker stays alive. |
| Unhandled non-`HttpError` in a request (without `recover`) | Aborts that connection and logs `"http_request_failed"`; worker stays alive. | Aborts that connection and logs `"http_request_failed"`; worker stays alive. |

## Graceful Shutdown: `initiate_shutdown()` vs. `shutdown()`

- **`app:initiate_shutdown()`:** Begins shutdown asynchronously and returns immediately. Safe to call from **request handlers, lifecycle hooks, signal handlers, and monitors**.
- **`app:shutdown()`:** Begins shutdown and awaits complete retirement of listeners, requests, worker threads, and log forwarding. **Raises** if called from inside an active request handler or a lifecycle hook (call `initiate_shutdown()` there instead to prevent self-deadlock).

Shutdown always runs in this exact order:

1. Close the `http.Server` listener (in-flight arrivals see `503` `"shutting_down"`).
2. Run `Hooks:on_pre_shutdown` hooks.
3. Drain active parent requests up to `Config.shutdown_timeout_ms` (default 10 s), then `force_abort()`, cancel, and join any remaining parent Tasks and adopted keep-alive Tasks.
4. Close every worker pipe, cancel and join every pool and session worker thread and monitor (running worker `defer_cleanup` callbacks and session `on_exit` hooks), and close and join the retirement listener.
5. Close and drain `return_pipe` and adopted connections, discarding any undelivered `http.Exchange` payloads cleanly.
6. Close and drain the cross-worker log forwarder into `Config.logger`.
7. Run `Hooks:on_post_shutdown(first_failure?)` hooks.

Because `on_pre_shutdown` and `on_post_shutdown` also run on startup rollback (when `App:start()` fails after listener bind) and on `App:shutdown()` of a never-started `App`, keep hook-owned teardown idempotent and safe when startup did not complete.

---

For complete API signatures, continue to [Part II: Module Reference](../index.md#part-ii--module-reference).
