# api-contract-drift

When you change an HTTP API, some changes are safe and some quietly break the
services that call you. Removing a field, tightening a type, making a parameter
required — none of these fail a build, and none of them show up in a code review
of the spec file, which just looks like a small YAML edit. You find out when
someone else's service starts throwing errors. This tool takes two versions of
an OpenAPI 3.x spec — the current one and the proposed one — compares them
structurally, and reports every difference as BREAKING, WARNING, or
NON_BREAKING. If you also tell it which services use which parts of your API, it
names them: not just "this field was removed" but "this field was removed, and
checkout-service reads it."

The comparison is a plain structural walk of the two documents. There is no
model, no network call, no heuristic matching: the same pair of files always
produces the same report.

## Example

The repository ships a drifted pair of specs under `test/fixtures/`.
`petstore-old.yaml` is version 1.0.0; `petstore-new.yaml` is the same API after
eleven edits — a removed endpoint, a removed field, a tightened parameter, a
type change, and so on.

```bash
npm run build
node dist/cli.js diff test/fixtures/petstore-old.yaml test/fixtures/petstore-new.yaml \
  --consumers test/fixtures/consumers
```

```
old: test/fixtures/petstore-old.yaml
new: test/fixtures/petstore-new.yaml
consumers: checkout-service, inventory-service, reporting-service

BREAKING      paths./pets.get.parameters.query.limit
              Parameter changed from optional to required; requests omitting it will fail.
              Affected: inventory-service
BREAKING      paths./pets.get.responses.200.content.application/json.schema.items.properties.tag
              Property removed from response; clients reading it will find it missing.
BREAKING      paths./pets.post.requestBody.content.application/json.schema.properties.species
              New required property in request body; existing payloads will be rejected.
              Affected: inventory-service
BREAKING      paths./pets/{petId}.delete
              Method removed from an existing path; calls will fail.
              Affected: checkout-service
WARNING       paths./pets/{petId}.get
              Operation marked deprecated; still works but is scheduled for removal.
              Affected: checkout-service, reporting-service

9 breaking, 4 warning, 4 non-breaking
```

Three things in that output are worth pointing out.

`DELETE /pets/{petId}` was removed, and checkout-service is named because its
manifest says it calls that endpoint. That is the straightforward case.

`species` became a required field on `POST /pets`, and inventory-service is
named — even though inventory-service never mentions `species` anywhere. It is
affected precisely *because* its payload omits the new field. Asking "who
declares `species`?" would have answered "nobody" at the exact moment every
sender broke.

`Pet.tag` was removed, and **nobody** is named on the `/pets` listing, because
no consumer declared reading it there. The same removal on `GET /pets/{petId}`
*does* name checkout-service. An empty "Affected" line is a real answer, not a
gap.

## Consumer manifests

A manifest is one JSON file per service, in a directory you point `--consumers`
at. It declares what that service actually uses:

```json
{
  "consumer": "inventory-service",
  "uses": [
    { "path": "/pets", "method": "get", "reads": ["id", "status"] },
    { "path": "/pets", "method": "post", "sends": ["name"], "reads": ["id"] }
  ]
}
```

`reads` are response fields; `sends` are request body fields. Nested fields are
dotted (`owner.name`), and declaring a parent object covers everything under it.
Fields are named the way a client addresses them: `GET /pets` returns an array
of Pet, so its fields are `id` and `status`, not `items.id`.

Manifests are checked against the current spec before anything else runs. If one
declares a path, method, or field that does not exist, the run stops and prints
every problem rather than producing a report:

```
1 problem in consumer manifests:

  inventory-service — consumers/inventory-service.json
    uses[0].reads[1]: "stauts" is not in any response of get /pets (available: id, name, status, tag)

No report produced. Fix the manifests above, or drop --consumers
to diff the specs without attributing impact.
```

This is deliberate. A typo in `reads` would otherwise mean the field silently
matches nothing, the service that actually breaks is never named, and the
finding reads "0 consumers affected" — which a person reads as *safe to ship*.
That is the one answer this tool must not get wrong, so it refuses to guess.

## Install and run

Requires Node 20 or newer.

```bash
npm install
npm run build
node dist/cli.js diff <old-spec> <new-spec>
```

To run from source without building:

```bash
npm run dev -- diff <old-spec> <new-spec>
```

### Command

```
api-contract-drift diff <old> <new> [options]
```

| Option | Meaning |
| --- | --- |
| `--consumers <dir>` | Directory of consumer manifests. Without it, no impact is attributed and no consumer names appear. |
| `--json` | Emit the full report as JSON instead of text. |
| `--fail-on <level>` | `breaking` (default), `warning`, or `none`. Which severity makes the command exit non-zero. |

Both specs may be YAML or JSON. `$ref`s are resolved, including across files.

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No change at or above the `--fail-on` threshold. |
| `1` | The threshold was tripped. This is the CI signal. |
| `2` | The tool could not run: unreadable spec, or a manifest that is malformed or describes something the spec does not have. |

Exit codes depend on severity alone, never on who is affected. A breaking change
with no known consumer still exits 1: a set of manifests is a claim about what
you know, not proof that nothing else calls your API.

### JSON output

`--json` gives the same findings as structured data, for scripting:

```json
{
  "oldSource": "/path/to/petstore-old.yaml",
  "newSource": "/path/to/petstore-new.yaml",
  "knownConsumers": ["checkout-service", "inventory-service", "reporting-service"],
  "differences": [
    {
      "kind": "request.property.added.required",
      "location": "paths./pets.post.requestBody.content.application/json.schema.properties.species",
      "target": { "path": "/pets", "method": "post", "direction": "request", "field": ["species"] },
      "after": "string",
      "severity": "BREAKING",
      "message": "New required property in request body; existing payloads will be rejected.",
      "consumers": ["inventory-service"]
    }
  ],
  "summary": { "BREAKING": 9, "WARNING": 4, "NON_BREAKING": 4 }
}
```

Read `target` rather than parsing `location`. `location` is built for humans and
is ambiguous on purpose-built inputs — `items` and `properties` are legal
property names, and paths can contain dots. `knownConsumers` is absent entirely
when `--consumers` was not passed, which is how you tell "nobody uses this" from
"nobody told us who uses this".

## CI

`.github/workflows/api-contract-drift.yml` runs on every pull request. It checks
out the base branch and the PR branch into separate directories, diffs the spec
between them, fails the check if anything breaks, and leaves a comment naming
what broke and who it affects:

> ## 3 breaking changes in `test/fixtures/petstore-old.yaml`
>
> These break services that call this API as it exists on the base branch.
>
> - **GET `/pets/{petId}` `tag`**
>   Property removed from response; clients reading it will find it missing.
>   Affects: **checkout-service**

It comments only when something is broken, and updates that comment in place on
later pushes rather than stacking up stale verdicts. Both refs are checked out
whole rather than pulling one file out of git history, because a spec that
`$ref`s sibling files only resolves with the tree around it.

**This repository has no API of its own, so the workflow points at a test
fixture** and is a demonstration: edit `test/fixtures/petstore-old.yaml` in a
pull request and it reports what that edit breaks. Pointing it at a real API
means editing `SPEC_PATH` and `CONSUMERS_DIR` at the top of the file, and
nothing else.

One consequence to know before wiring this to a real spec: if a manifest is
untrue, the tool exits 2 and the check fails with a manifest error rather than a
drift report. That is intended — see the limitation about adding a manifest
alongside its endpoint.

## What it detects

- Paths and methods added or removed
- Parameters (path, query, header) added, removed, retyped, or made
  required/optional — including path-level parameters that apply to every
  operation
- Request body fields added, removed, retyped, or made required/optional
- Response fields, per status code, added, removed, retyped, or made
  required/optional
- Enum values added or removed, on either side
- Response status codes added or removed
- Operations marked deprecated
- The spec version changing

Request and response changes are judged separately, because the same edit means
opposite things depending on direction. Making a field required breaks *senders*
but is harmless to *readers*; adding an enum value is safe for a server to accept
but may surprise a client that switches exhaustively on it. A field appearing in
a response is additive; the same field appearing in a request body is not.

## Known limitations

These are real gaps, not future marketing. If one matters to you, the tool is
lying to you by omission in that specific case.

**Composition keywords are not descended into.** `allOf`, `anyOf` and `oneOf`
are skipped entirely, so a breaking change inside one is not reported. Comparing
their branches positionally would invent false drift whenever a list is merely
reordered, and matching them any other way means guessing. Doing this properly
means merging `allOf` before comparing.

**Media types are only compared where both specs have the same one.** Dropping
`application/json` in favour of `application/xml` is a total break and reports
nothing today.

**Introducing an enum where none existed is not reported**, nor is removing one
entirely. Both narrow or widen what is accepted; neither has a name in the
current vocabulary.

**`requestBody.required` flipping from false to true is not reported**, though
it is breaking.

**Type widening is treated as breaking**, so `integer` to `number` is reported
the same as `string` to `boolean`, despite being safe for most clients.

**Whether a removed parameter or request field actually breaks anyone depends on
server strictness**, which the spec does not state. These are reported as
WARNING rather than guessed at.

**Manifests cannot be added in the same change as the endpoint they use.**
Validation runs against the old spec, so a pull request that adds `/health` *and*
a manifest declaring it will fail: the path does not exist in the old spec yet.
Arguably correct — nobody was calling it, so nothing can break — but it makes
that workflow awkward.

**`reads` is checked against every response status, not the one you meant.** A
field that only exists on the 404 body will validate when read from the 200,
because manifests do not name statuses.

**Enum values are not declared in manifests, only fields.** So removing an
accepted enum value implicates every service sending that field, not only the
ones sending the value that went away. It over-reports.

**Nothing discovers consumers for you.** A manifest set is hand-written and is
only as truthful as whoever wrote it. This tool can tell you that a change breaks
the services you told it about; it cannot tell you about the ones you forgot.

## Development

```bash
npm test          # vitest
npm run typecheck # src and test files
npm run build     # tsc -> dist/
```

`CLAUDE.md` documents the architecture and the reasoning behind the design
decisions, including the ones that look arbitrary until you hit the case that
motivated them.
