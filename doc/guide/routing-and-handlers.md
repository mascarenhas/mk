# Chapter 2: Routing and Handlers

This chapter explains how `titan-mk` parses and matches routes, organizes endpoints into groups and chains, inspects requests through `Context` and `RequestMeta`, binds JSON request bodies, handles errors via `HttpError`, and writes buffered, streamed, or upgraded WebSocket responses.

For exact type definitions and every method signature, see the [`mk`](../reference/mk.md) and [`mk.router`](../reference/mk-router.md) references.

## How PEG Routing Works

All routes and middleware prefixes are declared before `App:start()`, `App:listen()`, or `App:test()` freezes the routing table. Under the hood, `mk.router` parses every route pattern with a precompiled `titan.peg` grammar and compiles it into one of two matchers:

1. **Fast single-pass PEG matcher:** Static routes, whole-segment required `:name` parameters, prefix middleware paths, and single terminal `*` / `+` wildcards compile to a single `peg.Pattern` executed linearly in LPeg's C VM.
2. **General $O((M + L) \cdot A)$ evaluator:** Patterns with optional parameters (`:name?`), multiple or non-terminal wildcards, adjacent parameters (`/:sign:value`), or in-segment delimiters (`/:genus.:species`) tokenize the request path with a `titan.peg` atomizer and run a bottom-up feasibility table with precomputed suffix lookups, guaranteeing greedy left-to-right semantics without exponential backtracking.

During matching, `%XX` escapes are treated as atomic units so `%2F` never acts as a raw `/` segment boundary.

### Parameters, Optionals, and Wildcards

```titan
app:get("/users/:id", show_user)                -- required segment param
app:get("/posts/:year/:month?", list_posts)     -- optional segment (leading "/" optional)
app:get("/species/:genus.:species", taxonomy)   -- in-segment delimiter
app:get("/shop/color::color", shop_color)       -- literal ":" before ":color"
app:get("/assets/*", serve_assets)              -- 0+ atoms; keys "*" and "*1"
app:get("/files/+", serve_files)                -- 1+ atoms; keys "+" and "+1"
```

Backslash escapes (`\:`, `\?`, `\*`, `\+`, `\\`, `\<`) match literal metacharacters.

### Why Inline Routing Constraints Are Rejected

GoFiber-style inline parameter constraints (`:id<int>`, `:slug<regex(...)>`) are intentionally omitted from `titan-mk`. Any unescaped `<` in a route pattern fails immediately at registration time with a `router.RouteError` whose `code` is `"routing_constraints_unsupported"`.

Validate parameter types explicitly in handlers instead:

```titan
local function show_user(ctx: mk.Context)
  local id = ctx:param_int("id")
  if id <= 0 then
    raise mk.HttpError(400, "user id must be positive", "invalid_id")
  end
  -- ...
end
```

## Organizing Routes: Groups, Chains, and Mounting

### Groups (`Group` and `GroupOptions`)

Groups share a path prefix, scoped middleware, an optional route-name prefix, and an optional [`WorkerMode`](workers-and-sessions.md):

```titan
local v1 = app:group_with("/api/v1", mk.GroupOptions {
  name = "v1.",
  workers = mk.WorkerMode.pool(mk.PoolOptions { size = 4 }),
}, auth_mw)

v1:get("/items", list_items):name("items.list")       -- route name: "v1.items.list"
v1:post("/items", create_item):name("items.create")
```

Nested groups (`v1:group("/admin", admin_mw)`) concatenate prefixes and route-name prefixes and inherit their parent group's worker mode unless overridden.

### Chaining Methods on One Path (`RouteChain`)

Use `route_chain` when a single resource path handles several HTTP methods:

```titan
app:route_chain("/articles/:id")
  :get(show_article)
  :put(replace_article)
  :delete(delete_article)
  :route_chain("/comments")
    :get(list_comments)
    :post(add_comment)
```

### Mounting Sub-Apps (`App:mount`)

`app:mount("/admin", admin_app)` copies `admin_app`'s middleware and routes beneath `/admin`. Routes copied from `admin_app` without an explicit per-route worker mode keep `admin_app`'s `Config.workers` rather than silently inheriting the parent app's dispatcher.

### Reverse URL Building

Name any route with `RouteHandle:name(...)` and generate paths with `app:route_url(name, params?)`:

```titan
app:get("/users/:id/posts/:slug?", show_post):name("user.post")

local p1 = app:route_url("user.post", { ["id"] = "42", ["slug"] = "hello world" })
-- "/users/42/posts/hello%20world"

local p2 = app:route_url("user.post", { ["id"] = "42" })
-- "/users/42/posts"
```

Segment parameters are percent-encoded (`/` becomes `%2F`), wildcard values preserve `/`, absent optional whole-segment parameters and `*` wildcards vanish cleanly, and missing required parameters raise.

## `auto_head` and First-Occurrence `405 Allow`

- **Automatic `HEAD` fallback (`Config.auto_head`, default `true`):** When a `HEAD` request arrives, `mk` checks whether any explicit `HEAD` (or an `all(...)`) route matches first. If none does, `mk` falls back to matching `GET` routes, executes the handler chain, and suppresses the response body on the wire while keeping status and headers intact.
- **First-occurrence `405 Allow`:** If middleware completes and no route matched the request method, `mk` scans routes whose pattern matches the path and builds a deduplicated `Allow` header in **first-occurrence registration order** (inserting `HEAD` right after `GET` when `auto_head` is enabled and `HEAD` was not already seen), sets `Allow`, and raises `mk.HttpError(405, "Method Not Allowed")`. If no route matches the path at all, `mk` raises `404`.

## Inspecting Requests: `Context` and `RequestMeta`

Every handler receives `ctx: mk.Context`. Before dispatch (and inside `SessionExtractor` callbacks), read-only request metadata is exposed through `mk.RequestMeta` (`method`, `path`, `original_url`, `scheme`, `host`, plus `peer_address`, `param`, `query`, `get`, and `cookie` accessors).

Key `Context` inspection patterns:

- **Parameters & queries:** `ctx:param("id")`, `ctx:param_opt("id")`, `ctx:param_int("id")`, `ctx:query("q")`, `ctx:query_int("page", 1)`, `ctx:query_bool("draft", false)`.
- **Headers & negotiation:** `ctx:get("Accept")`, `ctx:header_opt("If-None-Match")`, `ctx:is_json()`, `ctx:bearer()`, `ctx:accepts({"application/json", "text/plain"})`.
- **Cookies:** `ctx:cookie("sid")` to read; `ctx:set_cookie(mk.Cookie { name = "sid", value = tok, http_only = true, secure = true, same_site = "Lax" })` and `ctx:clear_cookie("sid")` to write.
- **Route info:** `ctx:matched_route()` (pattern of the endpoint currently executing, or `""` before matching), `ctx:classified_route()` (pattern the request classified to at dispatch, available even in outer admission middleware), `ctx:endpoint()`, `ctx:route_name()`, `ctx:mount_path()`.
- **Client socket address:** `ctx:peer_address()` (and `meta:peer_address()` on `RequestMeta`) returns the direct TCP/TLS peer `net.Address?` captured while the exchange was live (preserved across worker-thread handoff and `on_complete` hooks). It returns `nil` in in-memory `App:test` runs or if the peer disconnected before capture. `X-Forwarded-For` / `trusted_proxies` are intentionally omitted.
- **Forwarded scheme/host headers:** `Config.trust_forwarded_headers` defaults to `false`. Enable it **only** behind a trusted reverse proxy that strips client-supplied `X-Forwarded-Proto` and `X-Forwarded-Host` headers.

## JSON-Only Request Binding (`ctx:bind()`)

`titan-mk` binds **JSON request bodies only**. Use `ctx:bind():named("mod.Record")`, `ctx:bind():json(schema?)`, `ctx:bind():object()`, or `ctx:bind():array()`:

```titan
record CreateItem
  const title: string
  const count: integer
end

local function create_item(ctx: mk.Context)
  local item = ctx:bind():named("service.CreateItem") as CreateItem
  ctx:status(201):json(item)
end
```

`Bind` enforces `Config.body_limit` (default 4 MiB) and `Config.json_max_depth` (default 64) and maps client errors cleanly to `mk.HttpError`:

- **`415 Unsupported Media Type`** (`"unsupported_media_type"`): missing or non-JSON `Content-Type`.
- **`413 Content Too Large`** (`"body_too_large"`): body exceeds `Config.body_limit`. Before headers commit, `mk` marks the response with `Connection: close` so `titan.http` closes the connection normally without draining unread request-body bytes or aborting the transport (the same skip-drain path applies when the client sent `Connection: close` or a closing response announced `Connection: close` before commit; only an already-committed persistent response whose close decision arrives later or a failed bounded drain aborts the transport).
- **`400 Bad Request`**: empty body (`"empty_body"`) or malformed JSON syntax / depth / size error.
- **`422 Unprocessable Content`**: valid JSON that violates the requested schema (`type_mismatch`, `missing_field`, `unknown_field`, `invalid_union`, `unknown_variant`, `non_integral`, plus `integer_range`/`number_range` when `schema ~= nil`).
- **Programmer errors re-raise unchanged:** unknown type names, unavailable constructors, unsupported types, invalid options, or non-`json.Error` exceptions from custom `Record.new` are never turned into `4xx`.

For raw body access without JSON decoding, use `ctx:body()` (cached) or `ctx:read_body_chunk()` (streaming). On HTTP `Upgrade` offers or `CONNECT`, both return `""` / `nil` safely without attempting a forbidden read.

## Error Flow: `HttpError` and `ErrorHandler`

Handlers return nothing and signal expected HTTP errors with `raise mk.HttpError(status, message?, code?, cause?)`:

- Statuses outside `200..999` normalize to `500` first, and an omitted `message` defaults to `mk.status_message` of that normalized status (so an out-of-range status gets `"Internal Server Error"`).
- Outer middleware can `catch` `mk.HttpError` directly to inspect, enrich, or recover from it.
- Uncaught `HttpError` values record themselves in `ctx:last_error()` and invoke `Config.error_handler(ctx, err)` if headers have not yet been committed (`mk.default_error_handler` for plain text, `mk.json_error_handler` for JSON, or your own function). If `error_handler` itself raises an uncommitted `HttpError`, `mk` falls back to `mk.default_error_handler`.
- If headers were **already committed** (streaming or WebSocket), an escaping `HttpError` aborts the unfinished transport so partial output is never framed as complete.
- Unexpected non-`HttpError` exceptions are not swallowed unless [`mk.middleware.recover`](middleware-and-logging.md#error-recovery-and-deadlines) is installed; `async.CancellationReason` is **never** swallowed.

## Buffered vs. Streaming Responses and WebSockets

### Buffered Responses (Default)

Methods like `ctx:status(200)`, `ctx:set(...)`, `ctx:type("json")`, `ctx:json(val)`, `ctx:send_string(text)`, `ctx:html(markup)`, `ctx:redirect(url)`, and `ctx:send_file(path)` stage the response in memory until the handler returns or you call `ctx:commit()`. Buffered responses (and `flush_headers()` when staged body bytes are already pending) hand status and headers to `titan.http` without flushing separately, allowing headers and body to coalesce into a single transport write. Calling `ctx:commit()` flushes the response early so post-response work does not delay the client.

### Streaming Responses

For large or incremental payloads, switch to streaming:

```titan
local function stream_events(ctx: mk.Context)
  ctx:set("Content-Type", "text/event-stream")
  ctx:flush_headers()
  ctx:write_chunk("data: first\n\n")
  ctx:write_chunk("data: second\n\n")
end
```

You can also stream any `io.Reader` directly with `ctx:send_stream(reader, content_length?)`. Once committed (`ctx:committed() == true`), status and headers are frozen; call `ctx:abort()` if an unrecoverable mid-stream error occurs.

### WebSocket Upgrades

On a live server (`App:listen` or `App:listen_test`), call `ctx:upgrade_websocket(options?)` to perform a WebSocket handshake (running `on_before_commit` hooks and copying staged response headers onto the `101` response) and return an owned `websocket.Connection`:

```titan
local websocket = import "websocket"

local function echo_ws(ctx: mk.Context)
  local ws = ctx:upgrade_websocket()
  while true do
    local _kind?, data? = ws:read()
    if data == nil then break end
    ws:write(websocket.TEXT, data)
  end
end
```

`mk` closes the `websocket.Connection` automatically when the handler chain returns. Use `ctx:reject_upgrade(403)` to reject an upgrade offer cleanly with a bodyless `4xx`/`5xx` response.

Next: [Chapter 3: Middleware and Logging](middleware-and-logging.md).
