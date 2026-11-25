# `mk.log` Module Reference

Import with `local log = import "mk.log"` (`src/mk/log/log.titan`).
`mk.log` provides a bounded, non-suspending structured JSON-line logger.
Admission never yields; one owned writer Task delivers encoded lines to the
sink in admission order.

See [How to Compose Middleware and Structured Logging](../how-to/middleware-and-logging.md#configure-structured-logging)
for setup recipes and
[About the Request, Middleware, and Error Lifecycle](../explanation/request-lifecycle.md)
for the non-suspending queue rationale.

## Constants and Level Vocabulary

```titan
const MAX_LINE_BYTES: integer = 16384
```

Log levels are plain strings ordered by severity rank:

| Level | Rank | Default |
| --- | ---: | --- |
| `"error"` | 1 | — |
| `"warn"` | 2 | — |
| `"info"` | 3 | Yes |
| `"debug"` | 4 | — |

## `Logger` and Module Functions

```titan
record Logger
  -- opaque; construct with Logger.new(...) or forward(...)
end

function Logger.new(
  level: string?,
  sink: (function (string): ())?,
  capacity: integer?
): Logger

function Logger:level(): string
function Logger:emit(
  level: string, event: string, fields: {string: value}?
)
function Logger:error(event: string, fields: {string: value}?)
function Logger:warn(event: string, fields: {string: value}?)
function Logger:info(event: string, fields: {string: value}?)
function Logger:debug(event: string, fields: {string: value}?)
function Logger:accept(encoded: string)
function Logger:close()

function resolve_level(
  level: string?, allow_warn: boolean?, env_name: string?
): string
function format_line(
  level: string, event: string, fields: {string: value}?
): string
function emit(
  logger: Logger?, level: string,
  event: string, fields: {string: value}?
)
function forward(
  level: string, lines: thread.Sender<|string|>?
): Logger?
function fatal(
  event: string, reason: string, fields: {string: value}?
)
```

### Semantics

- **`Logger.new(level?, sink?, capacity?)`:** Defaults to `level = "info"`,
  `sink = os.stderr:write`, and `capacity = 1024`. Raises
  `"log queue capacity must be positive"` when `capacity < 1`, and raises
  via `resolve_level` on an unknown level. Starts one owned writer Task
  immediately draining an `async.BufferedSubscription<|string, nil|>`. A
  user-supplied sink counts every non-raising call as accepted.
- **`Logger:level()`:** Returns the configured minimum level string
  (`"error"`, `"warn"`, `"info"`, or `"debug"`).
- **`Logger:emit(level, event, fields?)`** and shorthands **`error`**,
  **`warn`**, **`info`**, **`debug`**: Non-suspending, non-raising
  admission. Silent no-op when the logger is closed, failed, or
  `rank(level) > minimum`. Increments the drop counter without raising when
  `level` is unknown, the queue is full (`queued >= capacity`),
  `format_line` fails (invalid UTF-8, cycles, unsupported values, or an
  encoded JSON record exceeding `MAX_LINE_BYTES`), or publication is
  refused.
- **`Logger:accept(encoded)`:** Admits a pre-encoded JSON line (such as one
  forwarded from a worker thread) into the same bounded queue. Drops the
  line and increments the drop counter when `#encoded > MAX_LINE_BYTES + 1`
  or `queued >= capacity`.
- **Drop reporting and sink failure:** Before and after each delivered
  line, and during `Logger:close()`, the writer Task emits pending drops
  via `format_line("error", "log_dropped", { ["count"] = N })`. The emitted
  JSON object carries sorted keys `count`, `event`, `level`, and
  `timestamp`. If a non-blocking sink refuses the drop report, the count is
  retained for a later attempt. If the sink raises a non-cancellation
  error, the logger enters the failed state, discards unread lines, and
  suppresses the error; `async.CancellationReason` still propagates.
- **`Logger:close()`:** Idempotent. Closes admission and waits—even under
  Task cancellation and concurrently with other closers—until the writer
  Task has delivered or dropped every admitted line. `mk.App` never closes
  `Config.logger`; the application owns calling `close()`.
- **`resolve_level(level?, allow_warn?, env_name?)`:** Maps `nil` to
  `"info"`. When `allow_warn == false`, rejects `"warn"` and raises
  `"<name> must be error, info, or debug"`. Otherwise accepts all four
  levels and raises `"<name> must be error, warn, info, or debug"`, where
  `<name>` is `env_name` or `"log level"`.
- **`format_line(level, event, fields?)`:** Encodes one UTF-8 JSON object
  terminated by `\n`, enforcing `json.EncodeOption.max_bytes(16384)`.
  Always writes `"timestamp"` (`os.date("!%Y-%m-%dT%H:%M:%SZ")`),
  `"level"`, and `"event"`, overwriting any colliding keys in `fields`.
  JSON object keys are emitted in sorted order.
- **`emit(logger?, level, event, fields?)`:** Calls
  `logger:emit(level, event, fields)` when `logger ~= nil`; no-op when
  `logger == nil`.
- **`forward(level, lines?)`:** Returns `nil` when `lines == nil`.
  Otherwise returns a `1024`-capacity `Logger` whose sink is non-blocking
  `lines:try_send` (a full channel counts as dropped). Borrows `lines`
  without closing it. `mk.App` uses `forward` automatically to send
  worker-thread log lines to `Config.logger`.
- **`fatal(event, reason, fields?)`:** Writes one `"error"` JSON line with
  `"reason"` added directly to `os.stderr` for startup diagnostics before a
  `Logger` exists. Swallows non-cancellation I/O failures.
