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
            +-- consumers.ts  dir -> ConsumerManifest[]
            +-- impact.ts     + manifests -> ImpactedDifference[] (via rules.ts)
```

| File | Role |
| --- | --- |
| `src/types.ts` | Shared vocabulary: `DiffKind`, `RawDifference`, `DiffTarget`, `Severity`, `DriftReport`, the consumer types, `HTTP_METHODS`. |
| `src/loader.ts` | Reads a file, parses it, dereferences `$ref`s. Throws `SpecLoadError`. |
| `src/differ.ts` | Walks two specs, emits `RawDifference[]`. |
| `src/classifier.ts` | Looks each difference up in the rules table; also sorts and summarizes. |
| `src/consumers.ts` | Reads `*.json` manifests from a directory. Throws `ManifestLoadError`. |
| `src/impact.ts` | Cross-references differences against manifests, naming affected consumers. |
| `src/rules.ts` | The rules table — plain data, the only place a kind is judged. |
| `src/index.ts` | `detectDrift()` orchestration plus the public API surface. |
| `src/cli.ts` | Commander entrypoint, text/JSON rendering, exit codes. |

### The rule that matters

**The differ makes no judgements, and nothing downstream has per-kind logic.**
The differ only names *what changed* (a `DiffKind`) and *where* (a location
string plus a `DiffTarget`). Every judgement about a kind — how severe it is,
and who it reaches — lives in the `RULES` table in `src/rules.ts` as data.

So: to retune severities, edit `rules.ts` alone. To detect something new, add a
`DiffKind` in `types.ts`, emit it from `differ.ts`, and add its rule. `RULES` is
typed `Record<DiffKind, Rule>`, so a missing rule is a **compile error**, not an
unclassified change at runtime — that exhaustiveness is deliberate, don't
loosen it to `Partial<Record<...>>`.

Do not add `if (kind === ...)` branches to `classifier.ts` or `impact.ts`. If a
rule needs context the table can't express, that's a signal the differ should
emit a more specific `DiffKind`, or say more in its `DiffTarget`.

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

### Consumer impact

A consumer manifest (`test/fixtures/consumers/*.json`) declares what one service
uses: per endpoint, the response fields it `reads` and the request fields it
`sends`. `impact.ts` cross-references those against the diff so a finding names
who it breaks. Pass `--consumers <dir>`; without it, no impact is attributed and
the report omits `knownConsumers` entirely — which is what separates "nobody uses
this" from "nobody told us who uses this".

`reads`/`sends` mirror the direction split, and that is the whole trick: a
response change is matched against `reads`, a request change against `sends`.

**Impact is per-kind judgement, so it lives in `RULES` as `impact`,** exactly
like severity. Four scopes:

| Scope | Who it names |
| --- | --- |
| `none` | Nobody. Additive or informational. |
| `endpoint` | Anyone calling the endpoint, whatever fields they declared. |
| `field.declared` | Consumers that declared the field. |
| `field.omitted` | Consumers calling the endpoint that did *not* declare it. |

`field.omitted` is the one that isn't obvious, and it is why this can't be a
plain "does the manifest mention this field?" lookup. **The request side
inverts.** A consumer breaks on a newly required field precisely *because* its
payload omits it — and it cannot have declared a field that did not exist yet.
Asking "who declared `species`?" answers *nobody* at the exact moment every
sender is broken. `request.property.added.required` and
`request.property.required.tightened` are the two kinds that invert; the rest
ask the ordinary question.

Two matching rules worth knowing:

- `field.declared` matches by **segment-wise prefix, either direction**:
  declaring `owner` covers `owner.name` below it, and declaring `owner.name`
  still matches when `owner` itself is removed.
- `field.omitted` demands an **exact** match, because a declared ancestor is no
  proof the payload carries a specific leaf — an `owner` object declared before
  `owner.email` became required is exactly what would lack it.

### Why findings carry a structured target

`RawDifference.location` is for humans and **cannot be parsed back**. `items` and
`properties` are legal property names and a path may contain dots, so the string
is ambiguous about which segment means what. Anything needing to reason about
where a change landed reads `target` instead: `{ path, method, direction, field }`.

`target.field` is the property path *as a client addresses it*, with array hops
elided — `/pets` returns `[Pet]`, so `tag` is `['tag']`, not `['items','tag']`.
It is absent inside parameter schemas, which have no body field to name; a
field-scoped finding with no field falls back to endpoint attribution rather than
reporting a breaking change as hitting nobody.

## Commands

```bash
npm run build      # tsc -> dist/
npm test           # vitest run
npm run dev -- diff <old> <new>   # run from source via tsx
node dist/cli.js diff <old> <new>
```

## CLI

```
api-contract-drift diff <old> <new> [--json] [--consumers <dir>]
                                    [--fail-on breaking|warning|none]
```

`--fail-on` defaults to `breaking`. Exit codes: **0** clean, **1** the
`--fail-on` threshold was tripped (for CI gating), **2** an operational error
(unreadable spec or manifest, bad flag).

Exit codes key off severity alone. Who is affected is reported, never gated on:
a breaking change with no known consumer still fails the build, because a
manifest set is a claim about what is known, not proof that nothing else calls
the API.

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

`test/fixtures/consumers/` holds three manifests built so each is affected by
some findings and pointedly unaffected by others — that contrast is the point,
so preserve it when editing:

- **checkout-service** reads `id`/`name`/`tag` from `GET /pets/{petId}` and calls
  the removed `DELETE`. Unaffected by the `status` enum it never reads.
- **inventory-service** reads `id`/`status` from `GET /pets` and sends `name` to
  `POST /pets`. It is the `field.omitted` case: affected by required `species`
  despite never declaring it. Unaffected by `Pet.tag` going, which it never read.
- **reporting-service** reads only `Pet.name`, which never moved. Reached by
  nothing but the deprecation of the endpoint it calls — the negative control.

`test/impact.test.ts` pins every attribution across the fixture pair, then covers
direction, endpoint matching, and nested-field prefix rules with hand-built
manifests.

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

On the consumer layer:

- **Manifests are taken at their word.** Nothing checks a declared path/method
  against the spec, so a typo in `reads` silently means "not affected" and a
  manifest naming a dead endpoint reports nothing. Validating manifests against
  the old spec would catch both, and is the obvious next step.
- **Enum values aren't declared, only fields.** `request.enum.value.removed`
  therefore implicates every sender of the field, not only those sending the
  dropped value. Over-reports, deliberately.
- **A parameter's inner schema has no field to name**, so a field-scoped finding
  there falls back to endpoint attribution. Reached only by object-schema params
  (`deepObject`), which the fixtures don't cover. Proper fix is probably
  `param.enum.*` kinds rather than reusing `request.enum.*`.

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
