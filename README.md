# titan-mk 0.1

`titan-mk` is a HTTP/1.1 web framework written in [**Titan**](https://titan-lang.dev). It combines pure `titan.peg` routing, a typed `Context` and JSON body binder, structured JSON-line logging, extensibility through request middleware, with ten included middleware modules, and a shared-nothing OS worker thread model built on `titan.thread`, `titan.transfer`, `titan.async`, and `titan.http.Exchange`.

Why is it called `mk`? The name is a homage to [one of my old Kepler Project libraries](https://github.com/keplerproject/mk). It is not trying to break new ground, the ergonomics and concepts are similar to [Fiber](https://gofiber.io/), which in turn took ideas from Express, but the ideas go back to older web frameworks. The Parsing-Expression-Grammar-based route parser (which also uses PEGs to parse the routing DSL) is a refinement of what I had already used in [Orbit's router](https://github.com/keplerproject/orbit/blob/master/src/orbit/routes.lua) and improved in [Kepler's MK](https://github.com/keplerproject/mk/blob/master/src/mk/routes.lua).

## Features

- **Compiled PEG routing (`mk.router`):** Deterministic routes compile to single-pass `titan.peg` matchers; routes with optional parameters, in-segment delimiters, or multiple wildcards use a linear-per-op bottom-up evaluator. Supports route groups, `RouteChain`, named URL building, automatic `HEAD` fallback, and first-occurrence `405 Allow` headers.
- **Typed `Context` and JSON binding:** Immutable `RequestMeta`, buffered and streaming responses, WebSocket upgrades, `on_before_commit` / `on_complete` observers, `HttpError` exception flow, and JSON-only `ctx:bind()` with exact `415`/`413`/`400`/`422` classification.
- **Worker threads (`WorkerMode`):** Dispatch routes directly on the `parent` event loop, across a round-robin `pool` of OS worker threads, or onto on-demand per-`session` workers (persistent or `ephemeral`) with immediate `ctx:retire_worker()`.
- **Non-suspending JSON logging (`mk.log`):** Bounded single-writer JSON-line logger with drop accounting and cross-thread forwarding.
- **Built-in middleware (`mk.middleware.*`):** `env`, `healthcheck`, `helmet`, `keyauth`, `logger`, `recover`, `requestid`, `responsetime`, `static`, and `timeout`.
- **Single-provider LuaRocks bundle:** All 13 public logical modules compile into one `mk.so` + `mk.a` provider pair (`mk.dll` on Windows), with `doc/` and `skills/` installed alongside the rock via `copy_directories = { "doc", "skills" }`. Applications in Linux and MacOS can statically link the framework and Titan stdlib into their executable.

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

`titan-mk` requires Lua **5.5** and Titan **0.6**.

### Install via LuaRocks

```sh
luarocks install titan-mk
```

The source rock compiles all 13 `mk` modules into `mk.so` and `mk.a` (`mk.dll` on Windows) then installs them under the Titan 0.6 modules folder of your LuaRocks deployment tree, so the modules are discoverable by the Titan compiler. Documentation and a skill for coding agents are installed to the `titan-mk` folder in the LuaRocks package tree.

To remove the installed package and all its files:

```sh
titan-uninstall titan-mk
```

### Building and testing from a checkout

The repository `Makefile` delegates incremental compilation, native tests, and native line coverage to `titanc`:

```sh
make build                              # build build/mk.so and build/mk.a
make test                               # build and run tests/ via build/mk-tests
make test TEST_ARGS='--filter=router'   # or TEST_ARGS='-f router'
make coverage                           # instrumented build + run under build/coverage
make coverage COVERAGE_FORMAT=lcov      # also write build/coverage/.coverage/report/coverage.info
make clean
```

`coverage-build` and `coverage-run` keep instrumented artifacts separate under `build/coverage` (unsetting `GCOV_PREFIX`, `GCOV_PREFIX_STRIP`, and `TITAN_FILTER`), accept `COVERAGE_FORMAT` (`html`, `lcov`, `cobertura`), `COVERAGE_GCOV`, `COVERAGE_GCOVR`, and `COVERAGE_FLAGS` (or `CC`/`GCOV`/`GCOVR` from the environment), and write reports to `build/coverage/.coverage/report/`.

GitHub Actions CI (`.github/workflows/ci.yml`) builds and tests `titan-mk` across **Linux x64** (`ubuntu-24.04`, including `make coverage COVERAGE_FORMAT=lcov` with GCC 14 + `gcovr` and Codecov upload), **macOS arm64** (`macos-15`), and **Windows x64 CLANG64** (`windows-2025-vs2026`), running the full suite and a LuaRocks install/consume/uninstall smoke test (`.github/scripts/package-smoke.sh`) on each platform.

### Linking consumer applications (dynamic vs. `--static`)

- **Dynamic build (default):** Compile against the installed provider with no extra link flags:

  ```sh
  titanc -o build app.main
  ```

- **Static build (`--static` on Linux and macOS):** Because `mk` imports `titan.http` and `titan.websocket` (which depend on `titan.ssl`), linking a standalone static executable against a **system-OpenSSL** Titan SDK requires passing OpenSSL's linker flags at final link (or having them exported by your `.bashrc` or equivalent):

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

## Built-in Middleware

| Module | Purpose |
| --- | --- |
| `mk.middleware.env` | Serves selected environment variables as JSON on `GET`/`HEAD`. |
| `mk.middleware.healthcheck` | Liveness (`/livez`), readiness (`/readyz`), and startup (`/startupz`) probe endpoints. |
| `mk.middleware.helmet` | Security response headers (XSS, nosniff, framing, HSTS, CSP, cross-origin policies). |
| `mk.middleware.keyauth` | Token extraction (`Bearer`, headers, query, cookie, chained, custom), custom validation, and `constant_time_equal` helper. |
| `mk.middleware.logger` | Structured JSON request logging on admission or completion (`on_complete`). |
| `mk.middleware.recover` | Catches unexpected non-`HttpError` exceptions without swallowing `async.CancellationReason`. |
| `mk.middleware.requestid` | Validates or CSPRNG-generates a per-request ID header (`X-Request-ID`). |
| `mk.middleware.responsetime` | Records response latency via `on_before_commit` (`X-Response-Time`). |
| `mk.middleware.static` | Confined static file and directory serving with conditional requests and single-range support. |
| `mk.middleware.timeout` | Cooperative handler deadlines via `ctx:run_with_timeout(...)`. |

## Documentation and Agent Skill

- **Manual (Guide + Module Reference):** [doc/index.md](doc/index.md)
- **Coding-agent skill for using `titan-mk`:** [skills/titan-mk/SKILL.md](skills/titan-mk/SKILL.md)

## License

MIT — see [LICENSE](LICENSE).
