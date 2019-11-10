local http_util = require "http.util"

local util = {}

function util.encode_uri_part(s)
  return http_util.encodeURIComponent(s)
end

function util.decode_uri_part(s)
  return http_util.decodeURIComponent(s)
end

function util.readfile(filename)
  local file, err = io.open(filename, "rb")
  if file then
    local str = file:read("*a")
    file:close()
    return str
  else
    return nil, err
  end
end

function util.writefile(filename, contents)
  local file, err = io.open(filename, "wb")
  if file then
    file:write(contents)
    file:close()
    return true
  else
    return nil, err
  end
end

function util.tostring(o)
  local out = {}
  if type(o) == "table" then
    out[#out + 1] = "{ "
    for k, v in pairs(o) do
      out[#out + 1] = "[" .. util.tostring(k) .. "] = " .. util.tostring(v) .. ", "
    end
    out[#out + 1] = "}"
  elseif type(o) == "string" then
    out[#out + 1] = o:format("%q")
  else
    out[#out + 1] = tostring(o)
  end
  return table.concat(out)
end

function util.flatten(t)
  local res = {}
  for _, item in ipairs(t) do
    if type(item) == "table" then
      res[#res + 1] = util.flatten(item)
    else
      res[#res + 1] = item
    end
  end
  return table.concat(res)
end

function util.maketag(name, data, class)
  if class then
    class = ' class="' .. class .. '"'
  else
    class = ""
  end
  if not data then
    return "<" .. name .. class .. "/>"
  elseif type(data) == "string" then
    return "<" .. name .. class .. ">" .. data .. "</" .. name .. ">"
  else
    local attrs = {}
    for k, v in pairs(data) do
      if type(k) == "string" then
        table.insert(attrs, k .. '="' .. tostring(v) .. '"')
      end
    end
    local open_tag = "<" .. name .. class .. " " .. table.concat(attrs, " ") .. ">"
    local close_tag = "</" .. name .. ">"
    return open_tag .. util.flatten(data) .. close_tag
  end
end

function util.newtag(name)
  local tag = {}
  setmetatable(
    tag,
    {
      __call = function(_, data)
        return util.maketag(name, data)
      end,
      __index = function(_, class)
        return function(data)
          return util.maketag(name, data, class)
        end
      end
    }
  )
  return tag
end

function util.merge(...)
  local t = {}
  local ts = {...}
  for i = 1, select("#", ...) do
    if ts[i] then
      for k, v in pairs(ts[i]) do
        t[k] = v
      end
    end
  end
  return t
end

function util.concat(...)
  local t = {}
  local ts = {...}
  for i = 1, select("#", ...) do
    if ts[i] then
      for k, v in ipairs(ts[i]) do
        t[#t + 1] = v
      end
    end
  end
  return t
end

return util
