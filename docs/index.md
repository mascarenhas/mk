# `titan-mk` Documentation

`titan-mk` is a statically typed HTTP/1.1 micro-framework for **Titan 0.6.0**. All 13 public modules are compiled and distributed together as a single `mk` provider (`mk.so` + `mk.a` on POSIX; `mk.dll` on Windows).

## Guides

| Guide | Covers |
| --- | --- |
| [Routing](routing.md) | `mk.router` PEG route grammar, parameter/optional/wildcard matching, why routing constraints are rejected, groups, `RouteChain`, `App:mount`, `auto_head`, first-occurrence `405 Allow`, and `build()` / `App:route_url()`. |
| [Context and JSON Binding](context-and-binding.md) | `RequestMeta`, `Context`, `Cookie`, `trust_forwarded_headers`, JSON-only `Bind` and exact `415`/`413`/`400`/`422` errors, buffered vs. streaming responses, `commit()`, `on_before_commit` / `on_complete`, `HttpError` & `ErrorHandler`, and `App:test` vs. `App:listen_test`. |
| [Workers and Sessions](workers-and-sessions.md) | `WorkerMode.{parent, pool, session}`, `SessionOptions.ephemeral`, `Context:retire_worker()`, Titan cross-state transfer constraints & `Transferable*` wrappers, per-state module locals in `on_start`, pool failure vs. session isolation, and `initiate_shutdown()` vs. `shutdown()`. |
| [Middleware and Logging](middleware-and-logging.md) | `mk.log` bounded non-suspending JSON-line logger and all 10 `mk.middleware.*` modules (`env`, `healthcheck`, `helmet`, `keyauth`, `logger`, `recover`, `requestid`, `responsetime`, `static`, `timeout`). |

## Public Module Map

| Logical module | Role |
| --- | --- |
| `mk` | `App`, `Config`, `ListenConfig`, `Group`, `GroupOptions`, `RouteHandle`, `RouteChain`, `Hooks`, `Context`, `RequestMeta`, `Cookie`, `Bind`, `HttpError`, `WorkerMode`, `PoolOptions`, `SessionOptions`, `WorkerContext`, `Transferable*`, and testing helpers (`TestRequest`, `TestConfig`, `TestResponse`, `TestServer`). |
| `mk.log` | Bounded, non-suspending JSON-line `Logger`, cross-thread `forward`, and `fatal` startup diagnostics. |
| `mk.router` | Network-free PEG route parser/compiler (`parse_pattern`, `compile_pattern`, `CompiledPattern`), request target parser (`parse_target`), percent coding, `join_paths`, and `allow_header`. |
| `mk.middleware.env` | JSON environment variable inspection handler (`GET`/`HEAD`). |
| `mk.middleware.healthcheck` | Liveness, readiness, and startup probe handlers (`text()` or `json()`). |
| `mk.middleware.helmet` | Security response headers middleware. |
| `mk.middleware.keyauth` | Key/token authentication middleware, `Extractor` union, `CustomExtractor`, and `constant_time_equal`. |
| `mk.middleware.logger` | Structured JSON request logging middleware (`Phase.completion()` or `Phase.admission()`). |
| `mk.middleware.recover` | Panic/exception recovery middleware for non-`HttpError` failures. |
| `mk.middleware.requestid` | Request ID extraction, validation, and CSPRNG generation middleware. |
| `mk.middleware.responsetime` | Pre-commit latency header middleware (`X-Response-Time`). |
| `mk.middleware.static` | Confined static file server middleware with conditional GET and single-range support. |
| `mk.middleware.timeout` | Cooperative handler timeout wrapper and middleware. |

## Application Configuration (`mk.Config`)

All `mk.Config` fields are optional and default as follows in `mk.App(config?)`:

| Field | Type | Default | Notes |
| --- | --- | --- | --- |
| `app_name` | `string?` | `""` | Published in `ListenData.app_name`. |
| `server_header` | `string?` | `nil` | When set, adds a default `Server` response header if absent. |
| `case_sensitive` | `boolean?` | `false` | Route matching case sensitivity. |
| `strict_routing` | `boolean?` | `false` | Distinguish trailing slashes (`/users` vs. `/users/`). |
| `unescape_path` | `boolean?` | `true` | Percent-decode matched path and route parameters. |
| `auto_head` | `boolean?` | `true` | Fall back unmatched `HEAD` requests to matching `GET` routes. |
| `body_limit` | `integer?` | `4194304` (4 MiB) | Maximum request body bytes (`>= 1`). |
| `header_limit` | `integer?` | `65536` (64 KiB) | Maximum raw request header bytes (`>= 1`). |
| `idle_timeout_ms` | `integer?` | `10000` (10 s) | Keep-alive header idle deadline (`>= 0`; `0` disables). |
| `shutdown_timeout_ms` | `integer?` | `10000` (10 s) | Bounded parent-request drain wait during shutdown (`>= 0`). |
| `json_max_depth` | `integer?` | `64` | Maximum JSON nesting depth for `ctx:bind()` (`>= 1`). |
| `trust_forwarded_headers` | `boolean?` | `false` | Trust `X-Forwarded-Proto` and `X-Forwarded-Host` (enable only behind a trusted proxy). |
| `error_handler` | `ErrorHandler?` | `mk.default_error_handler` | Handles uncaught `HttpError` values before commit. |
| `logger` | `log.Logger?` | `nil` | Parent logger (and target of worker-thread log forwarding). |
| `workers` | `WorkerMode?` | `mk.WorkerMode.parent()` | Default execution dispatcher for routes without an override. |

## Explicit Scope Boundaries

`titan-mk` deliberately keeps its surface focused on Titan's standard library:

- **No template views** (no `Context:render`).
- **JSON-only body binding** (use `Context` accessors for path params, query strings, headers, and cookies).
- **JSON-only structured logging** (`mk.log` and `mk.middleware.logger`).
- **No routing constraints** (`:id<int>` is rejected at pattern compile time).
- **No HTTP client wrapper** (import Titan's `http` standard library directly).
- **No custom struct validator, service registry, or OS `prefork` mode** (workers use per-state module locals initialized in `on_start`).

See the [README](../README.md) for installation, `Makefile` targets, and `--static` linking instructions.
