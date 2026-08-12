# Anthropic wire fixtures

Sanitized captures of the Anthropic Messages streaming protocol, used by
`tests/model/adapter-conformance.test.ts` to validate the adapter with no
credentials and no network (spec §25, §26).

`*.sse` files are raw Server-Sent Events exactly as the wire delivers them, so
the fixture exercises the SSE decoder as well as the adapter:

    fixture bytes -> decodeSse -> adapter.translate -> ModelEvent[]

`http-*.json` files are non-2xx response bodies, used to check error mapping.

## Sanitisation

These contain no real API key, no private source, no user prompt and no
production identifier. Every id is literally prefixed `FIXTURE_`, and
`assertFixturesAreSanitised` in the conformance suite enforces that — a fixture
recorded from a real session would fail the test rather than land silently.

## Adding one

1. Capture the stream, replace every id with a `FIXTURE_`-prefixed value.
2. Drop anything that is not needed to reproduce the behaviour.
3. Add a case to the conformance suite naming the normalized IR you expect.

A fixture with no assertion is decoration.
