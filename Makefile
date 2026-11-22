TITANC ?= titanc
TITAN_JOBS ?= 2
TEST_ARGS ?=
# Coverage: COVERAGE_GCOV overrides titanc's gcov command (default: GCOV,
# gcov, or llvm-cov gcov); COVERAGE_FORMAT lists extra gcovr reports (html,
# lcov, cobertura) and COVERAGE_GCOVR overrides their gcovr command (default:
# GCOVR or gcovr); COVERAGE_FLAGS passes further titanc --coverage options.
COVERAGE_GCOV ?=
COVERAGE_GCOVR ?=
COVERAGE_FORMAT ?=
COVERAGE_FLAGS ?=
COVERAGE_OPTIONS = --coverage $(if $(COVERAGE_GCOV),--coverage-gcov "$(COVERAGE_GCOV)") \
	$(if $(COVERAGE_GCOVR),--coverage-gcovr "$(COVERAGE_GCOVR)") \
	$(foreach format,$(COVERAGE_FORMAT),--coverage-format $(format)) $(COVERAGE_FLAGS)

# The thirteen public logical modules published together in one mk provider
# (build/mk.so + build/mk.a). Keep this list identical to the rockspec roots.
ROOTS ?= mk mk.log mk.router \
	mk.middleware.env mk.middleware.healthcheck mk.middleware.helmet \
	mk.middleware.keyauth mk.middleware.logger mk.middleware.recover \
	mk.middleware.requestid mk.middleware.responsetime \
	mk.middleware.static mk.middleware.timeout

.DELETE_ON_ERROR:
.PHONY: all build tests test coverage coverage-build coverage-run clean

all: build

# titanc --incremental owns freshness, so these targets always delegate to it.
build:
	+$(TITANC) --incremental -j $(TITAN_JOBS) --tree src --output build $(ROOTS)

tests:
	+$(TITANC) --incremental -j $(TITAN_JOBS) --test --tree "src;tests" --test-dir tests --output build --exe build/mk-tests

test: tests
	./build/mk-tests $(TEST_ARGS)

# Instrumented objects, counters, and reports live under build/coverage, so
# ordinary build/ outputs are untouched. GCOV_PREFIX* would relocate the
# counter files away from their objects, so they are cleared.
coverage-build:
	+env -u GCOV_PREFIX -u GCOV_PREFIX_STRIP $(TITANC) --incremental -j $(TITAN_JOBS) $(COVERAGE_OPTIONS) \
		--test --tree "src;tests" --test-dir tests --output build/coverage --exe build/coverage/mk-tests

# A passing full run prints the executable-line summary and writes
# build/coverage/.coverage/report/coverage.gcov (plus any requested formats).
coverage-run:
	env -u GCOV_PREFIX -u GCOV_PREFIX_STRIP ./build/coverage/mk-tests

coverage: coverage-build
	$(MAKE) coverage-run

clean:
	rm -rf build dist
