# ScriptDev — ES-090 Phase 1 (independent TDD)

These tests are ScriptDev's (agent 6) **own** Phase 1 tests, written from the
ChangedSpec (post HolePoker Loop 1) independently of ReviewMaster's tests
under `tests/unit/es-090/*.test.ts`.

Per NewDev DevForks protocol:

- **Phase 1 (HERE):** my own tests — TDD, RED state pre-implementation.
- **Phase 2:** implementation until these tests pass.
- **Phase 3:** also apply ReviewMaster's tests under `tests/unit/es-090/` as
  the authoritative suite — fix any divergence using ChangedSpec as
  tie-breaker.

Naming convention: `*.spec.ts` here (to visually distinguish from
ReviewMaster's `*.test.ts` at the parent level).

Coverage is organized per ES-090 fix, not per-file. One `*.spec.ts` per
fix/route/concern.
