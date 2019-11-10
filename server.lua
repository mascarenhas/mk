#!/usr/bin/env lua
local port = os.getenv('PORT')

local http_server = require "http.server"
local http_headers = require "http.headers"

local function reply(myserver, stream)
	local req_headers = assert(stream:get_headers())
	local req_method = req_headers:get ":method"

	assert(io.stdout:write(string.format('[%s] "%s %s HTTP/%g"  "%s" "%s"\n',
		os.date("%d/%b/%Y:%H:%M:%S %z"),
		req_method or "",
		req_headers:get(":path") or "",
		stream.connection.version,
		req_headers:get("referer") or "-",
		req_headers:get("user-agent") or "-"
	)))

	local res_headers = http_headers.new()
	res_headers:append(":status", "200")
	res_headers:append("content-type", "text/plain")
	assert(stream:write_headers(res_headers, req_method == "HEAD"))
	if req_method ~= "HEAD" then
		assert(stream:write_chunk("<html><body>Hello world!</body></html>\n", true))
	end
end

local myserver = assert(http_server.listen{
	host = "0.0.0.0",
	port = port,
	onstream = reply,
	onerror = function(myserver, context, op, err, errno)
		local msg = op .. " on " .. tostring(context) .. " failed"
		if err then
			msg = msg .. ": " .. tostring(err)
		end
		assert(io.stderr:write(msg, "\n"))
	end
})

assert(io.stdout:write(string.format("Now listening on port %d\n", port)))

assert(myserver:loop())