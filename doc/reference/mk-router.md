# `mk.router` Module Reference

Import with `local router = import "mk.router"`. Pure, network-free routing module backed by `titan.peg`: route-pattern parsing and compilation, request-target splitting, URI percent coding, path joining, and `Allow` header formatting.

See [Chapter 2: Routing and Handlers](../guide/routing-and-handlers.md) for usage patterns.

---

## Constants

```text
const MAX_TARGET_BYTES: integer = 16384
const MAX_QUERY_FIELDS: integer = 256
const MAX_PATTERN_BYTES: integer = 1024
const MAX_PATTERN_PARTS: integer = 64
const MAX_WILDCARDS: integer = 16
```

---

## Types

```text
record RouteError
  const code: string
  const message: string
  const position: integer
  const line: integer
  const column: integer
end

union SegmentToken
  literal(text: string, position: integer)
  param(name: string, optional: boolean, position: integer)
  wildcard(index: integer, position: integer)
  plus(index: integer, position: integer)
end

record RouteSegment
  const tokens: const {SegmentToken}
  const position: integer
end

record PatternOptions
  const case_sensitive: boolean?    -- default false
  const strict_routing: boolean?    -- default false
  const unescape_path: boolean?     -- default true
  const prefix: boolean?            -- default false
end

record Target
  const path: string
  const raw_query: string
  const segments: const {string}
  const query: {string: string}
  const query_values: {string: {string}}
end

record CompiledPattern
  const pattern: string
  const prefix_mode: boolean
  const segments: const {RouteSegment}
  const param_names: const {string}
end

record MatchResult
  const params: {string: string}
  const next_pos: integer
end
```

---

## Functions and Methods

```text
function parse_pattern(pattern: string): (const {RouteSegment}?, RouteError?)
function compile_pattern(pattern: string, options: PatternOptions?): CompiledPattern
function CompiledPattern:match(path: string): MatchResult?
function CompiledPattern:build(params: {string: string}?): string

function parse_target(target: string, max_bytes: integer?,
                      max_query_fields: integer?): Target
function percent_decode(subject: string, plus_as_space: boolean?): string
function percent_encode_segment(subject: string): string
function join_paths(prefix: string, child: string): string
function allow_header(methods: const? {string}): string
```

### `parse_pattern` and `compile_pattern`

- **`parse_pattern(pattern)`** validates and parses a route pattern with a precompiled `titan.peg` grammar, returning `(segments, nil)` on success or `(nil, RouteError)` on failure.
- **`compile_pattern(pattern, options?)`** parses `pattern` (raising `RouteError` on syntax or limit errors) and builds a `CompiledPattern`:
  - Deterministic patterns (literal segments, whole-segment required `:name` parameters, and at most one terminal `*` or `+`) compile to a single-pass `peg.Pattern` matcher.
  - General patterns (`:name?`, multiple or non-terminal wildcards, adjacent parameters, in-segment delimiters) run a bottom-up feasibility table over PEG-atomized paths in $O((M + L) \cdot A)$ worst-case time.

### Route Pattern Grammar and `RouteError` Codes

Patterns must begin with `/`. Tokens within `/`-separated segments are literals, `:name` / `:name?` (`[A-Za-z_][A-Za-z0-9_]*`), `*` (0+ atoms, keys `"*1"`, `"*2"`, ... with `"*"` aliasing `"*1"`), `+` (1+ atoms, keys `"+1"`, `"+2"`, ... with `"+"` aliasing `"+1"`), backslash escapes (`\:`, `\?`, `\*`, `\+`, `\\`, `\<`), literal `:` before `:name`, and validated `%XX` escapes (`%00` forbidden). Inline constraints (`:id<int>`) are rejected.

| `RouteError.code` | Message |
| --- | --- |
| `expected_slash` | `"route pattern must begin with /"` |
| `expected_parameter_name` | `"route parameter needs an ASCII identifier"` |
| `routing_constraints_unsupported` | `"routing constraints are not supported"` |
| `query_or_fragment` | `"route pattern cannot contain a query or fragment"` |
| `percent_escape` | `"route literal contains an invalid percent escape"` |
| `nul_escape` | `"route literal cannot contain an encoded NUL"` |
| `trailing_escape` | `"route pattern cannot end with a backslash escape"` |
| `invalid_escape` | `"route pattern contains an unsupported backslash escape"` |
| `control_character` | `"route pattern cannot contain control characters"` |
| `duplicate_parameter` | `"route parameter names must be unique"` |
| `route_limit` | `"route pattern exceeds its size, part, or wildcard limit"` |
| `trailing_input` | `"unexpected byte in route pattern"` |

### `CompiledPattern:match` and `CompiledPattern:build`

- **`CompiledPattern:match(path)`:** Returns `MatchResult(params, next_pos)` or `nil`. `%XX` escapes are matched atomically (`%2F` stays inside a segment).
- **`CompiledPattern:build(params?)`:** Substitutes parameter and wildcard values into the pattern. Encodes segment parameters with `percent_encode_segment`, preserves `/` in wildcard values (`*`/`*1`, `+`/`+1`), omits absent/empty whole-segment `:name?` and `*` segments, and raises if a required `:name` or `+` parameter is missing or empty.

### Target Parsing and Helpers

- **`parse_target(target, max_bytes?, max_query_fields?)`:** Splits a raw HTTP origin-form request target into path, raw query, segments, first-value query map, and multi-value query map, enforcing `MAX_TARGET_BYTES` (`16384`) and `MAX_QUERY_FIELDS` (`256`) by default.
- **`percent_decode(subject, plus_as_space?)`:** Decodes `%XX` once per component (plus `+` -> space when `plus_as_space == true`), raising on incomplete/invalid escapes, `%00`, or control bytes (`< 32` or `127`).
- **`percent_encode_segment(subject)`:** Percent-encodes bytes outside RFC 3986 `pchar` (including `/`).
- **`join_paths(prefix, child)`:** Joins a group or mount prefix with a child path without doubling `/`.
- **`allow_header(methods)`:** Joins distinct non-empty method names with `", "` in first-occurrence order.
