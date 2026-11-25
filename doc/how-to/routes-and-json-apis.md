# How to Define Routes, Bind JSON, and Return Errors

`titan-mk` compiles route patterns at registration time, decodes JSON request bodies through `ctx:bind()`, and turns raised `mk.HttpError` values into formatted responses. For complete signatures and defaults, see the [`mk` Module Reference](../reference/mk.md) and [`mk.router` Module Reference](../reference/mk-router.md).

## Define Route Patterns

Register routes on an `mk.App` before calling `App:start` or `App:test`, which freeze registration. Every pattern begins with `/`, and patterns compile immediately at registration time:

```titan
app:get("/users/:id", show_user)
app:get("/docs/:lang?", show_docs)
app:get("/files/:name.:ext", download_file)
app:get("/assets/*", serve_asset)
app:get("/blobs/+", serve_blob)
```

Follow these pattern rules when designing URLs:

- **Optional whole segments:** `/docs/:lang?` makes both the segment and its leading `/` optional, matching `/docs` and `/docs/en`.
- **Wildcards:** Whole-segment `/*` matches zero or more atoms and makes its leading `/` optional (`/assets/*` matches `/assets` with `*` equal to `""`). Whole-segment `/+` requires at least one atom. Access captures as `"*"` (or `"*1"`), `"*2"` and `"+"` (or `"+1"`), `"+2"`.
- **Escaping special characters:** Escape `:`, `?`, `*`, `+`, `\`, and `<` with a leading backslash (`\:`, `\?`, `\*`, `\+`, `\\`, `\<`). Before a `:name` parameter, `::` matches a literal `:` followed by the parameter (for example, `"/color::name"` matches `"/color:red"`).
- **Validate parameter types in handlers:** Inline constraints such as `/users/:id<int>` raise a `router.RouteError` at registration. Parse and validate inside the handler with `ctx:param_int("id")`, or raise `mk.HttpError(400, ...)` directly. For the rationale, see [About PEG Routing and Route Constraints](../explanation/peg-routing.md).

`Config.auto_head` is enabled by default so `HEAD` requests fall back to a matching `GET` route when no explicit `HEAD` or `all` route matches the path. Set `auto_head = false` in `mk.Config` if `HEAD` should instead receive `405 Method Not Allowed`. When a path matches one or more routes for other methods and no endpoint ran, `mk` sets `Allow` in first-occurrence registration order and raises `405`.

## Group, Chain, and Mount Routes

### Group routes under a shared prefix

Use `app:group` or `app:group_with` to attach a shared path prefix, middleware, route-name prefix, or worker mode. Group prefixes match whole segments only (`/api` does not match `/apix`):

```titan
local api = app:group_with("/api", mk.GroupOptions {
  name = "api.",
}, require_auth)

local v1 = api:group_with("/v1", mk.GroupOptions {
  name = "v1.",
})

v1:get("/items/:id", show_item):name("item")
```

Nested groups concatenate both the path prefix (`/api/v1`) and the name prefix (`api.v1.`), and inherit the parent group's worker mode unless `GroupOptions.workers` overrides it.

### Chain methods on one path

Use `route_chain` when several HTTP methods share the same path. Method calls on a `RouteChain` take no path argument and return the chain:

```titan
app:route_chain("/articles/:id")
  :get(show_article)
  :put(replace_article)
  :delete(delete_article)
  :route_chain("/comments")
    :get(list_comments)
    :post(create_comment)
```

### Mount a sub-application

Use `app:mount(prefix, sub_app)` to compose reusable sub-applications:

```titan
local admin = mk.App(mk.Config {
  workers = admin_pool,
})
admin:get("/stats", show_stats):name("admin.stats")

app:mount("/admin", admin)
```

`App:mount` snapshots `sub_app`'s entries at call time; routes added to `sub_app` afterward are not included. Mounted routes keep their names unprefixed (`"admin.stats"`), retain `sub_app`'s worker mode if they did not set an explicit one, and trigger the parent app's `on_route` hooks.

## Build URLs from Named Routes

Attach names with `RouteHandle:name(...)` and build paths with `app:route_url(name, params?)`:

```titan
app:get("/users/:id/posts/:slug?", show_post):name("user.post")

local url = app:route_url("user.post", {
  ["id"] = "42",
  ["slug"] = "hello world",
})
-- "/users/42/posts/hello%20world"
```

Segment parameters are percent-encoded (`/` becomes `%2F`, space becomes `%20`), while wildcard values (`*`, `+`) keep `/`. Absent or empty optional whole segments and whole-segment `*` wildcards are omitted with their slash. Missing required `:name` or `+` values raise a plain string error.

## Read Request Data

Read route parameters, query fields, headers, and cookies through `Context`:

```titan
local function search(ctx: mk.Context)
  local id = ctx:param_int("id")
  local page = ctx:query_int("page", 1)
  local active = ctx:query_bool("active", true)
  local tags = ctx:query_values("tag")
  local token? = ctx:bearer()
  local peer? = ctx:peer_address()
  local lang? = ctx:accepts({ "json", "html" })

  if peer ~= nil then
    ctx:set("X-Peer", peer.ip .. ":" .. peer.port)
  end

  local result: {string: value} = {
    ["id"] = id,
    ["page"] = page,
    ["active"] = active,
    ["tag_count"] = #tags,
    ["has_token"] = token ~= nil,
    ["format"] = lang or "none",
  }
  ctx:json(result)
end
```

Keep these details in mind when reading request fields:

- **Typed parsers:** `param_int`, `query_int`, `query_float`, and `query_bool` raise `HttpError(400, ..., "invalid_parameter")` when a required value is missing, empty, or malformed. Pass a default value as the second argument when the field is optional.
- **Optional bindings:** Bind nullable return values (`peer_address()`, `bearer()`, `accepts()`, `header_opt()`, `cookie_opt()`, `logger()`) with `local x? = ...`. Omitting `?` in Titan inserts a non-nil assertion that raises on `nil`.
- **Cookies:** Use `ctx:cookie(name, default?)` or `ctx:cookie_opt(name)` to read request cookies, `ctx:set_cookie(mk.Cookie { ... })` to send `Set-Cookie`, and `ctx:clear_cookie(name, path?, domain?)` to expire one.
- **Reverse proxies:** Set `trust_forwarded_headers = true` in `mk.Config` when running behind a trusted proxy so `ctx:scheme()` and `ctx:host()` honor the first entry of `X-Forwarded-Proto` (`http` or `https`) and `X-Forwarded-Host`. `ctx:peer_address()` always reports the direct socket peer and does not read `X-Forwarded-For`.
- **Malformed targets:** If a raw request target fails parsing, `mk` does not auto-reject with `400`; inspect `ctx:target_error()` in middleware if you want to reject malformed targets explicitly.

## Decode JSON Request Bodies

`ctx:bind()` decodes JSON request bodies only. Choose the binding method that matches the target shape:

```titan
-- In src/service/app.titan (logical module "service.app")
record CreateItem
  const title: string
  const count: integer
end

local function create_item(ctx: mk.Context)
  local item = ctx:bind():named(
    "service.app.CreateItem"
  ) as CreateItem
  ctx:status(201):json(item)
end
```

- **`ctx:bind():named(type_name, ...)`:** Decodes into a public Titan record or union. Pass the **full logical module name** plus the type name (for example, `"service.app.CreateItem"` for a record in `src/service/app.titan`, or `"service.main.CreateItem"` for `src/service/main.titan`).
- **`ctx:bind():json(schema?, ...)`:** Decodes against any `reflect.Type` (such as `reflect.Type.is_integer()`) or dynamically when `schema` is `nil`.
- **`ctx:bind():object(...)` and `ctx:bind():array(...)`:** Decodes a JSON object into `{string: value}` or a JSON array into `{value}`.

Configure size and nesting ceilings on `mk.Config` via `body_limit` (default `4 MiB`) and `json_max_depth` (default `64`). `ctx:bind()` converts client input errors into `mk.HttpError` values automatically:

- Non-JSON `Content-Type` raises `415` (`"unsupported_media_type"`).
- Oversized bodies raise `413` (`"body_too_large"`), mark the connection to close, and remain sticky on repeated reads.
- Empty or syntactically invalid JSON raises `400` (`"empty_body"` or the `json.Error` code).
- Schema mismatches against a target type raise `422` with the `json.Error` code (`"missing_field"`, `"type_mismatch"`, `"unknown_field"`, and related codes).

Programmer errors from `json.decode` (`unknown_type`, `constructor_unavailable`, `unsupported_type`, `invalid_option`) and non-`json.Error` failures raised by a custom `Record.new` are re-raised unchanged so they surface as server faults (an aborted connection and an `http_request_failed` log on a live server, a re-raised error in `App:test`, or a `500` `"internal_error"` when `mk.middleware.recover` is installed) instead of client `4xx` errors. See [`Bind`](../reference/mk.md#requestmeta-cookie-context-and-bind) for the full classification matrix.

## Raise and Format HTTP Errors

Raise `mk.HttpError` anywhere in a handler or middleware to abort the current chain and invoke `Config.error_handler`:

```titan
raise mk.HttpError(404)
raise mk.HttpError(409, "slug already taken", "conflict")
```

Set `error_handler = mk.json_error_handler` in `mk.Config` for JSON APIs, or supply a custom `mk.ErrorHandler`:

```titan
local function api_error(ctx: mk.Context, err: mk.HttpError)
  local body: {string: value} = {
    ["status"] = err.status,
    ["error"] = err.message,
    ["code"] = err.code,
    ["request_id"] = ctx:request_id(),
  }
  ctx:status(err.status):json(body)
end

local app = mk.App(mk.Config {
  error_handler = api_error,
})
```

Before invoking `error_handler`, `mk` clears any buffered response body while preserving headers set by middleware (such as `X-Request-ID`). If `error_handler` itself raises an `mk.HttpError`, `mk` falls back to `mk.default_error_handler`.

To recover from or transform a specific `mk.HttpError` inside middleware, catch it and re-raise every other error immediately so `async.CancellationReason` is never swallowed:

```titan
app:use(function (ctx: mk.Context)
  ctx:next()
catch
  if not (error is mk.HttpError) then raise end
  local err = error as mk.HttpError
  if err.status == 404 then
    local body: {string: string} = {
      ["error"] = "resource not found",
    }
    ctx:status(404):json(body)
    return
  end
  raise
end)
```

Keep error handlers transferable when using worker threads, because `Config.error_handler` is always transferred to worker states. See [How to Run Handlers on OS Worker Pools and Session Workers](worker-threads-and-sessions.md) and [About the Request, Middleware, and Error Lifecycle](../explanation/request-lifecycle.md).
