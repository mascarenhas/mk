# `mk.log` Module Reference

Import with `local log = import "mk.log"`. Bounded, non-suspending structured JSON-line logger (`src/mk/log/log.titan`). Admission never yields; one owned writer Task delivers encoded lines to the sink in order.

See [Chapter 3: Middleware and Logging](../guide/middleware-and-logging.md#structured-json-line-logging-mklog) for usage patterns.

---

## Constants and Level Vocabulary

```text
const MAX_LINE_BYTES: integer = 16384
```

Log levels are plain strings (ordered by severity rank):

| Level | Rank |
| --- | ---: |
| `"error"` | 1 |
| `"warn"` | 2 |
| `"info"` | 3 (default) |
| `"debug"` | 4 |

---

## `Logger` and Module Functions

```text
record Logger
function Logger.new(level: string?, sink: (function (string): ())?,
                    capacity: integer?): Logger
function Logger:level(): string
function Logger:emit(level: string, event: string, fields: {string: value}?)
function Logger:error(event: string, fields: {string: value}?)
function Logger:warn(event: string, fields: {string: value}?)
function Logger:info(event: string, fields: {string: value}?)
function Logger:debug(event: string, fields: {string: value}?)
function Logger:accept(encoded: string)
function Logger:close()

function resolve_level(level: string?, allow_warn: boolean?, env_name: string?): string
function format_line(level: string, event: string, fields: {string: value}?): string
function emit(logger: Logger?, level: string, event: string, fields: {string: value}?)
function forward(level: string, lines: thread.Sender<|string|>?): Logger?
function fatal(event: string, reason: string, fields: {string: value}?)
```

### Semantics

- **`Logger.new(level?, sink?, capacity?)`:** Defaults to `level = "info"`, `sink = os.stderr:write`, and `capacity = 1024`. Raises `"log queue capacity must be positive"` if `capacity < 1` and raises via `resolve_level` on an unknown level. Spawns one owned writer Task draining an `async.BufferedSubscription<|string, nil|>`.
- **`Logger:level()`:** Returns the logger's configured minimum level string (`"error"`, `"warn"`, `"info"`, or `"debug"`).
- **`Logger:emit(level, event, fields?)`** (and shorthands **`error`**, **`warn`**, **`info`**, **`debug`**): Non-suspending admission. No-ops if closed, failed, or `rank(level) > minimum`. Increments the drop counter without raising if `level` is unknown, the queue is full (`queued >= capacity`), `format_line` fails (invalid UTF-8, cycles, unsupported values, or `> MAX_LINE_BYTES`), or publication fails.
- **`Logger:accept(encoded)`:** Admits an already-encoded JSON line (such as one forwarded from a worker thread) under the same bounded queue, dropping if `#encoded > MAX_LINE_BYTES + 1` or `queued >= capacity`.
- **Drop reporting and sink failure:** When drops accumulate (from admission drops or non-blocking sink refusals), the writer Task emits `{"event":"log_dropped","level":"error","count":N,"timestamp":"..."}` around its next delivered line or at `Logger:close()`. If the destination sink raises an unexpected error, the writer Task marks the logger failed and discards unread lines rather than crashing the application (`async.CancellationReason` still propagates).
- **`Logger:close()`:** Idempotently closes admission and waits (even under Task cancellation, via `async.await_cleanup`) until the writer Task has delivered or dropped every admitted line.
- **`resolve_level(level?, allow_warn?, env_name?)`:** Defaults `nil` to `"info"`. When `allow_warn == false`, rejects `"warn"` and requires `"error"`, `"info"`, or `"debug"`; otherwise accepts all four levels. Raises using `env_name` (default `"log level"`).
- **`format_line(level, event, fields?)`:** Formats one UTF-8 JSON object terminated by `\n` (enforcing `json.EncodeOption.max_bytes(16384)`). Always writes `"timestamp"` (`os.date("!%Y-%m-%dT%H:%M:%SZ")`), `"level"`, and `"event"` (overwriting any colliding keys in `fields`).
- **`emit(logger?, level, event, fields?)`:** Convenience helper that calls `logger:emit(...)` when `logger ~= nil`.
- **`forward(level, lines?)`:** Returns `nil` when `lines == nil`; otherwise creates a bounded (`1024`) `Logger` whose sink is non-blocking `lines:try_send`. Borrows `lines` without closing it. Used automatically by `mk.App` to forward worker-thread logs to `Config.logger`.
- **`fatal(event, reason, fields?)`:** Writes one `"error"` JSON line with `"reason"` directly to `os.stderr` for startup diagnostics before a `Logger` exists; swallows non-cancellation I/O failures.
