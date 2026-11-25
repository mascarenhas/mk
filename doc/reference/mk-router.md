# `mk.router` Module Reference

Import with `local router = import "mk.router"`. `mk.router` is a pure, network-free routing module backed by `titan.peg` (`src/mk/router/router.titan`, importing only `peg` and `string`). It provides route-pattern parsing and compilation, request-target splitting, URI percent coding, path joining, and `Allow` header formatting.

For usage recipes, see [How to Define Routes, Bind JSON, and Return Errors](../how-to/routes-and-json-apis.md). For design rationale, see [About PEG Routing and Route Constraints](../explanation/peg-routing.md).

## Constants

```titan
const MAX_TARGET_BYTES: integer = 16384
const MAX_QUERY_FIELDS: integer = 256
const MAX_PATTERN_BYTES: integer = 1024
const MAX_PATTERN_PARTS: integer = 64
const MAX_WILDCARDS: integer = 16
```

## Types

```titan
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
  const case_sensitive: boolean?  -- default false
  const strict_routing: boolean?  -- default false
  const unescape_path: boolean?   -- default true
  const prefix: boolean?          -- default false
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

`CompiledPattern` carries private matcher fields and is constructed only through `compile_pattern`.

## Functions and Methods

```titan
function parse_pattern(
  pattern: string
): (const {RouteSegment}?, RouteError?)
function compile_pattern(
  pattern: string, options: PatternOptions?
): CompiledPattern
function CompiledPattern:match(path: string): MatchResult?
function CompiledPattern:build(params: {string: string}?): string

function parse_target(
  target: string, max_bytes: integer?, max_query_fields: integer?
): Target
function percent_decode(
  subject: string, plus_as_space: boolean?
): string
function percent_encode_segment(subject: string): string
function join_paths(prefix: string, child: string): string
function allow_header(methods: const? {string}): string
```

Only `compile_pattern` raises a `RouteError` value (and `parse_pattern` returns it as data). `CompiledPattern:build`, `parse_target`, and `percent_decode` raise plain strings.

### `parse_pattern` and `compile_pattern`

- **`parse_pattern(pattern)`:** Validates and parses `pattern` with a precompiled `titan.peg` grammar, returning `(segments, nil)` on success or `(nil, RouteError)` on failure. Never raises for pattern syntax or limit errors.
- **`compile_pattern(pattern, options?)`:** Parses `pattern` (raising the `RouteError` value on failure) and builds a `CompiledPattern`:
  - **Fast single-pass PEG matcher:** Selected for the root prefix `/` and for patterns containing only literal segments, whole-segment required `:name` parameters, and—in non-prefix mode only—at most one terminal whole-segment `*` or `+`.
  - **General feasibility evaluator:** Selected for optional parameters (`:name?`), mixed multi-token segments, non-terminal or multiple wildcards, and any wildcard in prefix mode. Runs a bottom-up feasibility table over PEG-atomized paths in `O((M + L) · A)` worst-case time (`M` operations, `L` decoded literal bytes, `A` path atoms) with greedy left-to-right capture extraction.

### `CompiledPattern:match` and `CompiledPattern:build`

- **`CompiledPattern:match(path)`:** Returns `MatchResult(params, next_pos)` or `nil`.
  - Paths are matched as sequences of atoms (one raw byte or one valid `%XX` escape), so `%2F` never splits a segment.
  - A route literal byte matches either its raw byte or its percent-escaped form; literal `/`, `%`, and control bytes in a route match only their escaped form. Literals are ASCII case-insensitive unless `case_sensitive` is `true`.
  - Captured parameter and wildcard values are percent-decoded when `unescape_path` is `true`.
  - A whole-segment `:name?` makes the segment and its leading `/` optional. A whole-segment `/*` makes the segment and its leading `/` optional (`/assets/*` matches `/assets`, `/assets/`, and `/assets/a/b` with `*` equal to `""`, `""`, and `"a/b"`). A whole-segment `/+` requires at least one atom. In-segment `*` and `+` match zero-or-more and one-or-more atoms, may cross `/`, and are greedy left-to-right.
  - Wildcards populate `"*1"`, `"*2"`, ... (with `"*"` aliasing `"*1"`) and `"+1"`, `"+2"`, ... (with `"+"` aliasing `"+1"`).
  - Trailing `/` is insignificant unless `strict_routing` is `true` (and is always insignificant in prefix mode). Prefix mode matches at segment boundaries and sets `next_pos` to the byte index after the consumed prefix; root prefix `/` matches every `/`-prefixed path.
- **`CompiledPattern:build(params?)`:** Substitutes parameter and wildcard values into the pattern:
  - Required and optional `:name` values are encoded with `percent_encode_segment` (`/` becomes `%2F`, space becomes `%20`).
  - Wildcard values (`*` or `*1`, `*2`, ...; `+` or `+1`, `+2`, ...) preserve `/` separators.
  - Absent or empty whole-segment `:name?` and whole-segment `*` segments are omitted along with their leading `/`. An empty result becomes `"/"`.
  - Missing or empty required parameters raise the plain string `"route parameter '<name>' is required"`, and missing or empty `+` wildcards raise `"route parameter '+N' is required"`.

### Target parsing and helpers

- **`parse_target(target, max_bytes?, max_query_fields?)`:** Splits an origin-form HTTP request target into the raw `path`, `raw_query`, percent-decoded `segments`, first-value `query`, and multi-value `query_values`. Defaults to `MAX_TARGET_BYTES` (`16384`) and `MAX_QUERY_FIELDS` (`256`, counting `&`-separated fields before skipping empties). Query keys and values decode `+` as space; empty query fields are skipped. Raises plain strings:
  - `"request target is too long"`
  - `"request target must begin with /"`
  - `"request target cannot contain a fragment"`
  - `"too many query parameters"`
  - plus any error from `percent_decode`.
- **`percent_decode(subject, plus_as_space?)`:** Decodes `%XX` once (plus `+` to space when `plus_as_space` is `true`) and returns `subject` unchanged if no decoding is needed. Raises plain strings:
  - `"incomplete percent escape"`
  - `"invalid percent escape"`
  - `"NUL is not allowed in a request target"`
  - `"control character in request target"` (raw byte `< 32` or `127`).
- **`percent_encode_segment(subject)`:** Preserves RFC 3986 `pchar` bytes (unreserved, sub-delims, `:`, `@`) and encodes all other bytes—including `/`—with uppercase hex.
- **`join_paths(prefix, child)`:** Returns `prefix` (or `"/"` if both are empty) when `child` is empty; otherwise strips trailing `/` from `prefix` and joins with a single `/`.
- **`allow_header(methods)`:** Joins distinct non-empty method names with `", "` in first-occurrence order.

## Route Pattern Grammar and `RouteError` Codes

Patterns must start with `/` and consist of `/`-separated segments containing literals, parameters (`:name` or `:name?`, where `name` matches `[A-Za-z_][A-Za-z0-9_]*`), wildcards (`*` and `+`), backslash escapes (`\:`, `\?`, `\*`, `\+`, `\\`, `\<`), a literal `:` immediately preceding `:name` (as in `"/color::color"`), and validated `%XX` escapes (`%00` forbidden). Plain literal bytes exclude `%`, `/`, `*`, `+`, `?`, `#`, `:`, `\`, `<`, and control bytes. Inline constraints such as `:id<int>` are rejected.

Limits enforced at parse time: pattern length `<= MAX_PATTERN_BYTES` (`1024`), segment count `<= MAX_PATTERN_PARTS` (`64`), token count `<= MAX_PATTERN_PARTS` (`64`), and combined `*` plus `+` count `<= MAX_WILDCARDS` (`16`).

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
