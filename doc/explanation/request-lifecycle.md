# About the Request, Middleware, and Error Lifecycle

An HTTP/1.1 framework has to reconcile three competing pressures on every
request: running cross-cutting hooks around arbitrary routes, enforcing
protocol framing once response headers hit the wire, and reporting failures
without leaking sockets or stalling the event loop. `titan-mk` addresses
these pressures through upfront route classification, non-intercepting
lifecycle observers, a strict one-way commit boundary, and non-suspending
log queues.

## The Request Execution Arc

Every incoming request moves through the same linear pipeline regardless of
whether it runs on the parent state or on an OS worker thread. Before the
first middleware executes, the router classifies the raw request target and
records the matched pattern in `classified_route()`. That upfront pass
ensures logging, authentication, and metrics middleware know which route a
request targeted even when an early rejection prevents the endpoint from
ever running.

```text
  HTTP request
       |
       v
  [1] Classify target -> sets classified_route() & dispatcher
       |
       v
  [2] Middleware & route entries (strict registration order via next())
       |            |
       | (HttpError)| (normal return or commit())
       v            v
  [3] error_handler (if uncommitted; reset_body() keeps headers)
       |
       v
  [4] on_before_commit hooks (LIFO, once) -> wire headers committed
       |
       v
  [5] Body, stream, or WebSocket finish or abort -> drain or close
       |
       v
  [6] on_complete hooks (LIFO, once)
```

Execution order within step 2 is determined solely by registration order.
There is no separate "pre-middleware" or "post-middleware" phase table: an
entry registered earlier wraps every matching entry registered later. When
no endpoint runs before the chain exhausts, the framework distinguishes two
failure states: if at least one route pattern matches the path for another
method, `mk` builds the `Allow` header in first-occurrence order and raises
`405 Method Not Allowed`; otherwise it raises `404` with the decoded path.
Calling `restart_routing()` re-enters step 1 from the beginning, restricted
to the current worker dispatcher so an active socket never hops threads
mid-request.

## Non-Intercepting Observers vs. `try`/`catch` Middleware

Many HTTP frameworks encourage middleware to wrap `next()` in an exception
handler so it can inject headers or log latency on the way back out. That
pattern works poorly when responses can commit early, stream incrementally,
upgrade to WebSockets, or unwind under cooperative cancellation.

A `catch`-around-`next()` middleware faces three structural hazards. First,
if a downstream handler raises an `mk.HttpError`, middleware running inside
the chain executes *before* `Config.error_handler` has chosen the final
status code, leaving post-`next()` logging with stale status metadata
unless every middleware duplicates error rendering. Second, if a handler
commits headers early via streaming, `send_file()`, or `upgrade_websocket()`,
any header mutation attempted after `next()` returns fails because the
response headers have already been written to the socket. Third, a naive
`catch` block can accidentally intercept `async.CancellationReason`,
breaking timeouts and graceful shutdown.

`titan-mk` avoids all three hazards by splitting observation into two
explicit hook lists on `Context`, both executing in last-in, first-out
(LIFO) order so outer middleware sees the results of inner middleware:

- **`on_before_commit`** runs once immediately before headers leave for
  the transport—whether triggered by a buffered return, `commit()`,
  `flush_headers()`, `send_file()`, a WebSocket `101` upgrade, a WebSocket
  handshake rejection, or `reject_upgrade()`. Middleware such as
  `responsetime` attaches its header here without catching exceptions and
  without losing coverage on error or upgrade paths.
- **`on_complete`** runs once at the end of the request, after
  `Config.error_handler`, stream completion, abort, unhandled failure, or
  cancellation. Middleware such as `logger` reads the final status, abort
  flag, and `last_error()` cleanly without participating in exception
  handling at all.

Because neither observer intercepts control flow, the middleware stack stays
composable even when handlers stream indefinitely or abort mid-response.

## Exception Boundaries and Cancellation Discipline

`titan-mk` partitions failures into three categories with distinct
semantics, because HTTP errors, cooperative cancellation, and programmer
bugs require incompatible responses.

**Expected HTTP failures (`mk.HttpError`).** Raising `mk.HttpError` is the
standard mechanism for client errors, authentication rejections, timeouts,
and explicit `404` and `405` responses. At the top-level dispatch boundary,
`mk` records the error in `last_error()`. If response headers have not been
committed yet, `mk` calls `reset_body()`—clearing staged body bytes while
preserving response headers such as `X-Request-ID`, `WWW-Authenticate`,
`Allow`, and `helmet` security headers—and invokes `Config.error_handler`.
If a custom `error_handler` itself raises an `mk.HttpError`, the built-in
`default_error_handler` takes over so the request still terminates cleanly.

**Cooperative cancellation (`async.CancellationReason`).** Titan uses
`async.CancellationReason` to unwind timed-out handler Tasks and shutting
down workers. Swallowing cancellation leaves Tasks dangling and defeats
timeout cleanup. For that reason, `mk.middleware.recover`, `on_complete`
dispatch, and internal transport boundaries always re-raise
`async.CancellationReason` untouched with its original traceback.

**Unexpected exceptions.** Any other raised value represents an unhandled
fault in application code. Without `mk.middleware.recover`, a live server
refuses to fabricate a misleading HTTP response: it aborts the socket, logs
`"http_request_failed"` with `reason = "unhandled_exception"`, and keeps
serving other connections. Placing `recover` in the chain converts those
faults into a structured `500` `"internal_error"` while still letting
`mk.HttpError` and `async.CancellationReason` pass through unaltered.

## The Commit Boundary and `413` Close Semantics

HTTP/1.1 transmits a status line and headers before the message body. Once
those bytes reach the wire, no protocol mechanism can retract them and
substitute an error page. `Context` models this constraint as a one-way
state transition.

Buffered builders (`send()`, `send_string()`, `html()`, `json()`) keep the
response uncommitted in memory until the handler returns or calls
`commit()`. While uncommitted, middleware and `Config.error_handler` can
replace the status code, add headers, or reset the body freely. Calling
`flush_headers()`, `write_chunk()`, `send_stream()`, `send_file()`, or
`upgrade_websocket()` crosses the commit boundary immediately. Once a
response is committed, mutating status or headers raises an error, and any
`mk.HttpError` escaping an unfinished stream aborts the connection rather
than invoking `Config.error_handler`, ensuring the client observes a
truncated stream rather than a falsely complete body.

Request-body overflow interacts directly with keep-alive framing. Normally,
after a handler finishes without reading the entire request body, a live
HTTP/1.1 server must drain the remaining bytes (up to `body_limit`) before
reusing the TCP connection for the next request. If a client sends a body
larger than `body_limit` and triggers `413 Content Too Large`, draining an
unbounded remainder would let a single oversized upload tie up server
bandwidth indefinitely. When `413` fires before commit, `mk` marks
`Connection: close` on the response so the server can deliver the complete
`413` response cleanly and close the socket without draining the unread
payload or marking the response aborted. If `413` triggers after headers
were already committed on a persistent connection, `mk` releases the
transport directly because the framing can no longer announce
`Connection: close`.

## Why `Bind` Is JSON-Only

`Context:bind()` decodes only JSON payloads (`application/json` or
`*/*+json`) into Titan values via `titan.json` and `titan.reflect`. The
framework deliberately omits multipart parsers, form-to-record coercers,
and reflection-based field-validation DSLs.

Restricting `Bind` to JSON keeps decoding behavior predictable and maps
directly onto Titan's static type system. Client-side problems follow a
fixed classification cascade before a handler runs its business logic: an
unsupported media type yields `415`, an oversized payload yields `413`, an
empty body yields `400`, syntax or depth violations yield `400`, and schema
mismatches against a typed record or union (missing fields, unknown fields,
wrong types, non-integral integers, or out-of-range numbers on a typed
schema) yield `422`.

Configuration mistakes inside the application—such as passing an unknown
`reflect.NamedType` string, targeting a record whose constructor is not
public, or passing an invalid decode option—are *not* converted to `400` or
`422`. `Bind` re-raises those `json.Error` values unchanged so programmer
errors surface immediately during testing or trigger `500` recovery rather
than blaming the HTTP client.

## Why `mk.log` Uses Non-Suspending Bounded Queues

Logging sits on the critical path of every request, error boundary, and
worker lifecycle event. If `ctx:log()` or `Logger:emit()` wrote directly to
`stderr` or waited on a full channel, a stalled log collector or slow disk
could block every concurrent request Task on the same event loop and hold
worker threads open during shutdown.

`mk.log.Logger` decouples admission from I/O. Calling `emit()` formats the
JSON line synchronously (enforcing the `16 KiB` ceiling) and pushes it into
a fixed-capacity buffer without ever yielding or raising. One dedicated
writer Task drains that buffer in admission order to the configured sink,
while OS worker threads forward lines over a bounded cross-thread channel
using non-blocking `try_send`.

When a burst outpaces the sink, `mk.log` drops excess lines instead of
stalling request handling, and records the loss explicitly inside the log
stream via `"log_dropped"` error records carrying the dropped count. That
trade-off guarantees bounded memory and predictable tail latency on the
request path while keeping log loss observable to operators.

For practical middleware ordering and logger setup, see
[How to Compose Middleware and Structured Logging](../how-to/middleware-and-logging.md).
For how requests cross OS thread boundaries, see
[About Shared-Nothing Workers and Closure Transfer](worker-architecture.md).
