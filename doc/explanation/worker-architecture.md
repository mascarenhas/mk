# About Shared-Nothing Workers and Closure Transfer

Most web servers scale across CPU cores either by sharing mutable memory
behind locks across threads or by forking identical OS processes that each
bind the listening socket. `titan-mk` takes a third approach grounded in
Titan's runtime model: one parent listener state dispatches live HTTP
exchanges to shared-nothing OS worker threads, each running an isolated Lua
state and its own libuv event loop.

## Shared-Nothing OS Threads vs. Shared Memory

Titan threads (`titan.thread`) do not share Lua heaps, tables, or garbage
collectors. Moving a route onto a worker thread gives that thread private
ownership of its own VM, memory allocator, and event loop. CPU-heavy JSON
serialization, cryptography, compression, or synchronous SQLite queries on
a worker never pause garbage collection or delay socket reads on the parent
listener or on peer workers.

Because no two threads touch the same Lua object, `titan-mk` services need
no mutexes around route state, caches, or database handles. Isolation
replaces synchronization: each worker owns its local resources exclusively
and communicates across thread boundaries only through explicit value
transfer and bounded channels.

## Comparing `parent`, `pool`, and `session` Trade-Offs

A single `App` can mix all three `WorkerMode` strategies on different
routes, matching concurrency overhead to each endpoint's workload:

- **`parent` mode** executes directly on the listener state with zero
  handoff cost. Lightweight async I/O handlers, health checks, and quick
  lookups belong here because detaching and re-adopting a TCP socket across
  threads would add unnecessary overhead for sub-millisecond work.
- **`pool` mode** spawns a fixed fleet of OS threads during `App:start()`
  and distributes incoming exchanges round-robin across live slots. Every
  pool thread must finish `on_start` before `App:start()` returns, so
  misconfigured worker startup fails deployment immediately rather than on
  the first live request. Because pool slots represent a fixed capacity
  contract, an unexpected pool-thread exit or manual `stop_worker()`
  outside shutdown fails the entire `App` instead of silently shrinking
  capacity.
- **`session` mode** spawns one dedicated OS thread on demand for each
  distinct session key returned by the parent-side `session_id` selector.
  Long-lived per-tenant state, exclusive SQLite connections, and sticky
  WebSocket rooms fit this model naturally. Unlike pools, session failure
  is isolated: if one session worker crashes or stops, the parent detaches
  that key, discards its unread queue, invokes `on_exit`, and respawns a
  fresh worker when the next request for that key arrives.

Persistent session workers have no automatic idle-eviction timer. Choosing
an idle timeout is an application-domain decision—an interactive WebSocket
session and a short-lived checkout workflow have different lifetimes.
`titan-mk` therefore keeps session lifetime explicit through
`max_sessions` bounds, causal teardown via `ctx:retire_worker()`, and
one-exchange `ephemeral` workers rather than guessing when to evict live
state.

### Why `WorkerMode` Identity Defines Dispatchers

Titan union values compare by reference identity rather than deep field
equality. `mk.App` uses that identity directly when mapping routes and
groups to dispatchers: reusing one `WorkerMode.pool(...)` value places
every attached route onto the same thread pool, while constructing a second
`WorkerMode.pool(...)` value creates an isolated second pool.

That design avoids string-keyed global pool registries where typos create
accidental pools or merge unrelated workloads. An application can keep a
fast pool for JSON APIs and a separate bounded pool for heavy report
generation by binding two distinct `WorkerMode` values.

## Keep-Alive Handoff and Cancellation-Safe `ExchangePipe`

HTTP/1.1 keep-alive complicates multi-threaded dispatch because a single
persistent TCP connection can carry a sequence of unrelated requests—first
a static asset on the parent, then a pooled compute request, then a
session-scoped request. Pinning a TCP connection forever to the first
worker it hits would violate per-route worker assignments and starve other
routes.

```text
  Client TCP
      |
      v
  Parent Listener
  1. Read headers, capture peer_address, classify route
  2. Run session_id(meta) if session mode
      |
      |  detach http.Exchange -> ExchangeEnvelope
      |  (sync try_send on single-consumer ExchangePipe)
      v
  OS Worker Thread (isolated Lua state + libuv loop)
  3. adopt exchange (try_receive) -> run middleware + route + observers
  4. Send HTTP response; await next keep-alive request
     under idle_timeout_ms (unless closing)
      |
      |  on follow-up request headers:
      |  detach next http.Exchange -> return_pipe
      v
  Parent Listener
  5. Receive returned exchange -> re-classify and dispatch
```

Each handoff moves the underlying live socket cleanly between libuv loops
through `ExchangeEnvelope`, carrying the `peer_address` captured before
detachment so handlers and `on_complete` observers see the client address
even on worker threads. When a pool worker or persistent session worker
finishes a keep-alive exchange, the adopted connection stays on the worker
under `idle_timeout_ms` until the next request's headers arrive. Rather than
running that follow-up in place, the worker detaches the new
`http.Exchange` and pushes it onto `return_pipe` so the parent can classify
and dispatch it fresh. Ephemeral session workers and retiring sessions
instead announce `Connection: close` and never hold the connection open for
a follow-up.

Transporting raw socket handles across threads introduces a subtle resource
safety hazard: a detached `http.Exchange` is a manual-handoff native
capability with exactly one owner. If sending or receiving that payload
suspended inside a cancellable channel wait, cancelling the Task mid-wait
could abandon the payload in flight and leak an OS file descriptor.

`ExchangePipe` prevents that leak by decoupling readiness signaling from
payload ownership. A single-consumer pipe moves detached envelopes only
through synchronous, non-yielding `try_send` and `try_receive` transitions.
Ownership transfers atomically—either the sender retains the envelope and
closes it on failure, or the receiver adopts it immediately—so Task
cancellation never strands an unadopted socket.

## Per-State Locals and the Closure-Transfer Model

Traditional multi-process servers rely on Unix `prefork` to share
initialized memory via copy-on-write, while thread-pool frameworks often
rely on dynamic service registries to inject per-thread dependencies. Both
approaches carry hidden friction: forked file descriptors and TLS contexts
break across processes, and untyped service locators defeat static checks.

In `titan-mk`, every OS worker loads the same compiled Titan modules into
its own Lua state, so an ordinary module-level `local` variable acts as
statically typed thread-local storage. Opening a database handle or
preparing a cache inside `on_start(wctx)` and pairing it with
`wctx:defer_cleanup(fn)` keeps lifecycle management local to the worker
that owns the native resource, with zero runtime registry lookups.

Shipping route handlers, overlapping middleware, `Config.error_handler`,
and `on_start` to workers builds on Titan's cross-state closure transfer:

- **Snapshot isolation:** When `mk` freezes registration and prepares each
  worker's bootstrap, Titan snapshots every captured upvalue before any
  custom transfer hook runs. Mutable upvalues become fresh independent
  cells in each destination state rather than shared references.
- **Safe cross-thread values:** Primitives, strings, nested closures,
  protobuf-eligible public records and unions, packet-scoped
  reference-counted channel endpoints (`thread.Sender<|T|>` and
  `thread.Receiver<|T|>`), records with custom transfer hooks (such as
  `mk.TransferableHandler`), and raw C pointers cross cleanly. Channel
  endpoints clone their underlying reference count safely; manual-handoff
  resources detach into single-owner byte payloads.
- **Rejected mutable graphs:** Direct Arrays, Maps, Interfaces, cyclic
  references, `owned` C storage, `local` nominal types, and hookless
  records with `local` fields (such as `mk.App` and `http.Server`) are
  rejected at transfer time. Rejecting them prevents silent aliasing bugs
  where a developer expects a captured Map or `App` handle to synchronize
  across OS threads.

Parent-only hooks—`SessionOptions.session_id`, `SessionOptions.on_exit`,
and `App:hooks()`—never serialize across states, so they remain free to
close over parent-owned Maps, metrics registries, or the `App` itself.

## Why Shutdown Follows Seven Ordered Stages

Shutting down a multi-threaded HTTP server cleanly requires tearing down
producers before consumers so no thread posts to a dead channel or orphans
an open socket. `titan-mk` executes shutdown in a fixed seven-stage
sequence, running once and preserving the first error for
`on_post_shutdown`:

1. **Mark closing and close the listener:** New requests that slipped in
   before listener close receive `503` (`"shutting_down"`) with
   `Connection: close` so clients stop reusing sockets immediately.
2. **Run `on_pre_shutdown` hooks:** Application code gets a chance to flip
   readiness state or flush external coordinators while workers and loggers
   are still alive; one failing hook does not prevent later hooks from
   running.
3. **Drain parent handlers:** Idle keep-alive connections cancel
   immediately, while in-flight parent handlers receive up to
   `shutdown_timeout_ms` to complete before forced abort and join.
4. **Stop workers and join monitors:** Worker pipes close and live worker
   threads cancel directly without an extra worker drain grace period,
   aborting active worker transports so stuck worker loops cannot stall
   process exit. Joining worker monitors ensures every worker's
   `defer_cleanup` and every session's `on_exit` finish before teardown
   advances, then the retire listener closes and joins.
5. **Stop `return_pipe`:** Any remaining queued exchanges and adopted
   connections are discarded now that no worker can send another return
   envelope.
6. **Drain and close the worker log forwarder:** Only after every worker
   has exited does `mk` close the cross-thread log channel and join the
   forwarder Task, ensuring late `defer_cleanup` logs reach `Config.logger`.
   `mk` deliberately never closes `Config.logger` itself so
   `on_post_shutdown` hooks and outer application teardown can still write
   final diagnostics.
7. **Run `on_post_shutdown(first_failure?)`:** Final observers inspect any
   teardown error once all network and worker activity has ceased.

Separating non-blocking `App:initiate_shutdown()` from awaiting
`App:shutdown()` eliminates self-deadlock. A handler running inside step 3
or a lifecycle hook running inside steps 2, 4, or 7 cannot block waiting
for its own stage to finish; `initiate_shutdown()` schedules the shutdown
Task and returns immediately, while callers outside handlers and hooks use
`shutdown()` to wait for full completion.

For configuration steps and closure checklists, see
[How to Run Handlers on OS Worker Pools and Session Workers](../how-to/worker-threads-and-sessions.md).
For exact supervision signatures, see the
[`mk` Module Reference](../reference/mk.md#workers-and-supervision).
