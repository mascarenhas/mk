# titan-mk

`titan-mk` is a GoFiber-inspired HTTP/1.1 micro-framework written in **Titan 0.6.0**. It combines pure `titan.peg` routing with guaranteed $O((M + L) \cdot A)$ worst-case matching, a typed `Context` and JSON body binder, structured JSON-line logging, ten focused middleware modules, and a shared-nothing OS worker thread model built on `titan.thread`, `titan.transfer`, `titan.async`, and `titan.http.Exchange`.

## Features

- **Compiled PEG routing (`mk.router`):** Deterministic routes compile to single-pass `titan.peg` matchers; routes with optional parameters, in-segment delimiters, or multiple wildcards use a linear-per-op bottom-up evaluator. Supports route groups, `RouteChain`, named URL building, automatic `HEAD` fallback, and first-occurrence `405 Allow` headers.
- **Typed `Context` and JSON binding:** Immutable `RequestMeta`, buffered and streaming responses, WebSocket upgrades, `on_before_commit` / `on_complete` observers, `HttpError` exception flow, and JSON-only `ctx:bind()` with exact `415`/`413`/`400`/`422` classification.
- **Worker threads (`WorkerMode`):** Dispatch routes directly on the `parent` event loop, across a round-robin `pool` of OS worker threads, or onto on-demand per-`session` workers (persistent or `ephemeral`) with immediate `ctx:retire_worker()`.
- **Non-suspending JSON logging (`mk.log`):** Bounded single-writer JSON-line logger with drop accounting and cross-thread forwarding.
- **Built-in middleware (`mk.middleware.*`):** `env`, `healthcheck`, `helmet`, `keyauth`, `logger`, `recover`, `requestid`, `responsetime`, `static`, and `timeout`.
- **Single-provider LuaRocks bundle:** All 13 public logical modules compile into one `mk.so` + `mk.a` provider pair (`mk.dll` on Windows).

## Quickstart

```titan
local mk = import "mk"
local log = import "mk.log"
local recover = import "mk.middleware.recover"
local requestid = import "mk.middleware.requestid"
local logger_mw = import "mk.middleware.logger"

local function hello(ctx: mk.Context)
  local name = ctx:param("name", "world")
  local payload: {string: string} = {
    ["hello"] = name,
    ["request_id"] = ctx:request_id(),
  }
  ctx:json(payload)
end

function main(_args: {string}): integer
  local app_logger = log.Logger("info")
  defer app_logger:close()

  local app = mk.App(mk.Config {
    app_name = "demo",
    logger = app_logger,
    error_handler = mk.json_error_handler,
  })

  app:use(requestid.new(), recover.new(), logger_mw.new())
  app:get("/hello/:name?", hello):name("hello")

  app:listen("127.0.0.1:8080")
  return 0
end
```

## Installation

`titan-mk` requires Lua **5.5** and Titan **0.6** (`lua ~> 5.5`, `titan ~> 0.6`).

### Install via LuaRocks

From a checkout of this repository, build and install the `mk` provider into your active LuaRocks / Titan tree:

```sh
luarocks make titan-mk-0.1.0-1.rockspec
```

The rockspec compiles all 13 `mk*` logical modules into `build/mk.so` and `build/mk.a` (`build\mk.dll` on Windows), stages them under `$(PREFIX)/dist/modules/`, and runs `titan-install --path "$(PREFIX)"` from its `post_install` hook so other Titan projects can `import "mk"` without extra `--tree` flags or `TITAN_PATH_0_6` overrides.

To remove the installed package and its staged provider files:

```sh
titan-uninstall titan-mk
```

### Building and testing from a checkout

The repository `Makefile` delegates incremental compilation and native tests to `titanc`:

```sh
make build                      # build build/mk.so and build/mk.a
make test                       # build and run tests/ via build/mk-tests
make test TEST_ARGS='--filter router'
make clean
```

### Linking consumer applications (dynamic vs. `--static`)

- **Dynamic build (default):** Compile against the installed provider with no extra link flags:

  ```sh
  titanc -o build app.main
  ```

- **Static build (`--static` on Linux and macOS):** Because `mk` imports `titan.http` and `titan.websocket` (which depend on `titan.ssl`), linking a standalone static executable against a **system-OpenSSL** Titan SDK requires passing OpenSSL's linker flags at final link:

  ```sh
  TITAN_EXTRA_CPPFLAGS="$(pkg-config --cflags openssl)" \
  TITAN_EXTRA_LDFLAGS="$(pkg-config --libs openssl)" \
    titanc --static -o build app.main
  ```

  A **bundled-OpenSSL** Titan SDK archives OpenSSL into `titan.a` automatically and needs no extra OpenSSL flags.

## Worker Thread Modes

Routes and groups choose their execution model via `mk.WorkerMode`:

| Mode | Behavior |
| --- | --- |
| `mk.WorkerMode.parent()` | Runs directly on the parent HTTP server's event loop (default). |
| `mk.WorkerMode.pool(options?)` | Dispatches exchanges round-robin across `size` pre-spawned OS worker threads (default `1`, queue capacity `128`). An unexpected pool worker exit fails the `App`. |
| `mk.WorkerMode.session(options)` | Extracts a session ID from `RequestMeta` and routes exchanges to an on-demand per-session OS worker (persistent or `ephemeral = true`). Failures stay isolated to that session. |

See [Workers and Sessions](docs/workers-and-sessions.md) for cross-state closure transfer rules, `on_start` initialization, and shutdown semantics.

## Built-in Middleware

| Module | Purpose |
| --- | --- |
| `mk.middleware.env` | Serves selected environment variables as JSON on `GET`/`HEAD`. |
| `mk.middleware.healthcheck` | Liveness (`/livez`), readiness (`/readyz`), and startup (`/startupz`) probe endpoints. |
| `mk.middleware.helmet` | Security response headers (XSS, nosniff, framing, HSTS, CSP, cross-origin policies). |
| `mk.middleware.keyauth` | Token extraction (`Bearer`, headers, query, cookie, chained, custom) and constant-time validation. |
| `mk.middleware.logger` | Structured JSON request logging on admission or completion (`on_complete`). |
| `mk.middleware.recover` | Catches unexpected non-`HttpError` exceptions without swallowing `async.CancellationReason`. |
| `mk.middleware.requestid` | Validates or CSPRNG-generates a per-request ID header (`X-Request-ID`). |
| `mk.middleware.responsetime` | Records response latency via `on_before_commit` (`X-Response-Time`). |
| `mk.middleware.static` | Confined static file and directory serving with conditional requests and single-range support. |
| `mk.middleware.timeout` | Cooperative handler deadlines via `ctx:run_with_timeout(...)`. |

## Documentation

Start with the [Documentation Index](docs/index.md) for detailed guides on routing, context and JSON binding, worker threads and sessions, and middleware and logging.

## License

MIT — see [LICENSE](LICENSE).
