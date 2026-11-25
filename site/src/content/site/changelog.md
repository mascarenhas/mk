---
title: "Changelog"
description: "Release history for titan-mk, the HTTP/1.1 web framework written in Titan."
---

# Changelog

Release history for `titan-mk`.

## v0.1.1

Documentation, site, and Titan 0.6.1 alignment release.

- **Titan 0.6.1 CI and compatibility:** Updated GitHub Actions builds and documentation targets across Linux x64, macOS arm64, and Windows x64 CLANG64 to **Titan 0.6.1** (Lua 5.5.1).
- **Reorganized manual and `mk.titan-lang.dev`:** Restructured `doc/` into Tutorials, How-to Guides, Module Reference, and Explanation chapters, published at [mk.titan-lang.dev](https://mk.titan-lang.dev).
- **Updated skill and package docs:** Refreshed `skills/titan-mk/SKILL.md` and `README.md` with LuaRocks installation (`luarocks install titan-mk`), updated manual paths, and lineage notes crediting Orbit and Kepler Project's `mk`.

## v0.1.0

Initial Titan release of `titan-mk`.

- **Single-provider LuaRocks bundle:** Compiled all 13 public modules (`mk`, `mk.router`, `mk.log`, and 10 `mk.middleware.*` modules) into one `mk.so` + `mk.a` provider pair (`mk.dll` on Windows), shipping `doc/` and `skills/` inside the rock.
- **Compiled PEG routing (`mk.router`):** Added two-tier `titan.peg` route matching with deterministic single-pass matchers and a linear worst-case general evaluator, plus groups, `RouteChain`, `App:mount`, reverse URL building, `auto_head`, and first-occurrence `405 Allow` headers.
- **Typed `Context`, JSON `Bind`, streaming, and WebSockets:** Added immutable `RequestMeta`, JSON-only `ctx:bind()` with exact `415`/`413`/`400`/`422` classification, `HttpError` flow, `on_before_commit` and `on_complete` observers, buffered and streamed responses, and WebSocket upgrades.
- **Shared-nothing OS worker threads:** Added `parent`, `pool`, `session`, and `ephemeral` dispatch via `WorkerMode`, per-worker `on_start` and `defer_cleanup`, causal `ctx:retire_worker()`, keep-alive return pipes, and seven-stage graceful shutdown.
- **Structured logging and built-in middleware:** Added bounded non-suspending JSON-line logging (`mk.log`) with drop accounting and cross-thread forwarding, plus ten middleware modules (`env`, `healthcheck`, `helmet`, `keyauth`, `logger`, `recover`, `requestid`, `responsetime`, `static`, `timeout`).
- **Native testing and coverage:** Added `App:test` (in-memory) and `App:listen_test` (loopback) helpers, `make coverage` line reporting, and cross-platform package smoke tests.
