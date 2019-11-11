#!/usr/bin/env lua
local mk = require "mk"

local app = mk.new()

app:get("/", function (req, res)
	res:status(200)
	res:content_type("application/json")
	res:write('{"foo": "bar"}')
end)

app:get("/error", function (req, res)
	error("route error")
end)

app:run(os.getenv('PORT') or 8080)
