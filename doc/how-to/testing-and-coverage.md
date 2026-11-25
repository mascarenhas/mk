# How to Test Services and Measure Line Coverage

`titan-mk` ships two testing helpers—in-memory `App:test` and loopback `App:listen_test`—designed for Titan's native `titan.test` runner and `titanc --coverage`. For full record fields and error strings, see [`Testing`](../reference/mk.md#testing) in the `mk` reference.

## Structure an App for Testing

Export a `build_app` function from a module separate from `main` (for example, `src/service/app.titan` vs. `src/service/main.titan`). Call `build_app` inside each test case so every test starts with a fresh, unfrozen `mk.App` and isolated state:

```titan
-- src/service/app.titan
local mk = import "mk"
local log = import "mk.log"

function build_app(app_logger: log.Logger?): mk.App
  local app = mk.App(mk.Config {
    logger = app_logger,
    error_handler = mk.json_error_handler,
  })
  app:get("/health", function (ctx: mk.Context)
    ctx:send_string("ok")
  end)
  return app
end
```

Because `App:test` and `App:start` freeze route registration on first call, never register extra routes on an `App` instance after testing or starting it.

## Test Routes in Memory with `App:test`

Use `App:test(req, config?)` for fast, zero-socket tests of parent-dispatched routes, middleware, JSON binding, cookies, and error handlers:

```titan
local test = import "test"
local mk = import "mk"
local app_mod = import "service.app"

function test_health_and_json(context: test.Context)
  local app = app_mod.build_app(nil)

  context:run("health", function (_: test.Context)
    local res = app:test(mk.TestRequest("GET", "/health"))
    test.assert(res.status == 200, "expected 200")
    test.assert(res.body == "ok", "unexpected body")
    test.assert(
      res:header("Content-Type") == "text/plain; charset=utf-8"
    )
  end)

  context:run("custom_timeout", function (_: test.Context)
    local res = app:test(
      mk.TestRequest {
        method = "get",
        target = "/health",
        tls = true,
      },
      mk.TestConfig { timeout_ms = 500 }
    )
    test.assert(res.status == 200)
  end)
end
```

`App:test` uppercases `req.method`, adds `Host: example.com` if missing, sets `Content-Length` automatically when `body` is present without `Content-Length` or `Transfer-Encoding`, and sets scheme `https` when `tls = true`. The default deadline is `1000 ms` with `fail_on_timeout = true` (`timeout_ms = 0` disables the deadline; `fail_on_timeout = false` returns whatever was committed, or `TestResponse(0, <empty headers>, "")`).

Know the exact boundaries of `App:test` so you switch to `App:listen_test` when needed:

- **Worker routes raise:** If classification lands on a `pool` or `session` worker, `App:test` raises `"mk: App:test runs only parent-dispatched requests in memory; pool and session worker routes need App:listen_test"`. Session selector `HttpError`s and `nil`-session fallbacks to a parent root still run in memory.
- **WebSocket upgrades return `501`:** Calling `ctx:upgrade_websocket` raises `HttpError(501, ..., "upgrade_unavailable")`, which the error handler renders as a `501` response rather than raising out of `App:test`.
- **No peer socket:** `ctx:peer_address()` returns `nil`.
- **Aborted streams raise:** Aborting a committed response raises `"mk: connection aborted"`.

## Test Workers and Sockets with `App:listen_test`

Use `App:listen_test(host?, listen_config?)` whenever you test `pool` or `session` workers, WebSocket upgrades, streaming, keep-alive reuse, peer addresses, or TLS. It binds an OS-assigned ephemeral port (`port = 0`, default host `"127.0.0.1"`), serves in a background Task, and exposes `TestServer.base_url` and `TestServer:request(...)`:

```titan
local http = import "http"
local test = import "test"
local mk = import "mk"
local app_mod = import "service.app"

function test_live_loopback(_: test.Context)
  local app = app_mod.build_app(nil)
  local server = app:listen_test()
  defer server:close()

  local res = server:request("GET", "/health")
  test.assert(res.status == 200, "expected 200")
  test.assert(res.body == "ok", "unexpected body")

  local headers = http.headers()
  headers:set("Accept", "application/json")
  local res2 = server:request("GET", "/health", http.RequestOptions {
    headers = headers,
  })
  test.assert(res2.status == 200)
end
```

Always register `defer server:close()` immediately after `app:listen_test()`. `TestServer:close()` is idempotent and shuts down the app cleanly, but it calls `app:shutdown()` internally and therefore cannot be invoked from inside a request handler or lifecycle hook.

Pass `mk.ListenConfig { cert_file = ..., key_file = ... }` to test HTTPS on loopback (`server.base_url` automatically switches to `https://`). For WebSocket clients or raw HTTP sockets, connect directly to `server.host` and `server.port`.

## Run and Filter Native Tests

### In a consumer project

Compile and run all test modules under `tests/` with `titanc --test`:

```sh
titanc --incremental --test --tree "src;tests" \
  --test-dir tests -o build --exe build/service-tests
./build/service-tests
```

When `--tree "src;tests"` includes `tests` as its own root, test files get top-level logical module names (for example, `tests/service_test.titan` becomes `service_test`). Remember that logical name if a test defines a record decoded with `ctx:bind():named("service_test.MyInput")`.

Filter tests with repeatable `-f PATTERN` or `--filter=PATTERN` flags using Lua pattern syntax (combined with logical OR; invalid patterns exit `2`):

```sh
./build/service-tests --filter=health
./build/service-tests -f health -f json
```

### In a `titan-mk` checkout

Use the repository Makefile targets to build or run the framework test suite:

```sh
make tests                               # compile build/mk-tests only
make test                                # compile and run full suite
make test TEST_ARGS='--filter=router'    # filter by Lua pattern
make test TEST_ARGS='-f bind -f worker'  # multiple OR filters
```

## Measure Executable Line Coverage

### In a `titan-mk` checkout

Run `make coverage` to build an instrumented test binary under `build/coverage/`, execute the full suite with `TITAN_FILTER` unset, and write the annotated gcov report to `build/coverage/.coverage/report/coverage.gcov`:

```sh
make coverage
```

Generate additional `gcovr` reports (`html`, `lcov`, or `cobertura`) by setting `COVERAGE_FORMAT` (space-separated), and override tools or extra flags as needed:

```sh
make coverage COVERAGE_FORMAT=lcov
make coverage COVERAGE_FORMAT='html lcov' \
  COVERAGE_GCOV=gcov-14 COVERAGE_GCOVR=gcovr
```

`make coverage` keeps instrumented objects inside `build/coverage` so ordinary `build/` outputs remain untouched, and clears `GCOV_PREFIX`, `GCOV_PREFIX_STRIP`, and `TITAN_FILTER` so counter files land next to their objects and every test runs.

### In a consumer project

Pass `--coverage` to `titanc --test` with a dedicated `-o build/coverage` output tree:

```sh
env -u GCOV_PREFIX -u GCOV_PREFIX_STRIP \
  titanc --incremental --coverage --test \
  --tree "src;tests" --test-dir tests \
  -o build/coverage --exe build/coverage/service-tests
env -u TITAN_FILTER -u GCOV_PREFIX -u GCOV_PREFIX_STRIP \
  ./build/coverage/service-tests
```

On GCC, use GCC 14+ with a matching `gcov` (`CC=gcc-14`, `--coverage-gcov gcov-14`). On Clang, select the LLVM backend (`--coverage-backend llvm-gcov --coverage-gcov 'llvm-cov gcov'`). Add `--coverage-format lcov` (or `html`, `cobertura`) when `gcovr` 8.4 is installed, and use repeatable `--coverage-module 'service.*'` globs to override automatic module selection.
