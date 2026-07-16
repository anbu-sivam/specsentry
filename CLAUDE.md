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
            +-- validate.ts   manifests x old spec -> ManifestProblem[]  (fatal if any)
            +-- impact.ts     + manifests -> ImpactedDifference[] (via rules.ts)
```

| File | Role |
| --- | --- |
| `src/types.ts` | Shared vocabulary: `DiffKind`, `RawDifference`, `DiffTarget`, `Severity`, `DriftReport`, the consumer types, `HTTP_METHODS`. |
| `src/openapi.ts` | The shape of an OpenAPI document and the accessors for reading one. No pipeline logic. |
| `src/loader.ts` | Reads a file, parses it, dereferences `$ref`s. Throws `SpecLoadError`. |
| `src/differ.ts` | Walks two specs, emits `RawDifference[]`. |
| `src/classifier.ts` | Looks each difference up in the rules table; also sorts and summarizes. |
| `src/consumers.ts` | Reads `*.json` manifests from a directory. Throws `ManifestLoadError`. |
| `src/validate.ts` | Checks each manifest's claims against the old spec. Throws `ManifestValidationError`. |
| `src/impact.ts` | Cross-references differences against manifests, naming affected consumers. |
| `src/rules.ts` | The rules table — plain data: severity and impact scope per kind. |
| `src/suggestions.ts` | What to do about each kind, as templates over its `DiffTarget`. |
| `src/index.ts` | `detectDrift()` orchestration plus the public API surface. |
| `src/cli.ts` | Commander entrypoint, text/JSON rendering, exit codes. |
| `src/drift-comment.ts` | Renders a report as the PR comment body for the drift workflow. Lives here, not beside the workflow, so it is typechecked and testable; the workflow runs the built `dist/drift-comment.js`. |

`openapi.ts` exists so the differ and the validator cannot disagree about what a
schema is. A field the validator rejects is one the impact layer could never
match, and that disagreement would be invisible — no test would fail, findings
would just quietly attribute to nobody.

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

### Migration suggestions

Each BREAKING finding carries a `suggestion`: what to do about it, named for the
field, parameter, enum value or endpoint that moved. `src/suggestions.ts` holds
them as `Record<DiffKind, Suggest>`, where `Suggest` is
`(difference) => string` or `null`. The classifier attaches it exactly as it
attaches `severity`, so the CLI, the JSON report and the PR comment all get it
for free.

A template takes the whole `RawDifference`, not just its target, because
`before`/`after` hold the enum value that changed and are shaped per kind. That
is safe to read *here and only here*: every entry in the table already knows
which kind it was written for. Nothing else may read `before`/`after`
structurally — elsewhere they are display-only and typed `unknown`.

**Why not in `RULES`, given it is per-kind judgement like severity and impact.**
`RULES` is constants — the table you open to retune a severity. Suggestions are
functions of a target, and 16 of the 29 kinds need none. Folding them in would
triple that table and bury severity under `suggest: null` noise. The
exhaustiveness that matters is kept: `Record<DiffKind, Suggest>` still forces a
new kind to decide, and `null` is spelled out rather than omitted.

This is the arguable one. It splits per-kind judgement across two tables, which
is exactly the thing the rules table exists to avoid. The counter is that the
two are read by different people at different times.

Only BREAKING kinds carry advice. Several WARNING kinds could — `param.removed`
and `operation.deprecated` both have obvious answers — and adding them is a
one-line change each, since both renderers print a suggestion whenever one is
present. It was left out because the ask was breaking changes.

The advice itself is a judgement call throughout, and mostly the same call:
**deprecate rather than break.** It assumes a new API version is available to
move the break into, and that the server can hold a compatibility shim for a
cycle. Neither is true everywhere.

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

### Invalid manifests stop the run

Every manifest is checked against the **old** spec before any impact is
attributed: does the path exist, does the method exist on it, does each `reads`
field appear in a response schema and each `sends` field in the request body. If
anything is wrong, `detectDrift` throws `ManifestValidationError` carrying
*every* problem, and the CLI prints them and exits **2 without a drift report**.

**Why the whole run rather than dropping the bad manifest or the bad line.**
Both of those alternatives produce a report that is silently short: a typo in
`reads` makes the field unmatched, so the consumer that actually breaks is never
named, and the finding reads `0 consumers affected`. A human reads that as *safe
to ship*. That is the exact failure this layer exists to remove, so degrading to
it on bad input would be self-defeating — the tool would be at its least reliable
precisely when its input is least trustworthy.

It is also what already happened: `method: "fetch"` has always thrown
`ManifestLoadError` and failed the run. `path: "/petz"` is the same class of
mistake — a manifest naming something that does not exist — and treating one as
fatal and the other as a shrug would be arbitrary.

The cost is bounded, which is what makes this affordable: `--consumers` is
opt-in, so the drift report is always one flag away. Refusing to print it costs
a re-run, never information. The CLI says so in the error.

Validation is against the old spec because that is the contract consumers run
against today. A field that exists only in the new spec is one nobody can be
using yet, so `sends: ["species"]` is a manifest describing a future it has not
shipped.

**Validity is decided by resolving the declared path, not by enumerating the
schema.** Dereferencing turns a self-referencing `$ref` into a real object cycle,
where `child.child.name` is genuinely addressable and enumeration would never
finish producing every path. Following a path someone already wrote is bounded by
its own length. `fieldPathsOf` still enumerates for the *did-you-mean* hint in
the message, and stops at cycles — that is a hint, not a verdict, and the two
must not be confused.

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

`target.parameter` is the parameter a change lands on or inside. It is a
separate field rather than reusing `field` because impact.ts matches `field`
against a manifest's `reads`/`sends`, which only ever name body fields — a
parameter name in there would be matched against the wrong thing. It exists
because the name is genuinely unrecoverable otherwise: `location` cannot be
parsed back, and `before`/`after` carry it only for `param.added.*` and
`param.removed`. For `param.required.tightened` they are the booleans `false`
and `true`, and for `param.type.changed` the two type names — no name in sight.

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
(unreadable spec, unreadable or untrue manifest, bad flag).

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

`test/fixtures/consumers-invalid/` holds four manifests that are each wrong in a
different way — a typo'd path, a real method the path doesn't define, a typo'd
field, and one with three problems at once. **Keep it separate from
`consumers/`**, which must stay valid: loading a directory loads all of it.

`test/validate.test.ts` asserts that the valid fixtures produce zero problems,
which is what pins the validator and the impact layer to one idea of a field
path. If they ever diverge, that test fails rather than the disagreement passing
silently.

`test/cli.test.ts` spawns the CLI through `tsx` against source, so it does not
require a build first.

Tests are typechecked, but not by `npm run build`. `tsconfig.json` has to keep
`rootDir: src` to emit `dist/` in the right shape, so `tsconfig.test.json`
extends it with `noEmit` and widens `include` to cover `test/` as well.
`npm run typecheck` runs both, and CI runs that. The `Record<DiffKind, Rule>`
exhaustiveness therefore reaches test files: a retired `DiffKind` in a test is a
compile error, not a runtime surprise.

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

- ~~Manifests are taken at their word~~ — `validate.ts` now checks every claim
  against the old spec, and an untrue one stops the run. See above.
- **A manifest can't be added in the same commit as the endpoint it uses.**
  Validation is against the old spec, so a PR that adds `/health` *and* a
  manifest declaring it fails: the path doesn't exist in old. Arguably correct
  (nobody was calling it, so nothing can break), but it makes the natural
  workflow awkward. Allowing paths present in the new spec would fix it, at the
  cost of a rule that's harder to explain.
- **No suggestion for near-misses.** The message lists available fields, which
  is enough to spot `nmae` -> `name`, but it doesn't say so. Edit distance would
  be deterministic and cheap; it just isn't there.
- **`reads` is checked against every response status, not the one meant.** A
  field that exists only on the 404 body validates when read from the 200.
  Manifests don't name statuses, so tightening this means extending the format.
- ~~Suggestions and the PR comment can't name the parameter or the enum value~~
  — `target.parameter` now carries the name, and enum templates read the value
  off `before`/`after`, where the differ has always put it. Both renderers say
  which one moved.
- **Enum values still aren't *declared* in manifests, only fields.** This is
  about attribution, not naming: `request.enum.value.removed` implicates every
  sender of the field rather than only those sending the dropped value, even
  though the message now names that value. Over-reports, deliberately.
- **A parameter's inner schema still has no field to name**, so a field-scoped
  finding there still falls back to endpoint *attribution* — a manifest can't
  declare a path into a parameter. Only the naming half of this is fixed.
  Reached only by object-schema params (`deepObject`), which the fixtures don't
  cover. Proper fix is probably `param.enum.*` kinds rather than reusing
  `request.enum.*`.

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
