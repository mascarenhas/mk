#!/usr/bin/env lua
local mk = require "mk"
local json = require "mk.json"

local app = mk.new()

app:all(json.filter)

app:get(
	"/",
	function(req, res)
		return 200, [[
		<html>
			<head>Hello World</head>
			<body><h1>Hello World!</h1></body>
		</html>
	]]
	end
)

app:get(
	"/json",
	function(req, res)
		res:json()
		return 200, {foo = "bar", items = {1, 2, 3, 4}}
	end
)

app:get(
	"/error",
	function(req, res)
		error("route error")
	end
)

app:post(
	"/show",
	function (req, res)
		local json = req:json()
		res:json()
		return 200, { item = json.array } 
	end
)

app:run(os.getenv("PORT") or 8080)
