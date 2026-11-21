# Routing

`titan-mk` parses and compiles route patterns with `mk.router`, a pure, network-free module backed by `titan.peg`. All routes are declared before `App:start()`, `App:listen()`, or `App:test()` freezes the routing table.

## Route Pattern Grammar

Every route pattern must begin with `/`. Patterns are parsed by a precompiled `titan.peg` grammar (`router.parse_pattern` / `router.compile_pattern`) subject to hard bounds (`MAX_PATTERN_BYTES = 1024`, `MAX_PATTERN_PARTS = 64`, `MAX_WILDCARDS = 16`).

### Supported Tokens

| Syntax | Meaning | Example |
| --- | --- | --- |
| Literal text | Exact path bytes (with optional case-insensitive matching) | `/api/v1/users` |
| `:name` | Required named parameter matching non-slash atoms (`[A-Za-z_][A-Za-z0-9_]*`) | `/users/:id` |
| `:name?` | Optional named parameter (whole-segment `/:name?` makes the leading `/` optional too) | `/posts/:year/:month?` |
| `*` | Greedy wildcard matching **zero or more** path atoms (including `/`) | `/assets/*` |
| `+` | Greedy wildcard matching **one or more** path atoms (including `/`) | `/files/+` |
| `\:`, `\?`, `\*`, `\+`, `\\`, `\<` | Backslash-escaped literal metacharacters | `/items/\:special` |
| `::name` | Literal `:` immediately before a named parameter | `/shop/color::color` |
| `%XX` | Validated percent-escaped literal byte (kept atomic; `%00` rejected) | `/tag/%2F` |

Parameters may appear inside a segment alongside literal delimiters (for example `/species/:genus.:species`) or adjacent to one another (`/:sign:value`). Wildcard captures are stored under indexed keys `"*1"`, `"*2"`, ... and `"+1"`, `"+2"`, ..., with `"*"` aliasing `"*1"` and `"+"` aliasing `"+1"`.

### Routing Constraints Are Rejected

GoFiber-style inline type constraints (`:id<int>`, `:slug<regex(...)>`) are **intentionally unsupported**. A `<` immediately following `:name` or unescaped anywhere in a route segment fails pattern compilation immediately with a `router.RouteError` whose `code` is `"routing_constraints_unsupported"` (`"routing constraints are not supported"`). Parse and validate typed parameters in the handler using `ctx:param_int(...)` or explicit checks instead.

### `RouteError` Codes

Malformed patterns fail at registration time (`router.parse_pattern` returns `nil, RouteError`; `router.compile_pattern` and `App` registration methods raise the `RouteError`):

| Code | Cause |
| --- | --- |
| `expected_slash` | Pattern does not start with `/`. |
| `expected_parameter_name` | `:` not followed by `[A-Za-z_][A-Za-z0-9_]*`. |
| `routing_constraints_unsupported` | Unescaped `<` or `:name<...>` constraint syntax. |
| `query_or_fragment` | Unescaped `?` (outside `:name?`) or `#`. |
| `percent_escape` | Incomplete or non-hex `%XX` escape in a literal. |
| `nul_escape` | `%00` encoded NUL byte in a literal. |
| `trailing_escape` | Pattern ends with a bare `\`. |
| `invalid_escape` | Backslash before a byte other than `:`, `?`, `*`, `+`, `\`, or `<`. |
| `control_character` | Control byte (`0x00..0x1F` or `0x7F`) in pattern. |
| `duplicate_parameter` | Same `:name` declared more than once in one pattern. |
| `route_limit` | Exceeds `MAX_PATTERN_BYTES` (1024), `MAX_PATTERN_PARTS` (64), or `MAX_WILDCARDS` (16). |
| `trailing_input` | Unexpected trailing byte in pattern. |

## Matching Semantics and Complexity

Request targets are parsed by `router.parse_target` (`MAX_TARGET_BYTES = 16384`, `MAX_QUERY_FIELDS = 256`). `%XX` escapes are treated as atomic units during path matching so `%2F` stays inside a single segment and never acts as a raw `/` separator.

`compile_pattern(pattern, PatternOptions?)` selects between two matchers:

1. **Fast single-pass PEG matcher:** Deterministic routes consisting of literal segments, whole-segment required `:name` parameters, and at most one terminal `*` or `+` compile to a single flat `titan.peg` `Pattern` that executes in one linear pass in LPeg's C VM.
2. **General $O((M + L) \cdot A)$ evaluator:** Routes with optional parameters (`:name?`), multiple or non-terminal wildcards, adjacent parameters, or in-segment delimiters tokenize the path with a precompiled `titan.peg` atomizer and run a bottom-up feasibility table with precomputed rightmost-feasible suffix lookups, guaranteeing greedy left-to-right semantics in $O((M + L) \cdot A)$ worst-case time without exponential backtracking.

Matching honors `mk.Config` / `router.PatternOptions`:

- `case_sensitive` (default `false`): case-insensitive ASCII literal matching when `false`.
- `strict_routing` (default `false`): treats `/users` and `/users/` as equivalent when `false`, distinct when `true`.
- `unescape_path` (default `true`): percent-decodes `RequestMeta.path` and captured parameter/wildcard values once per component.
- `prefix` (used internally for `use` / `use_path` middleware): matches at segment boundaries (`/` matches everything; `/api` matches `/api` and `/api/...` but not `/apiv2`).

## Registering Routes, Groups, and Chains

### `App` Route and Middleware Methods

`App` supports every standard HTTP method plus catch-all and multi-method registration, accepting one or more `mk.Handler` functions per route:

```titan
app:use(mw1, mw2)                         -- global middleware ("/")
app:use_path("/api", api_mw)              -- prefix middleware

app:get("/items", list_items):name("items.list")
app:post("/items", require_auth, create_item):name("items.create")
app:add({"PUT", "PATCH"}, "/items/:id", update_item)
app:all("/debug/*", debug_handler)
```

Available method helpers on `App`, `Group`, and `RouteChain`: `get`, `head`, `post`, `put`, `delete`, `connect`, `options`, `trace`, `patch`, `all`, and `add(methods, ...)`.

Endpoint registration on `App` and `Group` returns a `RouteHandle` (or `{RouteHandle}` for `add`):

- `handle:name(route_name)`: assigns the route's name (prefixed by its group's `name` prefix) and notifies `Hooks:on_name` observers.
- `handle:workers(mode)`: assigns a specific `mk.WorkerMode` to that route before `start`/`test`.
- `handle:info()`: returns a `RouteInfo` snapshot (`method`, `path`, `name`, `group_prefix`, `params`).

### Groups (`Group` and `GroupOptions`)

Groups share a path prefix, optional middleware, an optional route-name prefix, and an optional `WorkerMode`:

```titan
local api = app:group_with("/api/v1", mk.GroupOptions {
  name = "v1.",
  workers = mk.WorkerMode.pool(mk.PoolOptions { size = 4 }),
}, auth_mw)

api:use(audit_mw)                         -- middleware scoped to /api/v1
api:use_path("/admin", admin_mw)          -- middleware scoped to /api/v1/admin
api:get("/users/:id", get_user):name("user.show")  -- named "v1.user.show"
```

Nested groups created via `group:group(...)` or `group:group_with(...)` join their prefixes with `router.join_paths`, concatenate `name` prefixes, and inherit the parent group's `WorkerMode` unless overridden in `GroupOptions.workers`.

### `RouteChain`

`RouteChain` registers multiple methods against a single path (and optional sub-paths) without repeating the path string:

```titan
app:route_chain("/articles/:id")
  :get(show_article)
  :put(replace_article)
  :delete(delete_article)
  :route_chain("/comments")
    :get(list_comments)
    :post(add_comment)
```

`Group:route_chain(path)` works identically within a group's prefix and worker mode.

### Mounting Sub-Apps (`App:mount`)

`app:mount(prefix, sub_app)` copies `sub_app`'s middleware and endpoint routes under `prefix` in declaration order. Any route from `sub_app` without an explicit per-route worker mode retains `sub_app`'s `Config.workers` dispatcher rather than silently switching to the parent app's default dispatcher.

## `auto_head` and First-Occurrence `405 Allow`

### Automatic `HEAD` Fallback (`auto_head`)

By default (`Config.auto_head = true`), when a `HEAD` request arrives:

1. `mk` first checks whether any explicit `HEAD` (or an `all(...)`) route matches the path. If one matches, it runs directly.
2. Otherwise, `mk` falls back to matching `GET` routes in registration order, runs the matching `GET` handler chain, and suppresses the response body on the wire while keeping status and headers intact.

Set `Config.auto_head = false` to disable `GET` fallback for `HEAD` requests.

### `405 Method Not Allowed` and `Allow` Header Ordering

When middleware finishes (`ctx:next()` reaches the end of the entry list) and no endpoint matched the request method:

- `mk` scans registered endpoint routes in registration order for routes whose pattern matches the request path.
- If one or more routes match for other methods, `mk` collects their concrete methods in **first-occurrence registration order** without duplicates (inserting `HEAD` immediately after `GET` when `auto_head` is enabled and `HEAD` has not already been seen), formats them via `router.allow_header` (e.g. `GET, HEAD, POST`), sets the `Allow` response header, and raises `mk.HttpError(405, "Method Not Allowed")`.
- If no route matches the path at all, `mk` raises `mk.HttpError(404, "Cannot " .. method .. " " .. path)`.

## Reverse URL Building (`build()` and `App:route_url`)

Named routes can generate paths via `app:route_url(name, params?)`, which delegates to `CompiledPattern:build(params?)`:

```titan
app:get("/users/:id/posts/:slug?", show_post):name("user.post")

local u1 = app:route_url("user.post", { ["id"] = "42", ["slug"] = "hello world" })
-- "/users/42/posts/hello%20world"

local u2 = app:route_url("user.post", { ["id"] = "42" })
-- "/users/42/posts"
```

Building rules:

- Segment parameter values are percent-encoded with `router.percent_encode_segment` (encoding `/` as `%2F`).
- Wildcard values (`"*"` / `"*1"`, `"+"` / `"+1"`) preserve `/` separators while encoding non-`pchar` bytes.
- Omitted or empty whole-segment optional parameters (`/:opt?`) and `*` wildcards omit their leading `/` and vanish cleanly.
- Missing required `:name` parameters or empty `+` wildcards raise an error.
- `app:route_url` raises `"mk: no route named " .. name` if no registered route has that name.

## Registration Hooks and Introspection

- `app:routes()` returns `const {RouteInfo}` for every registered endpoint route in registration order.
- `app:hooks():on_route(fn)`, `on_name(fn)`, and `on_group(fn)` observe routes, route naming, and group creation as they are registered.
- Inside a handler, `ctx:matched_route()`, `ctx:endpoint()`, `ctx:route_name()`, `ctx:mount_path()`, and `ctx:restart_routing()` inspect or restart routing (restarting across different worker dispatchers raises `HttpError(500)`).
