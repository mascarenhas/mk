local http_server = require "http.server"
local http_headers = require "http.headers"
local http_util = require "http.util"

local R = require "mk.routes"

local mk = {_NAME = "mk"}

mk._NAME = "mk"
mk._VERSION = "0.1"
mk._COPYRIGHT = "Copyright (C) 2019 Fabio Mascarenhas"
mk._DESCRIPTION = "Mini-Kepler rebooted for Lua web services"

mk.methods = {}

local function not_found(req, res)
  res:status(404)
  res:content_type("text/html")
  res:write [[<html>
        <head><title>Not Found</title></head>
        <body><p>Resource not found</p></body></html>]]
  res:finish()
end

local function server_error(req, res, error)
  res:status(500)
  res:content_type("text/html")
  res:write(
    [[<html>
        <head><title>Server Error</title></head>
        <body>Interval server error</body></html>]]
  )
  res:finish()
end

local http_methods = {"head", "get", "options", "post", "put", "delete", "patch"}

function mk.new(app)
  if type(app) == "string" then
    app = {_NAME = app}
  else
    app = app or {}
  end
  for k, v in pairs(mk.methods) do
    app[k] = v
  end
  app.not_found = not_found
  app.server_error = server_error
  app.routes = {}
  return app
end

for _, method in ipairs(http_methods) do
  local http_method = string.upper(method)
  mk.methods[method] = function(self, route, handler, name)
    name = name or route
    local compiled_route = R(route)
    self.routes[name] = compiled_route.build
    table.insert(
      self.routes,
      {
        name = name,
        route = compiled_route,
        handler = handler,
        method = http_method
      }
    )
  end
end

function mk.methods:match(method, path, index)
  index = index or 0
  for index = index + 1, #self.routes do
    local entry = self.routes[index]
    if entry.method == method then
      local match = entry.route:match(path)
      if match then
        return entry.handler, match, index
      end
    end
  end
end

function mk.methods:log(req, message, level)
  level = string.upper(level or "info")
  local headers = req.headers
  io.stdout:write(
    string.format(
      '[%s] "%s" "%s %s %s" "%s" "%s" %s\n',
      level,
      os.date("%d/%b/%Y:%H:%M:%S %z"),
      req.method or "-",
      headers and headers:get(":path") or "-",
      req.protocol or "-",
      headers and headers:get("referer") or "-",
      headers and headers:get("user-agent") or "-",
      message or ""
    )
  )
end

function mk.methods:handle(stream)
  local headers = stream:get_headers()
  local method = headers:get(":method")
  local authority = headers:get(":authority")
  local scheme = headers:get(":scheme")
  local host, port = http_util.split_authority(authority, scheme)
  local path_and_query = headers:get(":path")
  local path, query = path_and_query:match("^([^?]*)[?]?(.*)$")
  local req = {
    headers = headers,
    method = method,
    host = host,
    port = port,
    scheme = scheme,
    path = path,
    query = query,
    protocol = string.format("HTTP/%g", stream.connection.version),
    stream = stream,
    body = function(self)
      return self.stream:get_body_as_string()
    end
  }
  local res_headers = http_headers.new()
  res_headers:append(":status", "200")
  res_headers:append("content-type", "text/plain")
  local res = {
    headers = res_headers,
    status = function(self, status)
      self.headers:upsert(":status", tostring(status))
    end,
    content_type = function(self, mime_type)
      self.headers:upsert("content-type", mime_type)
    end,
    stream = stream,
    parts = {},
    write = function(self, s)
      table.insert(self.parts, s)
    end,
    finish = function(self)
      if method == "HEAD" then
        self.stream:write_headers(self.headers, true)
      else
        local body = table.concat(self.parts)
        res_headers:upsert("content-length", tostring(#body))
        self.stream:write_headers(self.headers, false)
        self.stream:write_chunk(body, true)
      end
    end
  }
  local handler, match, index = self:match(method, path)
  handler = handler or self.not_found
  match = match or {}
  repeat
    local ok, error =
      xpcall(
      function()
        return handler(req, res, match)
      end,
      debug.traceback
    )
    if not ok then
      self:log(req, error, "error")
      handler, match = self.server_error, error
    else
      self:log(req, res.headers:get(":status"))
    end
  until ok
end

function mk.methods:run(port)
  local myserver =
    assert(
    http_server.listen {
      host = "0.0.0.0",
      port = port,
      onstream = function(_, stream)
        self:handle(stream)
      end,
      onerror = function(_, context, op, err, errno)
        local msg = op .. " on " .. tostring(context) .. " failed"
        if err then
          msg = msg .. ": " .. tostring(err)
        end
        if errno then
          msg = msg .. " (errno: " .. tostring(errno) .. ")"
        end
        self:log({}, msg, "error")
      end
    }
  )
  assert(io.stdout:write(string.format("Now listening on port %d\n", port)))
  assert(myserver:loop())
end

return mk
