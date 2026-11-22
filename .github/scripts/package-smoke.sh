#!/usr/bin/env bash
# Install titan-mk from this checkout through LuaRocks, check the installed
# rock payload and provider, build and run an external consumer that finds mk
# only through the SDK, then remove the rock with titan-uninstall.
#
# Run from the repository root with the Titan SDK's bin directory first on
# PATH and TITAN_PREFIX naming that SDK. On Windows (MSYS2 CLANG64) also export
# LUAROCKS_CONFIG.
# Usage: package-smoke.sh ABSENT_WORKSPACE
set -euxo pipefail

workspace=${1:?usage: package-smoke.sh ABSENT_WORKSPACE}
sdk=${TITAN_PREFIX:?set TITAN_PREFIX to the Titan SDK}
rockspec=titan-mk-0.1.0-1.rockspec
lib=$sdk/lib/titan/0.6

case $(uname -s) in
  MINGW* | MSYS*) windows=1 ;;
  *) windows=0 ;;
esac

same_path() {
  if ((windows)); then
    test "$(cygpath -m "$1")" = "$(cygpath -m "$2")"
  else
    test "$1" = "$2"
  fi
}

lr() {
  if ((windows)); then
    luarocks.exe --lua-version=5.5 --tree="$(cygpath -m "$sdk")" "$@"
  else
    luarocks "$@"
  fi
}

# Native Windows programs end lines with CRLF; command substitution keeps the CR.
mkdir "$workspace"
same_path "$(titanc --print-root | tr -d '\r')" "$sdk"

# 1. Build and install from the checkout (luarocks make never fetches source.url).
lr make "$rockspec"

rock_dir=$(lr show --rock-dir titan-mk | tr -d '\r')
if ((windows)); then rock_dir=$(cygpath -u "$rock_dir"); fi
test -s "$rock_dir/doc/index.md"
test -s "$rock_dir/skills/titan-mk/SKILL.md"
if ((windows)); then
  test -f "$lib/mk.dll"
  test ! -e "$lib/mk.so" && test ! -e "$lib/mk.a"
else
  test -f "$lib/mk.so" && test ! -L "$lib/mk.so"
  test -f "$lib/mk.a" && test ! -L "$lib/mk.a"
fi

# 2. An external consumer with no --tree into this checkout and no
# TITAN_PATH_0_6 override: mk resolves only through the installed provider.
consumer=$workspace/consumer
mkdir "$consumer"
cat > "$consumer/main.titan" <<'TITAN'
local io = import "io"
local mk = import "mk"
local router = import "mk.router"

local function hello(ctx: mk.Context)
  ctx:send_string("hello " .. ctx:param("name"))
end

function main(_args: {string}): integer
  local app = mk.App()
  app:get("/hello/:name", hello)
  local response = app:test(mk.TestRequest { method = "GET", target = "/hello/titan" })
  if response.status ~= 200 or response.body ~= "hello titan" then
    io.print("unexpected response " .. response.status .. ": " .. response.body)
    return 1
  end
  io.print("mk consumer: " .. response.body .. " at " .. router.join_paths("/api", "v1"))
  return 0
end
TITAN
expected='mk consumer: hello titan at /api/v1'
(
  cd "$consumer"
  unset TITAN_PATH TITAN_PATH_0_6
  if ((windows)); then
    titanc --output build --exe build/consumer.exe main
    test "$(./build/consumer.exe | tr -d '\r')" = "$expected"
  else
    titanc --output build --exe build/consumer main
    test "$(./build/consumer)" = "$expected"
    # mk imports titan.http/ssl: a system-OpenSSL SDK supplies OpenSSL's
    # flags at the final --static link.
    TITAN_EXTRA_CPPFLAGS="$(pkg-config --cflags openssl)" \
      TITAN_EXTRA_LDFLAGS="$(pkg-config --libs openssl)" \
      titanc --static --output build-static --exe build-static/consumer main
    test "$(./build-static/consumer)" = "$expected"
    # Lua loads the same compiled provider through the Titan package searcher.
    lua -e '
      require "titan"
      local mk = require("mk")
      local router = require("mk.router")
      assert(mk.status_message(404) == "Not Found")
      assert(router.join_paths("/api", "v1") == "/api/v1")
      print("mk lua require: ok")'
  fi
)

# 3. Remove the rock and every published provider file.
if ((windows)); then
  MSYS2_ARG_CONV_EXCL='*' cmd.exe /d /c "titan-uninstall.bat titan-mk"
else
  titan-uninstall titan-mk
fi
test ! -e "$rock_dir"
test ! -e "$lib/mk.so" && test ! -e "$lib/mk.a" && test ! -e "$lib/mk.dll"
if lr show titan-mk > /dev/null 2>&1; then exit 1; fi
echo 'PASS: titan-mk install, payload, consumer, and uninstall'
