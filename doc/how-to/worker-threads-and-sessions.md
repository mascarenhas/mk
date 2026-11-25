# How to Run Handlers on OS Worker Pools and Session Workers

Dispatch routes onto `WorkerMode.pool` and `WorkerMode.session` OS threads,
initialize per-worker state, meet cross-state closure transfer rules,
supervise live workers, and shut down cleanly. See the
[`mk` Module Reference](../reference/mk.md#workers-and-supervision) for
complete option fields and
[About Shared-Nothing Workers and Closure Transfer](../explanation/worker-architecture.md)
for the architectural rationale.

## Choose and Configure a Worker Mode

Every route runs on one of three `mk.WorkerMode` variants:

- `mk.WorkerMode.parent()` (default): executes on the parent HTTP listener
  state with no cross-thread handoff.
- `mk.WorkerMode.pool(mk.PoolOptions?)`: dispatches requests round-robin
  across a fixed pool of OS threads spawned during `App:start()`.
- `mk.WorkerMode.session(mk.SessionOptions)`: routes all requests with the
  same session key to one dedicated OS thread spawned on demand.

### Share one `WorkerMode` value to share a pool

Titan union values compare by reference identity. Each distinct
`mk.WorkerMode.pool(...)` or `mk.WorkerMode.session(...)` expression creates
its own dispatcher and thread pool. Bind the mode to a local variable and
reuse that variable across every route or group that should share workers:

```titan
local mk = import "mk"

local cpu_pool = mk.WorkerMode.pool(mk.PoolOptions {
  size = 4,
  queue_capacity = 128,
})

local app = mk.App()
app:get("/health", health_handler)               -- parent
app:post("/render", render_handler):workers(cpu_pool)

local jobs = app:group_with("/jobs", mk.GroupOptions {
  workers = cpu_pool,                            -- same pool
})
jobs:post("/resize", resize_handler)
```

Set `mk.Config { workers = cpu_pool }` when every route—including unmatched
requests—should default to that pool. Nested groups inherit their parent
group's mode unless `GroupOptions.workers` overrides it. `App:mount()`
preserves each mounted route's effective mode, inheriting the sub-app's
`Config.workers` when the route did not set its own.

`Config.workers` validates inside `App.new()`. Group and route
`PoolOptions` and `SessionOptions` validate lazily at registration freeze
(`App:start()` or `App:test()`) or on a dispatcher inspection call.
`App:start()` blocks until every pool worker finishes `on_start`; if any
pool worker fails before becoming ready, `App:start()` rolls back and raises
`"mk: pool worker N failed to start: ..."`.

### Configure session workers

Supply a `session_id(meta: mk.RequestMeta): string?` selector that runs on
the parent before the socket detaches:

```titan
local mk = import "mk"

local function extract_session(meta: mk.RequestMeta): string?
  local sid? = meta:query_opt("sid")
  if sid == nil or sid == "" then
    return nil
  end
  return sid
end

local sessions = app:group_with("/sessions", mk.GroupOptions {
  workers = mk.WorkerMode.session(mk.SessionOptions {
    session_id = extract_session,
    max_sessions = 200,
    on_exit = function (
      sid: string, worker_id: integer, failed: boolean
    )
      -- Runs on the parent after the worker thread joins.
    end,
  }),
})
```

Account for four session rules:

- **Return `nil`, never `""`, when no session applies:** Returning `nil`
  falls back to the root dispatcher (or raises `500` `"no_session"` when the
  root itself is a session dispatcher). Returning `""` creates a session
  entry on the parent while the worker sees `ctx:session_id() == nil` and
  treats `ctx:retire_worker()` as a no-op.
- **Raise `mk.HttpError` for invalid session input:** An `mk.HttpError`
  raised by `session_id` runs through parent-reachable middleware and
  `Config.error_handler`. Non-`HttpError` exceptions escape the HTTP
  handler.
- **Bound live sessions:** Persistent session workers have **no idle
  eviction**—each live session holds one OS thread until `retire_worker()`,
  `stop_worker()`, a crash, or shutdown. Always set `max_sessions` (enforced
  per session dispatcher; excess sessions fail with `503` `"max_sessions"`).
- **Use `ephemeral = true` for one-shot isolation:** An ephemeral session
  worker handles one exchange, sends `Connection: close`, and exits; any
  queued exchanges for the same key return to the parent and spawn fresh
  workers.

## Initialize Per-Worker State

Each OS worker thread runs its own Lua state, so module-level `local`
variables are private to that worker with zero locking. Open per-worker
connections or allocate per-worker state inside `on_start(wctx)` and
register LIFO cleanup callbacks with `wctx:defer_cleanup(fn)`:

```titan
local mk = import "mk"

local worker_tag: string?

local function init_worker(wctx: mk.WorkerContext)
  worker_tag = "worker-" .. wctx.id

  local logger? = wctx.logger
  if logger ~= nil then
    logger:info("worker_ready", { ["worker_id"] = wctx.id })
  end

  wctx:defer_cleanup(function ()
    worker_tag = nil
  end)
end

local pool = mk.WorkerMode.pool(mk.PoolOptions {
  size = 4,
  on_start = init_worker,
})
```

Always bind `wctx.logger` as an optional (`local logger? = wctx.logger`).
Binding it without `?` inserts a nil assertion that fails whenever
`Config.logger` is `nil`. Inside route handlers, call `ctx:worker_id()`,
`ctx:session_id()`, and `ctx:log(...)` (which forwards automatically to
`Config.logger`).

## Satisfy Closure Transfer Rules

When an `App` spawns pool or session workers, `mk` transfers a bootstrap
snapshot containing:

1. Every route handler belonging to that dispatcher (plus session route
   handlers on a worker root dispatcher, for `nil`-session fallback).
2. Every middleware whose prefix can overlap those routes (all middleware
   when `Config.workers` is a pool or session).
3. `Config.error_handler` (always transferred to every worker dispatcher).
4. `on_start`.

Keep `SessionOptions.session_id`, `SessionOptions.on_exit`, and `App:hooks()`
callbacks parent-only; they never leave the parent state.

Every transferred closure must obey Titan's cross-state capture rules:

- **Allowed captures:** Primitives, strings, nested Titan closures, bound
  concrete methods, protobuf-eligible public records and unions,
  packet-scoped reference-counted channel endpoints (`thread.Sender<|T|>`
  and `thread.Receiver<|T|>`), public records defining
  `to_transfer_payload` and `from_transfer_payload` (including
  `mk.Transferable*`), retained `transfer.TransferValue` wrappers, and raw
  C pointers.
- **Rejected captures:** Cycles, direct Arrays and Maps, Interfaces
  (including bound Interface methods), `owned` C storage, `local` nominal
  types, hookless records with `local` fields (such as `mk.App` and
  `http.Server`), and non-`nil` Lua `Udata`.
- **Mutable captures:** Captured mutable locals become fresh independent
  cells in each worker state; mutations never replicate back to the parent.
  Use module-level locals for per-worker state or a captured
  `thread.Sender<|T|>` channel to send messages back to the parent.

If you need to store a handler, error handler, or `WorkerInit` inside a
public record that crosses thread boundaries, wrap it with
`mk.TransferableHandler.new(fn)`, `mk.TransferableErrorHandler.new(fn)`, or
`mk.TransferableWorkerInit.new(fn)`.

## Retire and Supervise Workers

To tear down a session worker causally from inside its own handler (for
example, on logout or session completion), call `ctx:retire_worker()`:

```titan
sessions:post("/logout", function (ctx: mk.Context)
  ctx:retire_worker()
  ctx:status(200):send_string("signed out")
end)
```

`ctx:retire_worker()` sets `Connection: close` and blocks briefly until the
parent has detached the session key, guaranteeing that the next request for
that key spawns a fresh worker. On parent and pool workers,
`ctx:retire_worker()` is a no-op.

From the parent state, inspect and manage live workers with:

- `app:pool_workers()` and `app:pool_next_index()` (root dispatcher's pool)
  or `group:pool_workers()` and `group:pool_next_index()` (a specific
  group's pool).
- `app:session_worker(sid)` and `app:active_session_ids()` (across all
  session dispatchers) or `group:session_worker(sid)` and
  `group:active_session_ids()` (scoped to a group).
- `app:is_worker_alive(worker_id)` and `app:stop_worker(worker_id)`.

Use `app:stop_worker(worker_id)` with care: stopping a **session** worker
retires only that session, runs its `defer_cleanup` and `on_exit`, and lets
future requests respawn cleanly. Stopping a **pool** worker outside shutdown
fails the entire `App`, triggers forced shutdown, and causes `App:serve()`
to raise `"mk: pool worker N was cancelled"`.

## Shut Down Gracefully

Call `app:initiate_shutdown()` whenever shutdown starts from inside an
active request handler or any lifecycle hook (`on_listen`,
`on_pre_shutdown`, `on_post_shutdown`, or `SessionOptions.on_exit`).
Calling `app:shutdown()` from inside a handler or hook raises an error
because it cannot wait on its own Task:

```titan
local mk = import "mk"

app:post("/admin/shutdown", function (ctx: mk.Context)
  ctx:status(202):send_string("shutting down")
  app:initiate_shutdown()
end):workers(mk.WorkerMode.parent())  -- parent-only (captures app)
```

Outside handlers and hooks (for example, in a signal handler Task or a test
driver), call `app:shutdown()` to initiate teardown and block until all
seven shutdown stages finish.

Plan around three shutdown guarantees:

1. **Worker requests have no drain grace period:**
   `Config.shutdown_timeout_ms` (default `10000 ms`) bounds only in-flight
   **parent** handlers. When shutdown reaches the worker stage, `mk` closes
   all worker pipes and cancels every live worker thread immediately,
   aborting in-flight worker transports before joining monitors so
   `defer_cleanup` and `on_exit` run.
2. **Close `Config.logger` in your own application code:** Shutdown closes
   and drains the worker log-forwarding channel, but `mk` never closes
   `Config.logger`. Keep `defer app_logger:close()` in `main()`.
3. **Keep shutdown hooks idempotent:** `on_pre_shutdown` and
   `on_post_shutdown(err?)` run once on normal shutdown, on `App:start()`
   rollback once the listener exists (passing `nil` to `on_post_shutdown`
   unless a shutdown step itself failed), and even on `app:shutdown()` for a
   never-started `App` (which permanently prevents any later `App:start()`).
