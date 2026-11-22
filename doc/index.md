# `titan-mk` Manual

`titan-mk` is a GoFiber-inspired HTTP/1.1 micro-framework written in **Titan 0.6.0**. All 13 public logical modules compile into a single `mk` provider (`mk.so` + `mk.a` on POSIX; `mk.dll` on Windows).

- **New to `titan-mk`?** Read **Part I: Guide** sequentially for concepts, idioms, and runnable patterns.
- **Looking up an exact signature, field, default, or error code?** Jump to **Part II: Module Reference**.
- **Using a coding agent with `titan-mk`?** Load the bundled operational skill at [skills/titan-mk/SKILL.md](../skills/titan-mk/SKILL.md) (copied alongside `doc/` into the installed LuaRocks rock directory).

---

## Part I — Guide

| Ch. | Guide | Summary |
| ---: | --- | --- |
| 1 | [Getting Started](guide/getting-started.md) | LuaRocks installation (`luarocks make`, `titan-install`, `titan-uninstall`), consumer project layout, first application, dynamic vs. `--static` (`-lssl -lcrypto`) linking, and testing with `App:test` vs. `App:listen_test`. |
| 2 | [Routing and Handlers](guide/routing-and-handlers.md) | PEG route grammar and why inline constraints are rejected, groups, `RouteChain`, `App:mount`, `auto_head` and first-occurrence `405 Allow`, `Context` and `RequestMeta`, JSON-only `Bind`, `HttpError` flow, buffered vs. streaming output, and WebSocket upgrades. |
| 3 | [Middleware and Logging](guide/middleware-and-logging.md) | Middleware chain execution, `on_before_commit` and `on_complete` observers, `mk.log` bounded JSON-line logging, composing the 10 built-in middlewares, and admission vs. completion request logging. |
| 4 | [Workers and Sessions](guide/workers-and-sessions.md) | Shared-nothing Titan OS worker threads, `parent`/`pool`/`session` and `ephemeral` dispatch, `Context:retire_worker()`, per-state module locals in `on_start`, Titan cross-state closure transfer rules and `Transferable*`, pool failure vs. session isolation, and ordered shutdown. |

---

## Part II — Module Reference

| Reference | Logical Modules | Summary |
| --- | --- | --- |
| [`mk`](reference/mk.md) | `mk` | `App`, `Config`, `ListenConfig`, `Group`, `GroupOptions`, `RouteChain`, `RouteHandle`, `Hooks`, `ListenData`, `RouteInfo`, `GroupInfo`, `WorkerInfo`, `Context` (including `classified_route`), `RequestMeta`, `Cookie`, `Bind`, `HttpError`, `ErrorHandler`, status catalog, MIME defaults, `WorkerMode`, `PoolOptions`, `SessionOptions`, `WorkerContext`, `Transferable*`, and test types. |
| [`mk.router`](reference/mk-router.md) | `mk.router` | Constants, PEG route grammar, `RouteError` codes, `SegmentToken`, `RouteSegment`, `PatternOptions`, `CompiledPattern`, `MatchResult`, `Target`, `parse_target`, `percent_decode`, `percent_encode_segment`, `join_paths`, and `allow_header`. |
| [`mk.log`](reference/mk-log.md) | `mk.log` | `MAX_LINE_BYTES`, `Logger`, level vocabulary and `resolve_level`, `format_line`, `emit`, `forward`, and `fatal`. |
| [`mk.middleware.*`](reference/mk-middleware.md) | `mk.middleware.{env, healthcheck, helmet, keyauth, logger, recover, requestid, responsetime, static, timeout}` | Complete API, defaults, validation rules, and behavior for all 10 built-in middleware modules. |

---

## Explicit Scope Boundaries

`titan-mk` keeps its surface focused on Titan's standard library:

- **No template views** (no `Context:render`).
- **JSON-only body binding** (use `Context` accessors for path params, query strings, headers, and cookies).
- **JSON-only structured logging** (`mk.log` and `mk.middleware.logger`).
- **No routing constraints** (`:id<int>` is rejected at pattern compile time with `RouteError` code `"routing_constraints_unsupported"`).
- **No HTTP client wrapper** (import Titan's `http` standard library directly).
- **No custom struct validator, service registry, or OS `prefork` mode** (workers use per-state module `local` variables initialized in `on_start`).

See the [README](../README.md) for repository build commands and license details.
