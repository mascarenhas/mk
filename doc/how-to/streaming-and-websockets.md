# How to Stream Responses and Upgrade WebSockets

Flush buffered responses early, stream chunks and `io.Reader` sources, read
raw request bodies incrementally, and handle WebSocket upgrades and
rejections. See the [`mk` Module Reference](../reference/mk.md) for complete
`Context` method signatures and
[About the Request, Middleware, and Error Lifecycle](../explanation/request-lifecycle.md)
for the commit-boundary model.

## Flush Buffered Responses Early

Standard response builders—`ctx:send()`, `ctx:send_string()`, `ctx:html()`,
`ctx:json()`, and `ctx:json_raw()`—stage status, headers, and body bytes in
memory until the handler chain returns. Call `ctx:commit()` to flush the
staged response immediately while keeping the handler alive for post-commit
work:

```titan
local mk = import "mk"

app:post("/trigger", function (ctx: mk.Context)
  ctx:status(202):send_string("accepted")
  ctx:commit()
  -- Post-response cleanup runs after bytes have been flushed.
end)
```

`ctx:commit()` runs all `on_before_commit` hooks once and hands headers and
body to the transport. After commit, `ctx:committed()` returns `true` and
any attempt to call `ctx:status()`, `ctx:set()`, `ctx:send()`, or other
staging methods raises `"mk: response headers have already been committed"`.

### Serving single files with `ctx:send_file`

`ctx:send_file(path, download?)` is **not** buffered. It stats `path`, sets
`Content-Type` from the file extension (or `Content-Disposition: attachment`
when `download` is `true`), commits headers immediately, and streams the
file through `ctx:send_stream()`:

```titan
app:get("/export", function (ctx: mk.Context)
  ctx:set("Cache-Control", "no-store")
  ctx:send_file("/var/lib/app/daily-report.csv", true)
end)
```

Set all custom headers and status codes before calling `ctx:send_file()`.
Because `ctx:send_file()` uses `fs.stat` directly, it follows symlinks and
enforces **no directory confinement**; pass only trusted server-side paths.
For user-controlled paths under a public root, use
[`mk.middleware.static`](middleware-and-logging.md#serve-static-files-safely).

## Stream Chunks and Readers

### Incremental chunked responses (Server-Sent Events)

Call `ctx:flush_headers()` to commit headers in streaming mode without
closing the body, then write chunks with `ctx:write_chunk(data)`. Calling
`ctx:write_chunk()` on an uncommitted response flushes headers
automatically; any previously buffered body bytes ride along with the
headers:

```titan
local mk = import "mk"
local timer = import "timer"

app:get("/events", function (ctx: mk.Context)
  ctx:set("Content-Type", "text/event-stream")
  ctx:set("Cache-Control", "no-cache")
  ctx:flush_headers()

  for i = 1, 3 do
    ctx:write_chunk("data: tick " .. i .. "\n\n")
    timer.sleep(250)
  end
  ctx:commit()
end)
```

Calling `ctx:commit()` on an already-committed stream finishes the stream
cleanly; `mk` also finishes it automatically when the handler returns.
Calling `ctx:write_chunk()` after the stream has finished raises
`"mk: response is already complete"`.

### Streaming from an `io.Reader`

Pass any `io.Reader` to `ctx:send_stream(reader, content_length?)`:

```titan
local fs = import "fs"
local mk = import "mk"

app:get("/archive", function (ctx: mk.Context)
  local file = fs.open("/var/lib/app/bundle.tar", "rb")
  defer file:close()
  ctx:type("application/x-tar")
  ctx:send_stream(file)
end)
```

Omit `content_length` (or pass `nil`) to use chunked transfer encoding. Pass
a known non-negative byte count to emit an exact `Content-Length` header; a
negative length raises
`"mk: send_stream content_length must be non-negative"`.

### Aborting mid-stream failures

Once headers are committed, `mk` cannot replace the response with an error
body. If processing fails after streaming begins, call `ctx:abort()` to drop
the underlying connection so the client detects truncation rather than
receiving a valid EOF:

```titan
app:get("/stream", function (ctx: mk.Context)
  ctx:flush_headers()
  ctx:write_chunk("first\n")
  local ok = fetch_next_chunk()
  if not ok then
    ctx:abort()
    return
  end
  ctx:write_chunk("second\n")
end)
```

An `mk.HttpError` that escapes a handler after commit also aborts an
unfinished stream instead of invoking `Config.error_handler`.

## Read Raw Request Bodies

Choose between cached and incremental body reading depending on payload
size:

- `ctx:body()` reads all remaining body bytes once, caches the string on
  `Context`, and returns the cached string on subsequent calls.
- `ctx:read_body_chunk()` reads one chunk at a time and returns `nil` at
  EOF without buffering the full payload in memory.

```titan
app:post("/upload", function (ctx: mk.Context)
  local total = 0
  while true do
    local chunk? = ctx:read_body_chunk()
    if chunk == nil then
      break
    end
    total = total + #chunk
  end
  local summary: {string: value} = { ["bytes"] = total }
  ctx:json(summary)
end)
```

Both methods enforce `Config.body_limit` (default `4 MiB`). A declared
`Content-Length` above `body_limit` fails immediately before reading, and a
streamed body fails as soon as the running byte count exceeds `body_limit`.
Exceeding the limit raises a sticky
`mk.HttpError(413, "Content Too Large", "body_too_large")` and marks the
connection for close so `mk` skips draining the remaining body bytes.

On `Upgrade` offers and `CONNECT` requests, `ctx:body()` returns `""` and
`ctx:read_body_chunk()` returns `nil`. For typed JSON decoding instead of
raw bytes, see
[How to Define Routes, Bind JSON, and Return Errors](routes-and-json-apis.md#decode-json-request-bodies).

## Upgrade or Reject WebSockets

Upgrade an incoming HTTP/1.1 request to RFC 6455 WebSocket framing with
`ctx:upgrade_websocket(options?)`, which returns a `websocket.Connection`.
Stage any headers you want on the `101 Switching Protocols` response before
calling `upgrade_websocket()`; `mk` runs `on_before_commit` hooks and copies
buffered headers plus `Server` onto the `101` response:

```titan
local mk = import "mk"
local ws = import "websocket"

app:get("/ws", function (ctx: mk.Context)
  if not ctx:is_websocket() then
    raise mk.HttpError(426, "Upgrade Required")
  end

  ctx:set("X-Protocol-Version", "1")
  local conn = ctx:upgrade_websocket(ws.AcceptOptions {
    subprotocols = { "chat.v1" },
    allowed_origins = { "https://app.example" },
  })
  defer conn:close()

  while true do
    local kind?, data? = conn:read()
    if data == nil then
      break
    end
    conn:write(kind or ws.TEXT, "echo: " .. data)
  end
end)
```

Follow four rules in WebSocket handlers:

1. **Detect clean peer close:** `conn:read()` returns `(nil, nil)` when the
   peer sends a valid Close frame and reciprocal closing finishes. Exit the
   loop cleanly when `data == nil`.
2. **Initiate graceful server close:** Call
   `conn:shutdown(1000, "closing")` before returning when the server starts
   the close handshake. `mk` also closes the connection automatically when
   the handler chain returns, and `defer conn:close()` is idempotent.
3. **Inspect handshake rejections:** If the opening is malformed (`400`),
   the origin is denied (`403`), or the version is unsupported (`426`),
   `ctx:upgrade_websocket()` sends the HTTP rejection response, marks the
   response finished (not aborted), and raises
   `mk.HttpError(status, message, "websocket_handshake", failure)`.
4. **Test on a live server:** `ctx:upgrade_websocket()` requires a real
   socket (`App:listen` or `App:listen_test`). Under in-memory `App:test`,
   it raises `mk.HttpError(501, ..., "upgrade_unavailable")`, which
   `Config.error_handler` renders as a `501` response. See
   [How to Test Services and Measure Line Coverage](testing-and-coverage.md#test-workers-and-sockets-with-applisten_test).

To refuse an upgrade request before the WebSocket handshake (for example,
after an authorization check), call `ctx:reject_upgrade(status)` with a
status in `400`–`599`:

```titan
app:get("/ws-private", function (ctx: mk.Context)
  if ctx:bearer() == nil then
    ctx:reject_upgrade(403)
    return
  end
  local conn = ctx:upgrade_websocket()
  defer conn:close()
  while true do
    local _kind?, data? = conn:read()
    if data == nil then break end
    conn:write(ws.TEXT, data)
  end
end)
```

`ctx:reject_upgrade()` runs `on_before_commit`, sends a bodyless response
with `Content-Length: 0` and `Connection: close`, works in both live servers
and `App:test`, and marks the response cleanly finished rather than aborted.
Passing a status outside `400`–`599` raises a plain string error.
