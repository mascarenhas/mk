# titan-mk 0.1.1

`titan-mk` is an HTTP/1.1 web framework written in [**Titan**](https://titan-lang.dev) (targeting Lua 5.5 and Titan 0.6, tested on Titan 0.6.1). It combines compiled `titan.peg` routing, a typed `Context` and JSON body binder, non-suspending JSON-line logging, ten built-in middleware modules, and shared-nothing OS worker threads built on `titan.thread`, `titan.transfer`, `titan.async`, and `titan.http.Exchange`.

The name `mk` pays homage to [Kepler Project's `mk`](https://github.com/keplerproject/mk). Its ergonomics and concepts resemble [Fiber](https://gofiber.io/) and Express, while its PEG-based route parser—which also uses PEGs to parse the routing syntax—refines the router from [Orbit](https://github.com/keplerproject/orbit/blob/master/src/orbit/routes.lua) and [Kepler's `mk`](https://github.com/keplerproject/mk/blob/master/src/mk/routes.lua).

- **Documentation site:** [mk.titan-lang.dev](https://mk.titan-lang.dev)
- **Repository manual:** [doc/index.md](doc/index.md)
- **Coding-agent skill:** [skills/titan-mk/SKILL.md](skills/titan-mk/SKILL.md)

## Quickstart

Save this file as `app.titan`:

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

  app:use(
    requestid.new(),
    recover.new(),
    logger_mw.new()
  )
  app:get("/hello/:name?", hello):name("hello")

  app:listen("127.0.0.1:8080")
  return 0
end
```

Compile and run:

```sh
titanc -o build --exe build/app app
./build/app
```

For a step-by-step walkthrough with typed JSON input and an in-memory native test, see [Build Your First HTTP Service](doc/tutorials/first-service.md).

## Features

- **Compiled PEG routing (`mk.router`):** Deterministic routes compile to single-pass `titan.peg` matchers; routes with optional parameters, in-segment delimiters, or multiple wildcards run a linear-per-operation bottom-up evaluator (`O((M + L) · A)`). Supports route groups, `RouteChain`, named URL building, automatic `HEAD` fallback, and first-occurrence `405 Allow` headers.
- **Typed `Context` and JSON binding:** Immutable `RequestMeta`, buffered and streaming responses, WebSocket upgrades, LIFO `on_before_commit` and `on_complete` observers, `HttpError` exception flow, and JSON-only `ctx:bind()` with exact `415`, `413`, `400`, and `422` errors.
- **Worker threads (`WorkerMode`):** Dispatch routes on the `parent` event loop, across a round-robin `pool` of OS worker threads, or onto on-demand per-`session` workers (persistent or `ephemeral`) with immediate `ctx:retire_worker()`.
- **Non-suspending JSON logging (`mk.log`):** Bounded single-writer JSON-line logger with drop accounting and cross-thread forwarding.
- **Built-in middleware (`mk.middleware.*`):** `env`, `healthcheck`, `helmet`, `keyauth`, `logger`, `recover`, `requestid`, `responsetime`, `static`, and `timeout`.
- **Single-provider LuaRocks bundle:** All 13 public logical modules compile into one `mk.so` and `mk.a` provider pair on Linux and macOS (`mk.dll` on Windows), with `doc/` and `skills/` installed into the rock directory. Applications on Linux and macOS can link `titan-mk` and the Titan standard library statically into standalone executables.

## Installation

`titan-mk` requires Lua **5.5** and Titan **0.6** (tested on Titan **0.6.1**).

### Install via LuaRocks

```sh
luarocks install titan-mk
```

The source rock compiles all 13 `mk` modules into `mk.so` and `mk.a` (`mk.dll` on Windows) and registers them under `<sdk>/lib/titan/0.6` so `titanc` discovers them with no extra `--tree` flags. Documentation and the coding-agent skill land inside the rock directory (`luarocks show --rock-dir titan-mk`).

To install from a local checkout instead:

```sh
luarocks make titan-mk-0.1.1-1.rockspec
```

To remove the package and all published provider files:

```sh
titan-uninstall titan-mk
```

On Windows, run `titan-uninstall.bat titan-mk`.

### Linking consumer applications

- **Dynamic build (default):** Compile against the installed provider with no extra linker flags:

  ```sh
  titanc --incremental --tree src -o build --exe build/my-app app.main
  ```

- **Static build (`--static` on Linux and macOS):** Because `mk` imports `titan.http` and `titan.websocket` (which depend on `titan.ssl`), linking against a **system-OpenSSL** Titan SDK requires OpenSSL's flags at final link:

  ```sh
  TITAN_EXTRA_CPPFLAGS="$(pkg-config --cflags openssl)" \
  TITAN_EXTRA_LDFLAGS="$(pkg-config --libs openssl)" \
    titanc --static --tree src -o build --exe build/my-app app.main
  ```

  A **bundled-OpenSSL** Titan SDK archives OpenSSL into `titan.a` automatically and needs no extra OpenSSL flags. See [How to Install, Build, and Link `titan-mk`](doc/how-to/install-and-build.md) for full details.

### Building and testing from a checkout

The repository `Makefile` delegates incremental compilation, native tests, and native line coverage to `titanc` (override the compiler or parallelism with `TITANC` and `TITAN_JOBS`, default `2`):

```sh
make build                            # build build/mk.so and build/mk.a
make tests                            # build build/mk-tests only
make test                             # build and run tests/
make test TEST_ARGS='--filter=router' # or TEST_ARGS='-f router'
make coverage                         # coverage run in build/coverage
make coverage COVERAGE_FORMAT=lcov    # also emit coverage.info (lcov)
make clean
```

GitHub Actions CI (`.github/workflows/ci.yml`) runs the full test suite and the LuaRocks install, consumer build, and uninstall smoke test (`.github/scripts/package-smoke.sh`) on **Titan 0.6.1** across **Linux x64** (`ubuntu-24.04`), **macOS arm64** (`macos-15`), and **Windows x64 CLANG64** (`windows-2025-vs2026`). The Linux job also runs `make coverage COVERAGE_FORMAT=lcov` with GCC 14 and `gcovr`. See [How to Test Services and Measure Line Coverage](doc/how-to/testing-and-coverage.md).

## Worker Thread Modes

Routes and groups select their execution model through `mk.WorkerMode` (see [`mk` Module Reference](doc/reference/mk.md)):

| Mode | Behavior |
| --- | --- |
| `mk.WorkerMode.parent()` | Runs directly on the parent HTTP server's event loop (default). |
| `mk.WorkerMode.pool(options?)` | Dispatches exchanges round-robin across `size` pre-spawned OS worker threads (default `1`, queue capacity `128`). An unexpected pool worker exit fails the `App`. Reuse one `WorkerMode.pool(...)` value across routes or groups to share a pool. |
| `mk.WorkerMode.session(options)` | Extracts a session ID from `RequestMeta` and routes exchanges to an on-demand per-session OS worker (persistent or `ephemeral = true`). Failures stay isolated to that session. |

## Built-in Middleware

Every built-in middleware ships inside the single `mk` provider (see [`mk.middleware.*` Module Reference](doc/reference/mk-middleware.md)):

| Module | Purpose |
| --- | --- |
| `mk.middleware.env` | Serves an allowlist of environment variables as JSON on `GET` and `HEAD`. |
| `mk.middleware.healthcheck` | Liveness (`/livez`), readiness (`/readyz`), and startup (`/startupz`) probe endpoints. |
| `mk.middleware.helmet` | Security response headers (XSS, nosniff, framing, HSTS, CSP, cross-origin policies). |
| `mk.middleware.keyauth` | Token extraction (`Bearer`, headers, query, cookie, chain, custom), custom validation, and `constant_time_equal`. |
| `mk.middleware.logger` | Structured JSON request logging on admission or completion (`on_complete`). |
| `mk.middleware.recover` | Converts unexpected non-`HttpError` exceptions to `500` without swallowing `async.CancellationReason`. |
| `mk.middleware.requestid` | Validates or CSPRNG-generates a per-request ID header (`X-Request-ID`). |
| `mk.middleware.responsetime` | Records response latency via `on_before_commit` (`X-Response-Time`). |
| `mk.middleware.static` | Confined static file and directory serving with conditional requests and single-range support. |
| `mk.middleware.timeout` | Cooperative handler deadlines via `ctx:run_with_timeout(...)`. |

## License

MIT — see [LICENSE](LICENSE).
