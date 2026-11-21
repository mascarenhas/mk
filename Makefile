TITANC ?= titanc
TITAN_JOBS ?= 2
TEST_ARGS ?=

# The thirteen public logical modules published together in one mk provider
# (build/mk.so + build/mk.a). Keep this list identical to the rockspec roots.
ROOTS ?= mk mk.log mk.router \
	mk.middleware.env mk.middleware.healthcheck mk.middleware.helmet \
	mk.middleware.keyauth mk.middleware.logger mk.middleware.recover \
	mk.middleware.requestid mk.middleware.responsetime \
	mk.middleware.static mk.middleware.timeout

.DELETE_ON_ERROR:
.PHONY: all build tests test clean

all: build

# titanc --incremental owns freshness, so these targets always delegate to it.
build:
	+$(TITANC) --incremental -j $(TITAN_JOBS) --tree src --output build $(ROOTS)

tests:
	+$(TITANC) --incremental -j $(TITAN_JOBS) --test --tree "src;tests" --test-dir tests --output build --exe build/mk-tests

test: tests
	./build/mk-tests $(TEST_ARGS)

clean:
	rm -rf build dist
