# Context and JSON Binding

Every HTTP request executes through a per-request `mk.Context` backed by an immutable `mk.RequestMeta` snapshot. `Context` owns request inspection, JSON body binding, buffered and streaming response output, lifecycle observers, and WebSocket takeover.

## `RequestMeta` and `trust_forwarded_headers`

`RequestMeta` is a read-only request snapshot constructed before worker dispatch so `SessionExtractor` callbacks can route a request without touching the socket or owning a `Context`:

```text
record RequestMeta
  const method: string
  const path: string
  const original_url: string
  const scheme: string
  const host: string
end
```

`RequestMeta` also exposes read-only accessors: `param(name, default?)`, `param_opt(name)`, `query(name, default?)`, `query_opt(name)`, `query_values(name)`, `get(name, default?)`, `get_headers(name)`, and `cookie(name, default?)`.

### Forwarded Headers (`Config.trust_forwarded_headers`)

`Config.trust_forwarded_headers` defaults to **`false`**. When disabled, `scheme` comes from the underlying HTTP/HTTPS listener and `host` comes from the HTTP `Host` header.

When `trust_forwarded_headers = true`:

- `X-Forwarded-Proto`: the first comma-separated entry is trimmed and ASCII-lowercased; if it is `"http"` or `"https"`, it overrides `scheme`.
- `X-Forwarded-Host`: the first comma-separated entry is trimmed; if non-empty, it overrides `host`.

Enable `trust_forwarded_headers` **only** when the server runs behind a trusted reverse proxy that strips or overwrites client-supplied `X-Forwarded-*` headers.

## Request Inspection on `Context`

- **URL, route, and metadata:** `method()`, `path()`, `original_url()`, `base_url()`, `full_url()`, `scheme()`, `secure()`, `host()`, `hostname()`, `port()`, `protocol()` (`"HTTP/1.1"`), `is_websocket()`, `is_upgrade_offer()`, `is_preflight()`, `matched_route()`, `endpoint()`, `route_name()`, `mount_path()`, `target_error()`, `start_time_ns()`, `elapsed_ms()`, `deadline_ns()`, `last_error()`.
- **Route parameters:** `param(name, default?)`, `param_opt(name)`, `param_int(name, default?)`, `params()`, `override_param(name, val)`.
- **Query string:** `query(name, default?)`, `query_opt(name)`, `query_values(name)`, `queries()`, `query_int(name, default?)`, `query_float(name, default?)`, `query_bool(name, default?)`.
- **Headers & negotiation:** `get(name, default?)`, `header_opt(name)`, `get_headers(name)`, `has_header(name)`, `req_headers()`, `content_type()`, `media_type()`, `is_json()`, `accepts(offers)`, `bearer()`.
- **Per-request locals:** `set_local(key, item)`, `get_local(key)`, `request_id()`.

## Cookies (`mk.Cookie`)

Read inbound cookies with `ctx:cookie(name, default?)`, `ctx:cookie_opt(name)`, or `ctx:cookies()`.

Emit `Set-Cookie` headers with `ctx:set_cookie(cookie)` and expire them with `ctx:clear_cookie(name, cookie_path?, domain?)`:

```titan
ctx:set_cookie(mk.Cookie {
  name = "sid",
  value = token,
  path = "/",
  max_age = 3600,
  secure = true,
  http_only = true,
  same_site = "Lax",
})
```

`Cookie` fields: `name`, `value`, `path?` (default `"/"`), `domain?`, `max_age?` (negative values clamp to `Max-Age=0`), `expires_unix?`, `secure?`, `http_only?`, and `same_site?` (`"Lax"`, `"Strict"`, or `"None"`). Cookie names, values, and attributes reject invalid syntax, control bytes, and `;` attribute injection.

## Request Body and JSON-Only `Bind`

### Reading the Raw Body

- `ctx:body()` reads, caches, and returns the entire request body as a `string`, enforcing `Config.body_limit` (default 4 MiB). Exceeding `body_limit` raises `mk.HttpError(413, "Content Too Large", "body_too_large")` and marks the connection non-reusable so the server skips draining remaining unread body bytes.
- `ctx:read_body_chunk()` streams the raw request body one chunk at a time while enforcing the same cumulative `Config.body_limit`.
- On requests carrying an HTTP `Upgrade` offer (or `CONNECT`), `ctx:body()` returns `""` and `ctx:read_body_chunk()` returns `nil` without attempting a forbidden read on the upgrade stream.

### JSON Binding (`ctx:bind()`)

`titan-mk` binds **JSON request bodies only** (for path, query, header, and cookie values, use the typed `Context` accessors above). `ctx:bind()` returns a `mk.Bind` value with four methods:

```text
function Bind:json(schema: reflect.Type?, ...: json.DecodeOption): value
function Bind:named(type_name: string, ...: json.DecodeOption): value
function Bind:object(...: json.DecodeOption): {string: value}
function Bind:array(...: json.DecodeOption): {value}
```

Example binding a nominal Titan record:

```titan
record CreateItem
  const title: string
  const count: integer
end

local function create_item(ctx: mk.Context)
  local item = ctx:bind():named("app.CreateItem") as CreateItem
  ctx:status(201):json(item)
end
```

`Bind` enforces `Config.json_max_depth` (default `64`) and `Config.body_limit` automatically and maps decode failures to exact HTTP errors:

| Failure condition | Resulting `HttpError` |
| --- | --- |
| Missing or non-JSON `Content-Type` (`not ctx:is_json()`) | `415` — `"Unsupported Media Type"`, code `"unsupported_media_type"` |
| Body exceeds `Config.body_limit` | `413` — `"Content Too Large"`, code `"body_too_large"` |
| Empty request body (`""`) | `400` — `"empty JSON request body"`, code `"empty_body"` |
| Malformed JSON syntax, trailing input, unexpected EOF, invalid UTF-8/escapes, duplicate keys, depth/size limits | `400` — `err.message`, code `err.code`, cause `err` |
| Schema/type mismatch (`type_mismatch`, `missing_field`, `unknown_field`, `invalid_union`, `unknown_variant`, `non_integral`, plus `integer_range` and `number_range` when `schema ~= nil`) | `422` — `err.message`, code `err.code`, cause `err` |
| Programmer schema/option bugs (`unknown_type`, `constructor_unavailable`, `unsupported_type`, `invalid_option`) or non-`json.Error` exceptions raised by custom `Record.new` | **Re-raised unchanged** (not turned into `4xx`) |

## Buffered vs. Streaming Responses and `commit()`

### Buffered Mode (Default)

By default, response helpers stage status, headers, and body in memory until the handler chain returns or `ctx:commit()` is called:

- **Status and headers:** `status(code)`, `status_code()`, `set(name, contents)`, `append(name, contents)`, `remove_header(name)`, `resp_header(name)`, `resp_headers()`, `vary(field, ...)`, `type(extension_or_mime, charset?)`, `location(target_url)`, `attachment(filename?)`.
- **Body helpers:** `send(data)`, `send_string(text)`, `html(markup)`, `send_status(code)`, `no_content()`, `json(payload, ...)`, `json_raw(encoded_json)`, `redirect(target_url, code?)`, `send_file(file_path, download?)`, `reset_body()`.
- **Explicit flush:** `ctx:commit()` runs `on_before_commit` hooks and flushes the buffered status, headers, and body to the wire immediately (or closes an already-started non-WebSocket stream). Calling `commit()` lets a handler perform post-response work without holding back the client response.

### Streaming Mode

Switch to streaming whenever a response must write incrementally without buffering the whole payload:

- `ctx:flush_headers()`: runs `on_before_commit`, commits headers to the wire, and flushes any already-buffered body bytes.
- `ctx:write_chunk(data)`: calls `flush_headers()` if not yet committed and writes one chunk.
- `ctx:send_stream(reader, content_length?)`: sets `Content-Length` if supplied (must be `>= 0`), commits headers, and streams every chunk from `reader:read`.

Once committed (`ctx:committed() == true`), status and headers can no longer be changed and buffered body replacement methods reject mutation.

### Abort and WebSocket Takeover

- `ctx:abort()` (`ctx:aborted()`): tears down the underlying transport immediately without finishing headers or draining unread request bytes.
- `ctx:upgrade_websocket(options?)`: runs `on_before_commit`, transfers staged headers onto the `101` handshake, returns an owned `websocket.Connection`, and closes it automatically when the handler chain ends. Requires a live server (`App:listen_test` or `App:listen`); raises `HttpError(501, ..., "upgrade_unavailable")` in `App:test`.
- `ctx:reject_upgrade(code)`: emits a bodyless `400..599` rejection and closes the connection.

## Lifecycle Observers (`on_before_commit` and `on_complete`)

`Context` provides two observer hooks so middleware can measure latency or emit completion logs without wrapping `ctx:next()` in a `catch` block:

- **`ctx:on_before_commit(hook)`:** Runs immediately before response headers are committed on buffered, error, streaming, and WebSocket `101` responses. Hooks may read `ctx:status_code()` and mutate response headers (used by `mk.middleware.responsetime`).
- **`ctx:on_complete(hook)`:** Runs in **LIFO order** after the response finishes or aborts—including after `HttpError` handling, unhandled exceptions, or Task cancellation. Exceptions thrown inside an `on_complete` hook are logged as `"on_complete_failed"` without replacing the request outcome, while `async.CancellationReason` propagates (used by completion `mk.middleware.logger`).

## `HttpError` and `ErrorHandler`

Handlers have signature `function (Context): ()` and signal expected HTTP errors by raising `mk.HttpError`:

```titan
local function find_user(ctx: mk.Context)
  local id = ctx:param_int("id")
  if id <= 0 then
    raise mk.HttpError(400, "invalid user id", "invalid_id")
  end
  -- ...
end
```

- `mk.HttpError(status, message?, code?, cause?)` normalizes any status outside `200..999` to `500` first and defaults `message` to `mk.status_message` of that normalized status (so an out-of-range status defaults to `"Internal Server Error"`).
- Outer middleware can `catch` and inspect or transform `HttpError` values freely.
- When an `HttpError` escapes the handler chain:
  - `ctx:last_error()` records it.
  - If the response is **uncommitted**, `mk` clears any partial buffered body and calls `Config.error_handler(ctx, err)` (default `mk.default_error_handler`, or `mk.json_error_handler` for `{"status":...,"message":...,"code":...}`). If `error_handler` itself raises an uncommitted `HttpError`, `mk` falls back to `mk.default_error_handler`.
  - If the response is **already committed** and still streaming (or upgraded to WebSocket), `mk` aborts the transport so truncated output is never framed as complete.
- Unexpected **non-`HttpError`** exceptions are not swallowed by `mk`: install `mk.middleware.recover` to convert them to `500` responses; otherwise live servers abort the transport and log `"http_request_failed"`.
- Cooperative `async.CancellationReason` is **never** swallowed by `mk` or built-in middleware.

## Testing: `App:test` vs. `App:listen_test`

`titan-mk` provides two complementary testing entry points:

| Capability | `App:test(req, config?)` | `App:listen_test(host?, listen_config?)` |
| --- | --- | --- |
| Transport | Strictly in-memory (no sockets, zero network overhead) | Real loopback HTTP/HTTPS server + owned `http.Client` |
| `parent` routes | Supported | Supported |
| `pool` / `session` worker routes | Rejected (raises; session-selector `HttpError` and `nil` fallback to `parent` still run) | Full multi-thread support |
| WebSocket upgrades | Raises `HttpError(501)` | Supported |
| Keep-alive / wire framing / TLS | Simulated single request | Real HTTP/1.1 wire behavior |
| Cleanup | Automatic | Call `defer ts:close()` |

### In-Memory Example (`App:test`)

```titan
local res = app:test(mk.TestRequest {
  method = "POST",
  target = "/items",
  headers = http.headers({ http.Header("Content-Type", "application/json") }),
  body = '{"title":"book","count":2}',
}, mk.TestConfig { timeout_ms = 2000 })

-- res.status, res:header("Content-Type"), res.body, res:json()
```

`TestConfig.timeout_ms` defaults to `1000` ms (`0` disables); `fail_on_timeout` defaults to `true` (when `false`, returns whatever was committed, or status `0` if uncommitted).

### Loopback Server Example (`App:listen_test`)

```titan
local ts = app:listen_test()
defer ts:close()

local res = ts:request("GET", "/hello/titan")
-- ts.host, ts.port, ts.base_url, res.status, res.body
```

`ts:close()` closes the test `http.Client`, runs `app:shutdown()`, and joins the server Task.
