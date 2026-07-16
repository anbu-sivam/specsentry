# api-contract-drift

CLI that takes two OpenAPI 3.x specs (an "old" and a "new" version) and reports
the structural changes between them, each classified as BREAKING, NON_BREAKING,
or WARNING.

Lives in `C:\Users\anbus\SpecSentry`. The directory is named SpecSentry; the
package and the CLI binary are both `api-contract-drift`.

## Status

Scaffold only. The pipeline runs end to end, but **`diffSpecs` is a stub** that
returns a hardcoded list of sample differences — it does not read the specs it
is handed. The loader, rules table, classifier, and CLI are real. The next task
is implementing the differ for real.

## Stack

TypeScript (ESM, `NodeNext`) on Node >= 20. `@apidevtools/swagger-parser` for
`$ref` dereferencing, `js-yaml` for parsing, `commander` for the CLI, `vitest`
for tests.

## Architecture

The pipeline is a straight line, and the module boundaries are the point:

```
cli.ts -> index.ts (detectDrift)
            |
            +-- loader.ts    file -> dereferenced spec
            +-- differ.ts    two specs -> RawDifference[]   (no judgement)
            +-- classifier.ts RawDifference[] -> ClassifiedDifference[] (via rules.ts)
```

| File | Role |
| --- | --- |
| `src/types.ts` | Shared vocabulary: `DiffKind`, `RawDifference`, `Severity`, `DriftReport`. |
| `src/loader.ts` | Reads a file, parses it, dereferences `$ref`s. Throws `SpecLoadError`. |
| `src/differ.ts` | **STUB.** Walks two specs, emits `RawDifference[]`. |
| `src/classifier.ts` | Looks each difference up in the rules table; also sorts and summarizes. |
| `src/rules.ts` | The rules table — plain data, the only place severity is decided. |
| `src/index.ts` | `detectDrift()` orchestration plus the public API surface. |
| `src/cli.ts` | Commander entrypoint, text/JSON rendering, exit codes. |

### The rule that matters

**The differ makes no judgements and the classifier has no per-kind logic.**
The differ only names *what changed* (a `DiffKind`) and *where* (a location
string). All severity lives in the `RULES` table in `src/rules.ts` as data.

So: to retune severities, edit `rules.ts` alone. To detect something new, add a
`DiffKind` in `types.ts`, emit it from `differ.ts`, and add its rule. `RULES` is
typed `Record<DiffKind, Rule>`, so a missing rule is a **compile error**, not an
unclassified change at runtime — that exhaustiveness is deliberate, don't
loosen it to `Partial<Record<...>>`.

Do not add `if (kind === ...)` branches to `classifier.ts`. If a rule needs
context the table can't express, that's a signal the differ should emit a more
specific `DiffKind` (e.g. splitting request vs response) rather than the
classifier growing logic.

## Commands

```bash
npm run build      # tsc -> dist/
npm test           # vitest run
npm run dev -- diff <old> <new>   # run from source via tsx
node dist/cli.js diff <old> <new>
```

## CLI

```
api-contract-drift diff <old> <new> [--json] [--fail-on breaking|warning|none]
```

`--fail-on` defaults to `breaking`. Exit codes: **0** clean, **1** the
`--fail-on` threshold was tripped (for CI gating), **2** an operational error
(unreadable spec, bad flag).

## Tests

`test/fixtures/petstore-old.yaml` and `petstore-new.yaml` are a drifted pair
covering roughly a dozen change types — a version bump, an added path, a removed
method, a tightened param, a removed property, a changed type, an added enum
value, a deprecation. The header comment in `petstore-new.yaml` lists every
intended change; **keep it in sync when editing the fixture.** These are the
cases the real differ should be built against.

`test/differ.test.ts` currently only asserts the stub's contract (every emitted
kind exists in `RULES`). It needs real cases once the differ lands.

`test/cli.test.ts` spawns the CLI through `tsx` against source, so it does not
require a build first.

## Known open questions

Recorded while writing the rules table, deferred until the differ is real:

- **Request vs response asymmetry.** Adding a required property breaks
  *requests*; removing a property breaks *responses*. `schema.property.*` kinds
  don't currently distinguish direction, so the rules assume the breaking side.
  Real fix is probably separate kinds per direction.
- **Enum additions** are additive for requests but can break exhaustive client
  handling of responses — currently WARNING as a hedge.
- **`param.removed`** is WARNING because whether it 400s or is ignored depends
  on server strictness, which the spec doesn't state.
- **Type widening** (`integer` -> `number`) is treated as breaking like any
  other type change; could be refined.
