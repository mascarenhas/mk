local cjson = require "cjson.safe"

local function filter(req, res, _, next)
  if req.headers:get("content-type") == "application/json" then
    local parsed_body
    req.json = function(self)
      parsed_body = parsed_body == nil and cjson.decode(req:body()) or parsed_body
      return parsed_body
    end
  else
    req.json = req.body
  end
  res.json = function(self, response)
    self:content_type("application/json")
  end
  local status, response = next()
  if res.headers:get("content-type") == "application/json" then
    local json_response = assert(cjson.encode(response))
    return status, json_response
  else
    return status, response
  end
end

local function jsonify(status, response)
  local json_response = assert(cjson.encode(response))
  return status, json_response
end

return {
  filter = filter
}
