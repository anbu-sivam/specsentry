# api-contract-drift

CLI that takes two OpenAPI 3.x specs (an "old" and a "new" version) and reports
the structural changes between them, each classified as BREAKING, NON_BREAKING,
or WARNING.

Lives in `C:\Users\anbus\SpecSentry`. The directory is named SpecSentry; the
package and the CLI binary are both `api-contract-drift`.

## Status

Working end to end. Every stage — loader, differ, rules table, classifier, CLI
— is real. The differ walks both documents and compares them structurally; it
does not call out to anything, and the same input pair always yields the same
report.

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
| `src/differ.ts` | Walks two specs, emits `RawDifference[]`. |
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
specific `DiffKind` rather than the classifier growing logic.

### Direction is part of the vocabulary

Schema kinds are split by which side of the wire they sit on: `request.*` for
anything a client sends, `response.*` for anything it reads. This is the worked
example of the paragraph above — one structural edit means opposite things to
the two parties, which is context the table could not express while a single
`schema.property.removed` covered both.

The payoff is that severities read as plain data. `required.tightened` is
BREAKING on the request side and NON_BREAKING on the response side; enum
additions are NON_BREAKING for requests and WARNING for responses. Same edit,
opposite verdicts, no logic anywhere but the table.

Two consequences worth knowing:

- `param.*` kinds carry no direction because parameters are always request-side.
- The response side has one `response.property.added` rather than a
  required/optional pair: a response gaining a field is additive either way, so
  the distinction the request side needs would be two rules with one severity.

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
covering eleven change types — a version bump, an added path, a removed method,
a tightened param, a removed property, a changed type, an added enum value, a
deprecation. The header comment in `petstore-new.yaml` lists every intended
change; **keep it in sync when editing the fixture.**

The pair is built so `Pet` is only ever returned and `NewPet` only ever sent,
which is what lets it exercise both directions. Those eleven changes produce
**17** findings, because `Pet`'s three edits each land on all three endpoints
that return it. That is intended: each endpoint's contract really did change.

`test/differ.test.ts` pins the full fixture diff as an exact set, then covers
the rest with hand-built specs: the same edit read from both directions,
parameter merging, and cyclic schemas.

`test/cli.test.ts` spawns the CLI through `tsx` against source, so it does not
require a build first.

Tests are **not** typechecked — `tsconfig.json` sets `rootDir: src` and excludes
`test`. The `Record<DiffKind, Rule>` exhaustiveness that makes a missing rule a
compile error therefore protects `src/` only; a retired `DiffKind` left in a
test file surfaces as a runtime failure instead.

## Known open questions

Settled when the differ landed:

- ~~Request vs response asymmetry~~ — fixed by the direction split above. The
  rules no longer assume a side.
- ~~Enum additions hedged to WARNING~~ — now NON_BREAKING for requests, WARNING
  only for responses, where exhaustive client handling is the real risk.

Still open, and deliberately so:

- **`param.removed`** is WARNING because whether it 400s or is ignored depends
  on server strictness, which the spec doesn't state. `request.property.removed`
  is WARNING for the same reason (`additionalProperties: false` or not).
- **Type widening** (`integer` -> `number`) is treated as breaking like any
  other type change; could be refined.

Found while implementing, none of them reachable from the fixtures:

- **Composition keywords.** `allOf` / `anyOf` / `oneOf` are not descended into.
  Matching branches positionally would report false drift when a list is merely
  reordered, and matching them any other way means guessing. Doing this properly
  means merging `allOf` before comparing.
- **Media types** are compared only where both specs have the same one. Dropping
  `application/json` for `application/xml` is a real break that reports nothing
  today.
- **Introducing an enum** where none existed narrows the accepted set, which no
  current kind names, so it is not reported. Same for removing one entirely.
- **`requestBody.required`** flipping false -> true is breaking and unreported.
