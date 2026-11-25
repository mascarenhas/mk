# Build Your First HTTP Service

In this tutorial, we'll build a small bookmark HTTP service in Titan with `titan-mk`, add typed JSON input validation, attach request-ID and structured logging middleware, and test our routes in memory.

This tutorial assumes Lua 5.5, Titan 0.6 (tested on 0.6.1), and `titan-mk` are already installed; if you still need to set them up, follow [How to Install, Build, and Link `titan-mk`](../how-to/install-and-build.md) first.

## Step 1: Start a Minimal Bookmark Server

Let's create a fresh project folder with a `src/bookmarks` package:

```sh
mkdir -p bookmarks/src/bookmarks
cd bookmarks
```

We'll split the application into two small files: `src/bookmarks/app.titan` builds the `mk.App`, and `src/bookmarks/main.titan` runs the server. Separating `build_app` from `main` lets our test suite import the application directly in Step 4.

Create `src/bookmarks/app.titan`:

```titan
local mk = import "mk"

record Bookmark
  const id: integer
  const title: string
  const url: string
end

function build_app(): mk.App
  local items: {Bookmark} = {
    Bookmark {
      id = 1,
      title = "Titan",
      url = "https://titan-lang.dev",
    },
  }

  local app = mk.App()

  app:get("/bookmarks", function (ctx: mk.Context)
    ctx:json(items)
  end)

  app:get("/bookmarks/:id", function (ctx: mk.Context)
    local id = ctx:param_int("id")
    for i = 1, #items do
      if items[i].id == id then
        ctx:json(items[i])
        return
      end
    end
    raise mk.HttpError(404, "bookmark not found", "not_found")
  end)

  return app
end
```

Now create `src/bookmarks/main.titan`:

```titan
local app_mod = import "bookmarks.app"

function main(_args: {string}): integer
  local app = app_mod.build_app()
  app:listen("127.0.0.1:8080")
  return 0
end
```

Compile the service and start it. Because `titanc` places generated C files for `bookmarks.main` inside `build/bookmarks/`, we name the executable `build/bookmarks-server` so its path doesn't collide with that directory:

```sh
titanc --incremental --tree src -o build \
  --exe build/bookmarks-server bookmarks.main
./build/bookmarks-server
```

Leave the server running in this terminal, open a second terminal, and request the bookmark list:

```sh
curl -i http://127.0.0.1:8080/bookmarks
```

You should see a `200 OK` JSON response:

```text
HTTP/1.1 200 OK
Content-Type: application/json
Content-Length: 57

[{"id":1,"title":"Titan","url":"https://titan-lang.dev"}]
```

Now fetch bookmark `1` and then pass a non-integer ID:

```sh
curl -i http://127.0.0.1:8080/bookmarks/1
curl -i http://127.0.0.1:8080/bookmarks/abc
```

The first request returns `200 OK` with `{"id":1,"title":"Titan","url":"https://titan-lang.dev"}`. The second request returns `400 Bad Request`:

```text
HTTP/1.1 400 Bad Request
Content-Type: text/plain; charset=utf-8
Content-Length: 31

parameter id must be an integer
```

Notice that `/bookmarks/abc` returned `400` in plain text without extra validation code. Calling `ctx:param_int("id")` raised an `mk.HttpError`, and `mk.App()` uses `mk.default_error_handler` until we configure another one.

## Step 2: Validate JSON Input and Return JSON Errors

Stop the server with `Ctrl-C`. Next, we'll add a `POST /bookmarks` endpoint that decodes a typed Titan record from the JSON request body and switch the app to `mk.json_error_handler`.

Update `src/bookmarks/app.titan`:

```titan
local mk = import "mk"

record Bookmark
  const id: integer
  const title: string
  const url: string
end

record BookmarkInput
  const title: string
  const url: string
end

function build_app(): mk.App
  local items: {Bookmark} = {
    Bookmark {
      id = 1,
      title = "Titan",
      url = "https://titan-lang.dev",
    },
  }

  local app = mk.App(mk.Config {
    app_name = "bookmarks",
    error_handler = mk.json_error_handler,
  })

  app:get("/bookmarks", function (ctx: mk.Context)
    ctx:json(items)
  end)

  app:get("/bookmarks/:id", function (ctx: mk.Context)
    local id = ctx:param_int("id")
    for i = 1, #items do
      if items[i].id == id then
        ctx:json(items[i])
        return
      end
    end
    raise mk.HttpError(404, "bookmark not found", "not_found")
  end)

  app:post("/bookmarks", function (ctx: mk.Context)
    local input = ctx:bind():named(
      "bookmarks.app.BookmarkInput"
    ) as BookmarkInput
    local created = Bookmark {
      id = #items + 1,
      title = input.title,
      url = input.url,
    }
    items[#items + 1] = created
    ctx:status(201):json(created)
  end)

  return app
end
```

Notice the full logical module name `"bookmarks.app.BookmarkInput"` passed to `ctx:bind():named(...)`. Titan reflection identifies every nominal type by its logical module path (`bookmarks.app` for `src/bookmarks/app.titan`) followed by the record name.

Recompile and restart the server:

```sh
titanc --incremental --tree src -o build \
  --exe build/bookmarks-server bookmarks.main
./build/bookmarks-server
```

In your second terminal, send a valid JSON bookmark:

```sh
curl -i -X POST http://127.0.0.1:8080/bookmarks \
  -H 'Content-Type: application/json' \
  -d '{"title":"titan-mk","url":"https://mk.titan-lang.dev"}'
```

The server creates bookmark `2` and replies with `201 Created`:

```text
HTTP/1.1 201 Created
Content-Type: application/json
Content-Length: 61

{"id":2,"title":"titan-mk","url":"https://mk.titan-lang.dev"}
```

Now send two broken payloads—first truncated JSON, then valid JSON missing the required `url` field:

```sh
curl -i -X POST http://127.0.0.1:8080/bookmarks \
  -H 'Content-Type: application/json' \
  -d '{"title":'

curl -i -X POST http://127.0.0.1:8080/bookmarks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Missing URL"}'
```

Look closely at the two status codes and JSON bodies:

```text
HTTP/1.1 400 Bad Request
Content-Type: application/json

{"code":"expected_value","message":"expected a JSON value","status":400}
```

```text
HTTP/1.1 422 Status
Content-Type: application/json

{"code":"missing_field","message":"...","status":422}
```

Notice how `ctx:bind()` separates syntax failures (`400`) from schema mismatches against `BookmarkInput` (`422`), and how `mk.json_error_handler` serializes every `mk.HttpError` with sorted keys (`code`, `message`, `status`) while `titan.http` emits `Status` as the HTTP reason phrase for `422`. To learn why `titan-mk` draws this boundary, see [About the Request, Middleware, and Error Lifecycle](../explanation/request-lifecycle.md).

## Step 3: Add Request IDs, Recovery, and Structured Logging

Stop the server with `Ctrl-C`. Let's wire a structured JSON-line logger and three built-in middleware modules (`requestid`, `recover`, and `logger`) ahead of our routes.

Update `src/bookmarks/app.titan`:

```titan
local mk = import "mk"
local log = import "mk.log"
local logger_mw = import "mk.middleware.logger"
local recover = import "mk.middleware.recover"
local requestid = import "mk.middleware.requestid"

record Bookmark
  const id: integer
  const title: string
  const url: string
end

record BookmarkInput
  const title: string
  const url: string
end

function build_app(app_logger: log.Logger?): mk.App
  local items: {Bookmark} = {
    Bookmark {
      id = 1,
      title = "Titan",
      url = "https://titan-lang.dev",
    },
  }

  local app = mk.App(mk.Config {
    app_name = "bookmarks",
    logger = app_logger,
    error_handler = mk.json_error_handler,
  })

  app:use(requestid.new(), recover.new(), logger_mw.new())

  app:get("/bookmarks", function (ctx: mk.Context)
    ctx:json(items)
  end)

  app:get("/bookmarks/:id", function (ctx: mk.Context)
    local id = ctx:param_int("id")
    for i = 1, #items do
      if items[i].id == id then
        ctx:json(items[i])
        return
      end
    end
    raise mk.HttpError(404, "bookmark not found", "not_found")
  end)

  app:post("/bookmarks", function (ctx: mk.Context)
    local input = ctx:bind():named(
      "bookmarks.app.BookmarkInput"
    ) as BookmarkInput
    local created = Bookmark {
      id = #items + 1,
      title = input.title,
      url = input.url,
    }
    items[#items + 1] = created
    ctx:status(201):json(created)
  end)

  return app
end
```

Now update `src/bookmarks/main.titan` so it creates the logger and closes it on exit with `defer` (`mk.App` never closes a logger it didn't create):

```titan
local log = import "mk.log"
local app_mod = import "bookmarks.app"

function main(_args: {string}): integer
  local app_logger = log.Logger("info")
  defer app_logger:close()

  local app = app_mod.build_app(app_logger)
  app:listen("127.0.0.1:8080")
  return 0
end
```

Recompile and restart the server:

```sh
titanc --incremental --tree src -o build \
  --exe build/bookmarks-server bookmarks.main
./build/bookmarks-server
```

Send a request from the second terminal:

```sh
curl -i http://127.0.0.1:8080/bookmarks/1
```

In the response headers, you'll now see an `X-Request-ID` header containing a generated 32-character hex token:

```text
HTTP/1.1 200 OK
X-Request-ID: <32-hex-id>
Content-Type: application/json
Content-Length: 55

{"id":1,"title":"Titan","url":"https://titan-lang.dev"}
```

Switch to the server terminal and inspect the JSON line written to stderr (formatted across lines below for readability; `mk.log` emits it on one line, and your timestamp, latency, and request ID will differ):

```json
{
  "event": "http_request",
  "latency_ms": 0.21,
  "level": "info",
  "method": "GET",
  "request_id": "<32-hex-id>",
  "route": "/bookmarks/:id",
  "status": 200,
  "timestamp": "2026-11-25T06:30:00Z"
}
```

Notice two details in that log record. First, `request_id` matches the `X-Request-ID` response header because `requestid.new()` ran before `logger_mw.new()`. Second, `route` records the declared pattern `/bookmarks/:id` instead of `/bookmarks/1`, which keeps log cardinality bounded.

## Step 4: Write and Run an In-Memory Test

Stop the server with `Ctrl-C`. We can exercise our routes without binding a socket by calling `app:test(...)` inside a native Titan test module.

Create a `tests` folder and write `tests/bookmarks_test.titan`:

```sh
mkdir -p tests
```

```titan
local http = import "http"
local test = import "test"
local mk = import "mk"
local app_mod = import "bookmarks.app"

function test_bookmark_routes(_: test.Context)
  local app = app_mod.build_app(nil)

  local list_res = app:test(mk.TestRequest("GET", "/bookmarks"))
  test.assert(list_res.status == 200, "expected 200")
  test.assert(list_res:header("X-Request-ID") ~= nil, "missing id")

  local headers = http.headers()
  headers:set("Content-Type", "application/json")
  local body =
    '{"title":"titan-mk","url":"https://mk.titan-lang.dev"}'
  local create_res = app:test(mk.TestRequest {
    method = "POST",
    target = "/bookmarks",
    headers = headers,
    body = body,
  })
  test.assert(create_res.status == 201, "expected 201")

  local created = create_res:json() as {string: value}
  test.assert(created["id"] == 2, "expected id 2")
  test.assert(created["title"] == "titan-mk", "expected title")

  local bad_res = app:test(mk.TestRequest {
    method = "POST",
    target = "/bookmarks",
    headers = headers,
    body = '{"title":"Missing URL"}',
  })
  test.assert(bad_res.status == 422, "expected 422")
end
```

Compile and run the test binary:

```sh
titanc --incremental --test --tree "src;tests" \
  --test-dir tests -o build --exe build/bookmarks-tests
./build/bookmarks-tests
```

The test runner prints a passing summary (exact timings will vary):

```text
[==========] Running Titan tests.
[ RUN      ] bookmarks_test.test_bookmark_routes
[       OK ] bookmarks_test.test_bookmark_routes (0.35 ms)
[----------] bookmarks_test (0.35 ms total)
[==========] 1 tests ran. (0.35 ms total)
[  PASSED  ] 1 tests.
```

We now have a compiled `titan-mk` HTTP service with typed JSON input, structured error responses, request tracing, and automated in-memory tests.

## Where to Go Next

- Define route groups, chains, mounted sub-apps, and custom error handlers in [How to Define Routes, Bind JSON, and Return Errors](../how-to/routes-and-json-apis.md).
- Configure authentication, timeouts, security headers, and static file serving in [How to Compose Middleware and Structured Logging](../how-to/middleware-and-logging.md).
- Look up every record field, default value, and error code in the [`mk` Module Reference](../reference/mk.md).
- Read about request execution order, observers, and error boundaries in [About the Request, Middleware, and Error Lifecycle](../explanation/request-lifecycle.md).
