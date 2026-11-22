# Chapter 1: Getting Started

This chapter walks through installing `titan-mk`, structuring a consumer Titan application, compiling and linking dynamically or statically, and testing routes both in memory and over a real loopback server.

## Prerequisites and Installation

`titan-mk` targets **Lua 5.5** and **Titan 0.6** (`lua ~> 5.5`, `titan ~> 0.6`).

Install from a local `titan-mk` checkout using LuaRocks:

```sh
luarocks make titan-mk-0.1.0-1.rockspec
```

`luarocks make` runs `titanc --incremental` over all 13 public `mk*` modules to emit a single `mk` provider (`mk.so` + `mk.a` on Linux/macOS; `mk.dll` on Windows), stages it under `$(PREFIX)/dist/modules/`, invokes `titan-install --path "$(PREFIX)"` to register the provider on Titan's library path, and installs `doc/` and `skills/` into the rock directory.

To uninstall `titan-mk` cleanly later:

```sh
titan-uninstall titan-mk
```

To build, test, and measure line coverage of the framework itself from a checkout:

```sh
make build                              # compile build/mk.so and build/mk.a
make test                               # build and run tests/ via build/mk-tests
make test TEST_ARGS='--filter=router'   # or TEST_ARGS='-f router'
make coverage                           # build + run instrumented suite under build/coverage
make coverage COVERAGE_FORMAT=lcov      # also emit build/coverage/.coverage/report/coverage.info
make clean
```

The coverage targets (`coverage`, `coverage-build`, `coverage-run`) compile into `build/coverage` with `titanc --coverage` (unsetting `GCOV_PREFIX`, `GCOV_PREFIX_STRIP`, and `TITAN_FILTER`), writing `build/coverage/.coverage/report/coverage.gcov` plus any space-separated formats listed in `COVERAGE_FORMAT` (`html`, `lcov`, `cobertura`). Override tools with `COVERAGE_GCOV`, `COVERAGE_GCOVR`, or `COVERAGE_FLAGS` (or environment variables `CC`, `GCOV`, `GCOVR`; Titan's `gcc-gcov` backend requires GCC 14+ with matching `gcov`).

## Consumer Application Layout

Because `titan-install` registers `mk` in the Titan SDK's default search path (`<tree>/lib/titan/0.6`), your application repository does not need to vendor `mk` sources or pass extra `--tree` flags for `mk`:

```text
my-service/
  .gitignore          # /build/, .titan-ls/
  src/
    service/
      main.titan
  tests/
    service_test.titan
```

## Your First Application

Separate app construction (`build_app()`) from `main(...)` so the same `mk.App` can be exercised directly in native tests:

```titan
-- src/service/main.titan
local mk = import "mk"
local log = import "mk.log"
local recover = import "mk.middleware.recover"
local requestid = import "mk.middleware.requestid"
local logger_mw = import "mk.middleware.logger"

record Greeting
  const message: string
  const request_id: string
end

local function greet(ctx: mk.Context)
  local name = ctx:param("name", "world")
  ctx:json(Greeting("hello, " .. name, ctx:request_id()))
end

function build_app(app_logger: log.Logger?): mk.App
  local app = mk.App(mk.Config {
    app_name = "my-service",
    logger = app_logger,
    error_handler = mk.json_error_handler,
  })
  app:use(requestid.new(), recover.new(), logger_mw.new())
  app:get("/greet/:name?", greet):name("greet")
  return app
end

function main(_args: {string}): integer
  local app_logger = log.Logger("info")
  defer app_logger:close()

  local app = build_app(app_logger)
  app:listen("127.0.0.1:8080")
  return 0
end
```

Because `mk` imports Titan's `async` and `http` modules, standalone executables automatically start Titan's async bootstrap around `main`. Never call `async.loop()` inside `main` or inside a handler.

## Building and Linking Consumers

### Dynamic Executable (Default)

Compile and link dynamically against the installed `mk` and `titan` providers:

```sh
titanc --incremental --tree src -o build --exe build/my-service service.main
./build/my-service
```

### Static Executable (`--static` on Linux and macOS)

`mk` imports `titan.http` and `titan.websocket`, which layer on `titan.ssl`. When building a standalone static executable:

- Against a **bundled-OpenSSL** Titan SDK: OpenSSL objects are archived in `titan.a`, so `titanc --static` works with no extra flags.
- Against a **system-OpenSSL** Titan SDK: pass OpenSSL's compiler and linker flags at final link:

```sh
TITAN_EXTRA_CPPFLAGS="$(pkg-config --cflags openssl)" \
TITAN_EXTRA_LDFLAGS="$(pkg-config --libs openssl)" \
  titanc --static --tree src -o build --exe build/my-service service.main
```

## Testing Your App: `App:test` vs. `App:listen_test`

`titan-mk` ships two complementary test helpers in [`mk`](../reference/mk.md#testing) that pair directly with Titan's native `test` module (`titanc --test`).

### Fast In-Memory Tests (`App:test`)

`App:test(req, config?)` dispatches a `TestRequest` strictly in memory on the calling Lua state with zero sockets:

```titan
-- tests/service_test.titan
local service = import "service.main"
local mk = import "mk"
local test = import "test"

function test_greet_in_memory(_ctx: test.Context)
  local app = service.build_app(nil)
  local res = app:test(mk.TestRequest("GET", "/greet/titan"))
  test.assert(res.status == 200)
  test.assert(res:header("X-Request-ID") ~= nil)
  local body = res:json() as {string: value}
  test.assert(body["message"] == "hello, titan")
end
```

`App:test` defaults to a `1000` ms deadline (`TestConfig { timeout_ms = 0 }` disables it; `fail_on_timeout = false` returns whatever was committed instead of raising).

**Limits of `App:test`:** Because no OS sockets or worker threads exist, `App:test` runs only `parent`-dispatched requests (it raises on routes dispatched to `pool` or `session` workers, though session-selector `HttpError`s and `nil`-session fallbacks to a `parent` root still run), and `ctx:upgrade_websocket(...)` raises `HttpError(501)`.

### Real Loopback Server Tests (`App:listen_test`)

Whenever you test `pool` or `session` workers, keep-alive framing, streaming, TLS, or WebSocket upgrades, use `App:listen_test(host?, listen_config?)`—which binds an OS-assigned ephemeral loopback port (`port = 0`, defaulting `host` to `"127.0.0.1"`) and exposes `ts.port` and `ts.base_url`—and always pair it with `defer ts:close()`:

```titan
function test_greet_over_loopback(_ctx: test.Context)
  local app = service.build_app(nil)
  local ts = app:listen_test()
  defer ts:close()

  local res = ts:request("GET", "/greet/loopback")
  test.assert(res.status == 200)
end
```

Run your native test suite with:

```sh
titanc --incremental --test --tree "src;tests" --test-dir tests -o build --exe build/service-tests
./build/service-tests
```

Next: [Chapter 2: Routing and Handlers](routing-and-handlers.md).
