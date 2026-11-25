# About PEG Routing and Route Constraints

URL routers in web frameworks face a recurring tension between expressive route syntax and predictable latency under hostile input. `mk.router` resolves that tension by pairing Parsing Expression Grammars (`titan.peg`) with a linear-per-operation feasibility evaluator, rejecting inline type constraints at registration time, and freezing the compiled route table before the server accepts a socket.

## Lineage from Orbit and Kepler Project's `mk`

The routing design in `titan-mk` descends directly from two earlier Lua web libraries by the same author: Orbit's PEG route parser and Kepler Project's `mk`. Both projects replaced ad-hoc regular expressions with Parsing Expression Grammars, using PEGs not only to match incoming paths but also to parse the route pattern language itself.

Compiling both stages onto Titan's native `titan.peg` engine carries that idea into a statically typed, ahead-of-time-compiled runtime. A precompiled PEG grammar validates every pattern when a route is registered, producing exact line, column, and byte-offset diagnostics (`RouteError`) instead of deferring syntax bugs until a request arrives.

## Two-Tier Compilation and Linear Worst-Case Matching

Naive regex routers—and naive backtracking PEG matchers—risk exponential slowdown when a pattern mixes multiple wildcards, optional segments, or in-segment delimiters. An attacker sending a crafted path with repeated partial matches can pin an event loop inside the router before any handler runs.

`mk.router` avoids backtracking blowups by splitting compiled patterns into two execution tiers chosen once at registration time:

```text
  route pattern
       |
       v
  PEG pattern parser ---> RouteError (syntax or limit violation)
       |
       v
  +-------------------------------+-------------------------------+
  | Tier 1: Deterministic         | Tier 2: General               |
  | literals, required :name,     | :name?, mixed segments,       |
  | <= 1 terminal /* or /+        | multiple/non-terminal */+,    |
  | (non-prefix mode only)        | any wildcard in prefix mode   |
  +-------------------------------+-------------------------------+
       |                                        |
       v                                        v
  Single-pass peg.Pattern             Bottom-up feasibility table
  (no scratch table)                  over PEG-atomized path
                                      O((M + L) · A) worst case
```

Tier 1 handles the common case. When a pattern consists of literal segments, whole-segment required parameters, and at most one terminal whole-segment `*` or `+` in exact-match mode, `compile_pattern` emits a single `peg.Pattern`. Matching runs in one forward pass through LPegLabel's compiled VM with no dynamic-programming scratch buffer.

Tier 2 handles every remaining valid pattern: optional segments (`:name?`), adjacent or delimited parameters inside one segment (`/files/:name.:ext`), multiple or non-terminal wildcards, and prefix-mode middleware patterns that contain wildcards (since a wildcard in prefix mode is never terminal). Instead of letting a PEG backtrack across ambiguous splits, `compile_pattern` lowers the pattern into a flat array of `M` operations (`PlanOp`) and evaluates them in three deterministic steps over the incoming path:

1. **Atomization:** A precompiled PEG splits the raw path into `A` atoms, where each atom is either one raw byte or one valid `%XX` escape.
2. **Bottom-up feasibility:** A bitset table packed 64 atoms per integer word is filled from the last operation (`M`) back to operation `1`. Before each row, a single right-to-left sweep records the rightmost feasible end atom overall and within the current segment. Each literal operation scans the path once with a precompiled PEG to mark every matching atom start. Every cell decision then finishes in constant time.
3. **Greedy forward extraction:** If cell `(1, 1)` is feasible, one forward pass from operation `1` to `M` picks the greedy left-to-right end atom at each step and slices out the captured values without ever backtracking.

Total matching work stays bounded by `O((M + L) · A)` in the worst case, where `M` is the operation count, `L` is total decoded literal length, and `A` is the atom count. Hard compile-time and target limits (`MAX_PATTERN_BYTES`, `MAX_PATTERN_PARTS`, `MAX_WILDCARDS`, `MAX_TARGET_BYTES`, and `MAX_QUERY_FIELDS`) bound `M`, `L`, and `A` upfront so neither registration nor matching can allocate unbounded memory.

## Atomic Percent Escapes and Registration Freeze

Web frameworks that percent-decode the full request path before splitting on `/` suffer from segment-smuggling bugs: an encoded slash (`%2F`) inside a single ID parameter splits into two segments and can bypass prefix checks or reach an unintended route.

`mk.router` prevents segment smuggling by matching on raw path atoms. Because `%2F` is tokenized as one non-slash atom, it stays inside a single `:name` segment during matching and only becomes `/` after the segment's boundaries are fixed and `unescape_path` decodes that captured value. Conversely, literal `/`, `%`, and control bytes embedded in a route pattern match only their percent-escaped wire forms, keeping raw structural delimiters unambiguous.

Freezing route registration on the first `App:start` or `App:test` complements this compile-time discipline. Once frozen, the dispatch table is immutable across the parent event loop and every worker thread bootstrap snapshot. Requests never contend on a route-table lock, and a live server cannot observe half-updated routing state mid-flight.

## Why Inline Routing Constraints Are Rejected

Many HTTP routers support inline type or regex predicates such as `/users/:id<int>` or `/posts/:slug<[a-z-]+>`. `mk.router` intentionally detects `<` after a parameter name and fails immediately at registration with `routing_constraints_unsupported` rather than supporting inline constraints.

Three architectural goals drive that decision:

- **Separating URL ownership from input validation:** Routing decides which handler owns a URL shape. When `/users/abc` fails an inline `<int>` constraint, a router falls through to `404 Not Found`, misleading the client into thinking the endpoint does not exist. Parsing the parameter inside the handler with `ctx:param_int("id")` returns `400 Bad Request` (`"invalid_parameter"`), keeps error formatting consistent with `Config.error_handler`, and scales naturally to domain checks such as range bounds or enum sets.
- **Preserving guaranteed linear matching:** Arbitrary inline regexes or user predicates break the atom-level feasibility table. Supporting them would either reintroduce catastrophic backtracking into route classification or run user-supplied predicates repeatedly before middleware and timeouts have started.
- **Keeping reverse URL building and `405` discovery unambiguous:** When two routes share the same segment structure and differ only by value predicates, route precedence, `App:route_url`, and `405 Allow` generation become order- and value-dependent. Rejecting inline constraints keeps path structure the sole determinant of route identity.

## Why `auto_head` Defers and `405 Allow` Preserves Registration Order

HTTP clients, proxies, and health probes routinely send `HEAD` requests against `GET` endpoints. Enabling `Config.auto_head` by default lets every `GET` route answer `HEAD` automatically (omitting body bytes on the wire while keeping headers and `Content-Length`) without duplicating route declarations.

Fallback activates only when no explicit `HEAD` route or `all` route matches the path. That precedence lets an application register a dedicated `HEAD` handler—for instance, to return metadata without computing an expensive response body—without disabling `auto_head` globally.

When a path matches one or more registered routes but none accepts the incoming method (and no endpoint ran), `mk` builds the `405 Method Not Allowed` response's `Allow` header by collecting accepted methods in first-occurrence registration order, excluding wildcard `*` and inserting `HEAD` directly after `GET` when `auto_head` is active. Registration order avoids non-deterministic map iteration, keeps wire output stable across runs and tests, and mirrors the exact order in which the service declares its endpoints.

For route syntax recipes and parameter parsing helpers, see [How to Define Routes, Bind JSON, and Return Errors](../how-to/routes-and-json-apis.md). For exact grammar rules, limits, and `RouteError` codes, see the [`mk.router` Module Reference](../reference/mk-router.md).
