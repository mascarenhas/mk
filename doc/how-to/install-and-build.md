# How to Install, Build, and Link `titan-mk`

`titan-mk` requires Lua 5.5 and Titan 0.6 (tested on Titan 0.6.1). All 13 public logical modules compile into a single provider (`mk.so` and `mk.a` on Linux and macOS; `mk.dll` on Windows) installed into your Titan SDK module path.

## Install with LuaRocks

Run `luarocks install` to build and publish the provider into the active Titan SDK:

```sh
luarocks install titan-mk
```

The rockspec compiles the 13 root modules (`mk`, `mk.log`, `mk.router`, and the 10 `mk.middleware.*` modules) and runs `titan-install` as a post-install hook. The hook copies `mk.so` and `mk.a` (or `mk.dll` on Windows) into `<sdk>/lib/titan/0.6/`, where `titanc` discovers them automatically without an extra `--tree` entry.

Check the active Titan SDK root and the rock directory (which holds the installed `doc/` manual and `skills/` agent skill):

```sh
titanc --print-root
luarocks show --rock-dir titan-mk
```

To verify Lua-side loading on Linux or macOS, load the Titan package searcher first:

```sh
lua -e 'require "titan"; print(require("mk").status_message(404))'
```

## Install from a Local Checkout

If you are working from a Git checkout of `titan-mk`, build the provider locally with Make or install it directly with LuaRocks:

```sh
make build
luarocks make titan-mk-0.1.1-1.rockspec
```

Override `TITANC` or `TITAN_JOBS` (default `2`) when selecting a non-default compiler or adjusting parallelism:

```sh
make build TITANC=/path/to/titanc TITAN_JOBS=4
```

To discard local build and staging outputs (`build/` and `dist/`):

```sh
make clean
```

## Structure a Consumer Project

Place application code under `src/` and native tests under `tests/`. Keep the application builder (`build_app`) in its own module so tests can import it without importing the module that defines `main`:

```text
my-service/
  .gitignore          # ignore build/
  src/
    service/
      app.titan       # logical module "service.app"
      main.titan      # logical module "service.main"
  tests/
    service_test.titan
```

Because `mk` imports `titan.uv`, standalone executables start Titan's async runtime automatically before entering `main`. Call `app:listen(...)` directly inside `main`; do not call `async.loop()`.

When passing `--exe` alongside `-o build`, avoid naming the executable identically to a top-level package directory under `build/`. For example, compiling `service.main` with `-o build` creates `build/service/main.c`, so `--exe build/my-service` succeeds whereas `--exe build/service` raises a path conflict.

## Link Dynamically or Statically

### Dynamic executables (default)

Compile a consumer application dynamically against the installed `mk.so` (or `mk.dll` on Windows):

```sh
titanc --incremental --tree src -o build \
  --exe build/my-service service.main
```

### Static executables (Linux and macOS)

Static linking embeds `mk.a` and the Titan standard library into a standalone binary. Static linking is supported on Linux and macOS; Windows publishes only `mk.dll`.

If your Titan SDK was built with bundled OpenSSL, pass `--static` directly:

```sh
titanc --static --tree src -o build \
  --exe build/my-service service.main
```

If your Titan SDK links against system OpenSSL, supply the OpenSSL compiler and linker flags because `mk` imports `titan.http` and `titan.websocket` (which depend on `titan.ssl`):

```sh
TITAN_EXTRA_CPPFLAGS="$(pkg-config --cflags openssl)" \
TITAN_EXTRA_LDFLAGS="$(pkg-config --libs openssl)" \
  titanc --static --tree src -o build \
  --exe build/my-service service.main
```

## Uninstall `titan-mk`

Remove both the LuaRocks package and the published provider files from `<sdk>/lib/titan/0.6/` with `titan-uninstall`:

```sh
titan-uninstall titan-mk
```

On Windows, run the batch wrapper instead:

```sh
titan-uninstall.bat titan-mk
```

For native test execution and line coverage commands, see [How to Test Services and Measure Line Coverage](testing-and-coverage.md).
