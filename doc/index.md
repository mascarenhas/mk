# `titan-mk` Manual

`titan-mk 0.1.1` is an HTTP/1.1 web framework written in Titan (targeting Lua 5.5 and Titan 0.6, tested on Titan 0.6.1). All 13 public logical modules compile into one `mk` provider (`mk.so` and `mk.a` on Linux and macOS; `mk.dll` on Windows).

Start with **Part I** to build a working service step by step, use **Part II** when solving a specific operational task, consult **Part III** for exact module signatures and error codes, and read **Part IV** for architectural rationale. If you use a coding agent with `titan-mk`, load the operational skill bundled alongside this manual at [skills/titan-mk/SKILL.md](../skills/titan-mk/SKILL.md).

## Part I — Tutorials

| Tutorial | Summary |
| --- | --- |
| [Build Your First HTTP Service](tutorials/first-service.md) | Create a typed bookmark service with JSON validation, structured logging, and an in-memory test. |

## Part II — How-to Guides

| Guide | Summary |
| --- | --- |
| [How to Install, Build, and Link `titan-mk`](how-to/install-and-build.md) | Install via LuaRocks, structure a consumer project, and link dynamically or statically. |
| [How to Define Routes, Bind JSON, and Return Errors](how-to/routes-and-json-apis.md) | Register groups, chains, and mounted sub-apps, decode JSON bodies, and return `HttpError` responses. |
| [How to Compose Middleware and Structured Logging](how-to/middleware-and-logging.md) | Order middleware, configure `mk.log`, authenticate requests, set timeouts, and serve static files. |
| [How to Stream Responses and Upgrade WebSockets](how-to/streaming-and-websockets.md) | Flush chunks, stream `io.Reader` payloads, read raw request bodies, and manage WebSocket upgrades. |
| [How to Run Handlers on OS Worker Pools and Session Workers](how-to/worker-threads-and-sessions.md) | Configure `pool` and `session` dispatch, initialize per-worker state, and shut down cleanly. |
| [How to Test Services and Measure Line Coverage](how-to/testing-and-coverage.md) | Combine fast `App:test` checks with `App:listen_test` integration tests and `titanc --coverage`. |

## Part III — Reference

| Module | Logical Modules | Summary |
| --- | --- | --- |
| [`mk`](reference/mk.md) | `mk` | `App`, `Config`, `Group`, `RouteChain`, `Hooks`, `Context`, `RequestMeta`, `Bind`, `HttpError`, `WorkerMode`, and test helpers. |
| [`mk.router`](reference/mk-router.md) | `mk.router` | Constants, PEG route grammar, `RouteError` codes, `CompiledPattern`, `Target`, and URI helpers. |
| [`mk.log`](reference/mk-log.md) | `mk.log` | `MAX_LINE_BYTES`, `Logger`, level vocabulary, JSON-line formatting, drop accounting, and forwarding. |
| [`mk.middleware.*`](reference/mk-middleware.md) | All 10 `mk.middleware.*` modules | Complete APIs, defaults, validation rules, and behavior for every built-in middleware module. |

## Part IV — Explanation

| Topic | Summary |
| --- | --- |
| [About PEG Routing and Route Constraints](explanation/peg-routing.md) | Two-tier PEG matching, linear worst-case bounds, atomic percent escapes, and why inline constraints are rejected. |
| [About the Request, Middleware, and Error Lifecycle](explanation/request-lifecycle.md) | Execution order, non-intercepting response observers, JSON-only `Bind` classification, and non-suspending logging. |
| [About Shared-Nothing Workers and Closure Transfer](explanation/worker-architecture.md) | Isolation trade-offs across `parent`, `pool`, and `session` modes, keep-alive handoff, transfer rules, and shutdown order. |

## Scope Boundaries

`titan-mk` stays close to Titan's standard library and omits six categories of framework machinery by design:

- **No HTML template views:** There is no `Context:render` engine.
- **JSON-only body binding:** Use `Context` accessors for path parameters, query strings, headers, and cookies.
- **JSON-only structured logging:** `mk.log` and `mk.middleware.logger` emit UTF-8 JSON lines exclusively.
- **No inline routing constraints:** Patterns like `:id<int>` fail at route registration with `RouteError.code == "routing_constraints_unsupported"`.
- **No HTTP client wrapper:** Import Titan's `http` standard library directly.
- **No struct validator, service registry, or OS `prefork`:** Workers hold per-state resources in module-level `local` variables initialized in `on_start`.
