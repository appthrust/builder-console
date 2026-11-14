# Builder Console

The Project-scoped AppThrust console for building, releasing, sharing, and opening
business applications. The Go server serves the React SPA, the console API, and a
same-origin Platform API proxy. Directory owns people, groups, and memberships;
Builder Console keeps app metadata, access requests, comments, and sharing policy.

## Repository

- `cmd/server/`: Go server and tests, using `github.com/appthrust/appserver-go v0.2.0`.
- `web/`: Vite/React SPA, unit tests, in-memory development APIs, and Playwright stories.
- `catalog/entry.yaml`: ApplicationStackDefinition, including the Directory dependency,
  PostgreSQL connection, identity access settings, probes, and existing version floors.
- `hack/publish-entry.ts`: immutable version rendering and signed catalog publication.
- `.github/workflows/ci.yml`: Go, web, and publisher checks.
- `.github/workflows/publish.yml`: tag-only multi-architecture image and catalog publisher.

Imported from `appthrust/platform` revision
`5536b5065bcd571f59078eae71a0269a65294e6f`, paths
`cmd/builder-console-server` and `dashboard/packages/builder-console`.
The app no longer needs a Platform source checkout. See [web/README.md](web/README.md)
for UI architecture, development modes, and product contracts.

## Development and checks

Use Go 1.26 or newer, Bun 1.4.1 or newer, and a GitHub token with package read access.
`web/.npmrc` routes the `@appthrust` scope to GitHub Packages; tokens are supplied only
through `NODE_AUTH_TOKEN`. All three published packages (`api-schema`, `app-launcher`,
`platform-dashboard-i18n`) use `^0.1.1`. The console has its own Japanese-default
language store; the shared i18n package is used by the app launcher. API schema imports
use the published `/platform-api` and `/platform-api-router` exports.

```sh
go build ./...
go test ./...
go vet ./...
bun test hack/

cd web
NODE_AUTH_TOKEN="$(gh auth token)" bun install --frozen-lockfile
bun run build:image
bun run typecheck
bun run test
```

PostgreSQL integration tests are opt-in: set `BUILTIN_APPSERVER_TEST_DATABASE_URL`
(or `BUILDER_CONSOLE_TEST_DATABASE_URL`) to a disposable test database. The Go SDK
creates and cleans an isolated schema per test; without a DSN those tests skip.
DOM unit tests use the repository-local `web/test/dom.ts` preload from
`web/bunfig.toml`, with no sibling Dashboard package dependency.

From `web/`, run `bun run mock` and `bun run dev` in separate terminals. The default
ports are 54385 for the mock API and 5199 for Vite; set `CONSOLE_MOCK_PORT` and
`CONSOLE_PORT` to isolate concurrent work. Neither command requires a live Platform.

The retained browser suite runs against its own local mock API and Vite server:

```sh
cd web
bun run typecheck:e2e
bun x playwright install chromium
bun run test:e2e:mock
```

`test:e2e` runs the complete story suite. Configure `CONSOLE_E2E_PORT` and
`CONSOLE_E2E_MOCK_PORT` to isolate browser runs. No live platform credentials are
needed. CI runs every story on each pull request and main push (`console-mock-stories`,
aggregated with the other jobs into the required `console-verification` check); see
[Browser stories](web/README.md#browser-stories) for the automatic checks and how to
declare an expected failure. Stories may import only types from
`@appthrust/api-schema`: its published ESM files have extensionless relative imports
that Playwright's Node loader cannot resolve, and one value import fails discovery
of the whole suite. Fixing the package's Node-ESM exports is owned by the SDK
repository, not by an app-local source alias or loader shim.

### Console response contracts

`web/src/api/contracts/console/schema/` is the canonical Zod source for Console
success wires and the HTTP error envelope. `operations.ts` in that directory
registers 33 Console operations, including `/config`, screenshot multipart
responses, and the three 204 deletes. Conversation sessions add 12 v1 operations
in `build-session-operations.ts`. Adapters reuse those schemas and expose the
domain types in `model/contracts/console.ts`.

Every successful response passes through `api/gateway.ts` exactly once before
a query, mutation, loader or screen uses it. Feature, model, route and copy code
cannot import raw clients or Console schemas, call `fetch`/`response.json()`, or
assert wire output types. `bun run check:response-boundaries` rejects every
violation, including type-only, barrel and dynamic imports; there are no
per-file exemptions. Domain declarations in `model/contracts` may derive
Platform types; that does not permit raw transport or Console schema imports.
Mocks infer wire types from the canonical schemas, not a second handwritten DTO.
Unreadable writes are unconfirmed, never automatically resent; unreadable reads
retain the last successful cached domain value.

| Operation family | Count | Responses |
| --- | ---: | --- |
| Bootstrap | 2 | me, config |
| Directory proxy | 6 | groups, people, person profile, create person, members, realm users |
| Apps and resolution | 11 | list/get/by-path/create/update/bind/delete, directory list/entry, tools, resolve |
| Comments | 3 | list, post, delete |
| Screenshots | 3 | multipart upload, reorder, delete |
| Access requests | 6 | mine, create, pending, app requests, approve, decline |
| Administration | 2 | platform settings, Directory migration |

Collections carry `presence: total`; optional observations carry
`presence: optionalObservation`. There are no blanket null/absence defaults in
the Console readers. Missing permissions fail bootstrap. Unknown share scopes,
roles, and request states remain explicitly unknown; unknown tagged results are
unsupported. A removed person is `{ unknown: true, id }` in the domain, never a
fabricated contact. The older public SDK's broad Person shape is not permission
to invent missing email, subject, or ownership evidence.

Generate and check the internal artifact from `web/`:

```sh
bun run generate:console-schema
bun run check:console-schema
```

`cmd/server/internal/api/console-spa.openapi.json` is committed, generated, and
**not served**. Go tests validate real response writers and handler output against
it. `testdata/console-wire.json` contains Go-marshaled fixtures, including empty
collections, omitted observations, pending people, and removed people; SPA tests
replay those original wires, not parsed/defaulted values. To deliberately update
fixtures after reviewing a writer change:

```sh
UPDATE_CONSOLE_WIRE_FIXTURES=1 go test ./cmd/server/internal/api -run '^TestConsoleWriterContract$'
```

The existing served `openapi.json` remains byte-identical to the public
`appserver-go v0.5.0` Console contract. Compatibility tests check its listApps /
getApp fields and fixtures against the internal schema. Replacing that public
document needs separate review. This intentionally deviates from the design's
single generated public document and separate `B/api-schema` package: the schema
currently has one TypeScript consumer, so it shares the SPA's Zod installation.
A package boundary is deferred until a second consumer needs it, avoiding
file-dependency symlink resolution and build changes.

`check:console-schema` regenerates into a temporary directory, detects drift,
and cleans up. The existing web CI job runs it. The boundary checker also rejects
feature/model imports of the canonical schema directory, including type-only
imports, barrels, and assertions. PostgreSQL handler contract tests use the same
opt-in DSN and isolated-schema cleanup as the other server integration tests.

### NEW-APP conversation contracts (APT-753 / S4)

The same canonical schema directory now owns `build-sessions.ts` and
`build-session-operations.ts`. `api/contracts/console/build-sessions.ts` exposes
response boundaries and inferred input/domain types; `model/contracts/console.ts`
exports the domain types. Features must not import raw schemas. The server and
SPA consume these contracts for the v1 conversation flow.

The existing generator also emits `cmd/server/internal/domain/build-reply.schema.json`
(JSON Schema 2020-12, `urn:appthrust:builder-console:reply:1`, at most 8 KiB).
Go embeds it through `domain.BuildReplySchema()` for the AgentTurn input. Both
artifacts are covered by `check:console-schema`. The served `openapi.json` is
unchanged. This deliberately replaces the design's proposed independent
`contracts/conversation` package and public-document edits with the established
SPA canonical-source/internal-document convention.

Go HTTP DTOs remain in `api/build_session_dto.go`; reusable Reply types and
the raw validator input live in `domain/build_reply.go`, following the existing
API-to-domain response ownership. A conversation service can therefore consume
them without depending on its HTTP handlers or creating an import cycle.

All paths below have prefix `/api/console/v1`. All responses, including errors,
require `Cache-Control: no-store`. `K` means required `Idempotency-Key`
(1–128 printable ASCII characters); `V` means required strong `If-Match:
"bs-<version>"`. Replay lookup precedes version checks; missing preconditions are
428 `precondition_required`, mismatches 412 `version_conflict` with
`details.currentVersion`, and key/body conflicts 409 `idempotency_conflict`.

| Method/path | Body/query | Success resource | Request headers |
| --- | --- | --- | --- |
| POST `/build-sessions` | `kind: new-app`, `groupId`, `intent`, `locale: ja/en` | 202 Session | K |
| GET `/build-sessions` | `cursor?`, `limit?` (1–50; default 20) | 200 `{items,nextCursor?}` | — |
| GET `/build-sessions/{id}` | — | 200 Session | — |
| GET `/build-sessions/resolve` | required `draftId` | 200 console-v1/sessionId or platform-v1/draftId | — |
| POST `/build-sessions/{id}/advance` | `{}` | 202 Session | K, V |
| POST `/build-sessions/{id}/turns` | conversation or request_plan union | 202 Turn | K, V |
| GET `/build-sessions/{id}/turns` | `cursor?`, `limit?` (1–50; default 20), ordinal order | 200 `{items,nextCursor?}` | — |
| GET `/build-sessions/{id}/turns/{turnId}` | — | 200 Turn | — |
| POST `/build-sessions/{id}/turns/{turnId}/resolution` | `decision: accept_spec/keep_spec` | 200 Turn | K, V |
| GET `/build-sessions/{id}/spec-revisions/{n}` | nonnegative revision | 200 SpecRevision | — |
| PATCH `/build-sessions/{id}/publish-preferences` | `name`, `shareScope: private/group/company` | 202 PublishResult | K, V |
| POST `/build-sessions/{id}/archive` | `{}` | 202 Session | K, V |

Session/Turn resource responses and PublishResult return the session `ETag`;
Turn creation also returns `Location`. Turns always include `sessionVersion`,
so resolution returns the updated version without introducing a wrapper.
PublishResult is `{desired:{name,shareScope},sessionVersion,sync:{state,failure?}}`.
Session exposes optional `publish:{desired:{name,shareScope},sync:{state,failure?}}`
using the same desired/sync shapes. It is absent until preferences are accepted;
thereafter GET/list retain the last accepted values, including pending or failed
synchronization. `shareScope` remains `private/group/company`; SPA sync states and
failure codes are open observations. The existing `publish_preferences` column
already stores these values and failures, so no migration is required.
There is no cancel operation and no public share scope in this flow.
Every v1 operation declares `Retry-After` on 429 and 503 error responses, including
`artifact_uploads_busy` and temporary service/store failures (design §13).
The server emits integer seconds only: default 2 for an absent/invalid upstream
value, clamped to 1–300 otherwise. Other statuses and successes do not emit it.
This delay never overrides `details.retryable=false` (for example
`artifact_store_unsupported` or `PlatformCapabilityMissing`); those require
intervention rather than automatic retry.

Contract choices where the design left a shape or bound implicit:

- Session requires `groupId`, `locale`, `createdAt`, `updatedAt` in addition to
  its illustrated fields; `archivedAt`, `draftId`, `activeTurnId`, `failure`,
  and `pollAfterMs` are optional observations. Dates are RFC3339 UTC (`Z`).
  Optional `plan:{specRevision,stale}` appears only after a successful plan; `stale` is computed by the server against the current specification revision. Clients must disable creation when stale; direct Platform creation admission is not fenced by Console.
  Generated session/turn IDs are UUIDs; Directory and Platform IDs remain opaque.
- Versions/ordinals are positive and revisions nonnegative safe JSON integers
  (maximum 9007199254740991), including ETags. Revision zero has explicit
  `sourceTurnId: null`; all subsequent revisions require a UUID source.
- `nextAction` is `none/observe/advance/confirm/resume`. Projection state is
  `not_requested/pending/syncing/applied/conflict/failed`; publish sync is
  `pending/syncing/applied/failed`. `appliedRevision` is optional, not fabricated.
  Unknown observed enums become explicit unknown domain values. Writer enums
  and command unions remain closed; unknown Turn kinds are rejected.
- The publish name is nonblank, at most 40 Unicode scalars and one line
  (CR/LF/NEL/Unicode line separators are rejected); it is never inferred.
  Human text bounds use Unicode scalars, not UTF-16 units. Initial intent is
  also limited to 4000 UTF-8 bytes and conversation messages to 16 KiB.
- Reply has exactly the fields of design §6. Text totals include answer,
  summary, changes, option labels/descriptions/messages, open topics/wishes,
  and nextQuestion, excluding IDs. Both option arrays require unique IDs and
  labels. Empty summary is allowed only when `specChanged=false`; required
  human text is nonblank. A changed spec is a proposal, not a committed revision.
- Error envelopes stay `{error,message,details?}`. Typed details may contain
  `field` (JSON pointer), `reason`, `policy`, `currentVersion`, `resource`
  (`session/operation/workspace/artifact`), `retryable`, storage `limit`
  (`files/bytes/entries/depth`), and `observedAt`. Upstream reason strings such
  as `AgentTurnActive`, `WorkspaceNotRunning`, `PolicyPending`,
  `DraftVersionChanged` and `DraftSpecChanged` stay reasons, not error codes.
  Failure codes cover every row in the design's error table plus its
  precondition/session/input/status errors. Optional short text caps are
  128 for reason/policy/prompt version, 256 for field, 512 for opaque IDs,
  2048 for cursors, and 200 for each of at most three safe progress activities.

`cmd/server/internal/api/testdata/build-conversation.json` is the single shared
corpus. Bun and Go enumerate every case (no per-language fixture allowlist),
require every registered Build schema to be represented, and check identical
accept/reject and JSON-pointer paths. It includes APT-752/792 answers/candidates,
mixed edits, undecided names, explicit decisions, repair, open reader enums,
duplicate JSON keys, byte/scalar limits and ETags. Go also decodes accepted
wires into the actual DTOs, marshals them back losslessly, and validates the
writer against the generated schema; adding a schema without a DTO/corpus case
fails. `jsonschema/v6` remains test-only.

Standard JSON Schema cannot express UTF-8 byte totals, keyed uniqueness,
display-text sums or comparison with request/spec bytes. The canonical schema
records those as `x-*` assertions; Zod applies them and the Go parity test
interprets them. `BuildReplyValidationInput` retains the original reply/spec
bytes and typed expected context for S4-2. The strict JSON contract parser
rejects duplicate keys, invalid UTF-8, trailing JSON and depth above eight.
The S4-2 production validator must still enforce YAML/BuildSpec validity,
artifact provenance/digests and semantic evaluation; this slice does not
claim that schema validation proves natural-language correctness. S4-1/3
must enforce lifecycle transitions, one active Turn, authorization, replay
precedence, immutable attempts and transactional confirmation.

Run the web checks listed in `web/package.json`, the DSN-backed server tests/vet,
gofmt on changed Go files, and `go mod tidy -diff`. APT-845 startup tests now wait
on the same bounded readiness condition as `/readyz`; `server-db` includes all
of `go test ./cmd/server/... -count=1`, rather than excluding startup tests.



## NEW-APP conversation server

The S4 server is in `cmd/server/internal/buildsession`. It is separate from
`conversation` because the immutable prompt catalog already depends on the
reply validator; putting the orchestrator in that leaf would create an import
cycle. The twelve internal `/api/console/v1/build-sessions` operations reuse
Console authentication and Directory resolution without the legacy handler-wide
transaction. The served public OpenAPI document is unchanged.

Every request rechecks Platform Project actions and the caller's current Directory
groups. The exact authenticated Authorization value is forwarded; the adapter
has no cookie jar, follows no redirects, and accepts only its configured origin.
Tokens and payloads are not logged or persisted. GET can observe and import a
result, but never dispatches, repairs, wakes, starts a plan, or deletes artifacts.
Those writes require the next authenticated `advance` request.

### Operations: capability floor, rollback and retention

`BUILDER_CONSOLE_NEW_APP_CONVERSATION=off|allowlist|on` defaults to `off`.
`BUILDER_CONSOLE_NEW_APP_CONVERSATION_ALLOWLIST` is a JSON array of
`{"issuer":"…","subject":"…"}` entries, not email addresses.
`GET /config` always includes the caller-resolved boolean `newAppConversation`.
Existing console-v1 sessions and draft resolution remain available when disabled.
`BUILDER_CONSOLE_INSTALLATION_ID` may pin the receipt namespace; the default is
the singleton `builder-console/<configured Project>`. Keep it stable across upgrades.
Prompt registration records `BUILDER_CONSOLE_RELEASE_VERSION`, or `development`
for an unversioned local server; that local label is not release evidence.

Keep `BUILDER_CONSOLE_NEW_APP_CONVERSATION=off` until the estate's Platform
contains the draft contracts from [Platform PR #6723](https://github.com/appthrust/platform/pull/6723):
P1 durable draft-create idempotency, P2 strong ETag/conditional draft update, and
P3 pinned plan input with `expectedSpecSha256`/`inputSpecSha256`.

The Platform `ApplicationStackDefinition` schema supports
`spec.requiredCapabilities` for installed platform components (for example
`appthrust-core`) and `spec.versions[].minPlatformVersion` for the oldest supported
developer contract. `requirements[].satisfiedBy` concerns resolved credential
slots/Ready app links, not Platform API revisions; `provides`/`consumes` are
app-to-app capabilities. None names the draft contracts, and #6723 has no
released Platform version to use as its minimum yet. `catalog/entry.yaml`
therefore keeps its existing fields: no invented capability or version.
**Release-time requirement:** the Console release that first enables this flow
must set `spec.versions[].minPlatformVersion` on its new version entry in
`catalog/entry.yaml` to the first Platform release containing #6723, once that
version exists. Until that prerequisite is known and deployed, keep the flag off;
a catalog declaration alone is not runtime deployment evidence.

Platform does not serve a capability/OpenAPI endpoint, so a pre-offer capability
probe is not possible. If the flag is enabled too early, a missing strong draft
ETag or missing/mismatched plan input digest fails closed with typed
`service_unavailable`, `details.reason=PlatformCapabilityMissing`,
`details.retryable=false`. The process-local negative verdict cache suppresses
new offers for two minutes after the last missing-capability observation.
The first observation outside that window logs:
`NEW_APP_CONVERSATION flag is enabled but Platform lacks the draft contract`.
An incompatible create retains its attributable empty draft on an archived
session with that failure; it creates no workspace and does not delete the draft.
Its resolver remains console-v1. This is an intentional deviation from a pre-offer
deployment proof, not a claim that a response proves every P1 guarantee.

Normal rollback turns the flag off for **new sessions only**. Existing console-v1
sessions remain readable/observable/resumable and keep their resolver binding;
they must not fall back to the legacy engine. Once any console-v1 session exists,
do not roll the binary back below the first release that can read console-v1
sessions (v0.5.5 and earlier cannot). Keep the additive database tables and
specification revisions. A Platform rollback removing P1–P3 also requires stopping
new Console writes, not merely changing the new-session flag.

Retention is an explicit store policy, not an environment variable or background
scheduler: `store.BuildRetention` passed to `Tx.RetainBuildSessions` defaults via
`DefaultBuildRetention()` to `Content=90 days`, `Audit=180 days`,
`FailedOutput=7 days`, `BatchLimit=100` rows per table/window (allowed 1–1000).
**These proposed durations await operator/product approval.** Only ended sessions
without an active turn are eligible. Content expiry clears conversation/attempt
payloads and historical specification bodies, not the current specification or
application metadata; audit expiry removes receipts, attempts and terminal
effects. Outstanding cleanup intents survive. No scheduler is wired, so these
defaults do not promise automatic deletion at those ages. Remote cleanup still
needs a fresh user bearer; backup/etcd retention follows the estate's policy.

External intents and exact prepared AgentTurn requests commit before HTTP.
Replays retain their original keys, bodies, and first HTTP response snapshot.
Definitive initialization failures archive the session; uncertain requests and
authorization failures retain the original recoverable intent. Publication
failures retain typed desired values in failed sync state for explicit retry.
Progress snapshots live separately from imported artifact observations in
`build_turn_progress` (migration 008); unchanged/older observations never bump
the session version. Existing payload retention clears the progress snapshot.

AgentTurn inputs are sent atomically in its `inputs` field, rather than PUT before
runtime startup. Every output path is attempt-scoped. A successful phase alone is
insufficient: outcome and declared outputs must agree, followed by digest and
Reply validation. Only validation errors can cause one repair. Changed specs
remain proposals until `accept_spec`. Planning pins the confirmed revision using
conditional PATCH, readback, then conditional generation admission. No cancel API
or background service identity exists.

Resource creation remains Platform-owned. Console observes created resources
and stops spec work even if another client created a stale plan. It preserves
the confirmed spec and successful plan revision; the UI identifies this case as
`lifecycle === "created" && plan?.stale`. A directly issued Platform creation
request is not fenced by Console; strict admission would require another
Platform input-hash contract. The legacy proxy also does not consult Console
draft bindings: Platform remains responsible for authorization on that route.
The v1 resolver never falls back to legacy for an inaccessible Console binding.
Legacy non-v1 handlers retain the existing 60-second Directory authorization
view cache: membership changes, including revocation, can remain stale for up to
60 seconds there. V1 handlers read fresh Directory groups per request and recheck
current Platform actions. This integration does not change the legacy cache.

If creation is observed after an AgentTurn POST answer was lost and no operation
ID was recorded, deleting the runtime cannot be proved safe. A terminal cleanup
effect records `{"state":"withheld","reason":"OperationIdentityUnknown"}` and one
bounded operator warning; it does not occupy the pending-effect slot or make the
created session fail. The Session contract has no non-fatal retained-resource
note. Publication and archive remain usable. Idle policy can sleep compute but
does not delete the volume. Explicit Platform draft deletion cleans up associated
draft workspaces; alternatively a later user request may delete the dedicated
workspace if its operation becomes observable and terminal. No identity search,
new model execution, cancellation, or background cleanup is invented.

Platform adapter requests (same caller Authorization, never Cookie; paths below
are relative to `/api/v1/projects/{projectId}`):

| Method / path | Additional headers / purpose |
| --- | --- |
| GET `/access` | Current membership and compute/workload actions |
| GET `/application-drafts/creation-tools` | Safe prompt capability facts |
| POST `/application-drafts` | `Idempotency-Key: bs/{session}/draft/0` |
| GET `/application-drafts/{draft}` | Strong ETag and exact draft observation |
| PATCH `/application-drafts/{draft}` | `If-Match`, fixed spec/publication key; typed spec/title or publication body |
| POST `/application-drafts/{draft}/creation-plan-generations` | Fixed `bs/{session}/plan/{turn}` key, synchronized `If-Match`, `expectedSpecSha256`; no conversation workspace ID |
| POST `/dev-workspaces` | `bs/{session}/workspace/0`; draft scope, unattended policy |
| GET `/dev-workspaces/{workspace}` | Verify dedicated association before deletion |
| POST `/dev-workspaces/{workspace}/restart` | Attempt-bound fixed wake key |
| DELETE `/dev-workspaces/{workspace}` | Fixed dedicated-workspace deletion key |
| POST `/dev-workspaces/{workspace}/agent-turns` | `bs/{session}/turn/{turn}/attempt/{0,1}`; persisted prompt/inputs/outputs/timeout |
| GET `/dev-workspaces/{workspace}/agent-turns/{operation}` | Exact operation observation |
| GET `/dev-workspaces/{workspace}/files/{path}` | Bounded bytes and SHA256 ETag |
| DELETE `/dev-workspaces/{workspace}/files/{path}` | Known attempt-scoped paths, fixed cleanup key |
| PUT `/dev-workspaces/{workspace}/files/{path}` | Full-byte replacement adapter; normal inputs use AgentTurn POST instead |


## Container and runtime

```sh
NODE_AUTH_TOKEN="$(gh auth token)" docker build --platform linux/amd64 \
  --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN -t builder-console-local .
```

The build uses a BuildKit secret for npm authentication and plain `go mod download`.
The distroless image contains `/builder-console-server` and the SPA at `/srv/console`,
runs as UID 65532, and listens on port 8080. No JavaScript runtime or database is
required during the image build.

Platform supplies `PLATFORM_API_URL`, `PLATFORM_PROJECT_ID`, and OIDC identity
configuration through the Go SDK. Runtime-specific settings include:

| Setting | Purpose |
| --- | --- |
| `BUILDER_CONSOLE_DATABASE_URL` / `DATABASE_URL` | PostgreSQL connection (the prefixed value takes precedence). |
| `BUILDER_CONSOLE_PUBLIC_URL` | Required production HTTPS origin, `https://console.<project-domain>`, for the management Origin guard, CSP and access-request redirects. |
| `BUILDER_CONSOLE_DIRECTORY_URL` | Internal Directory dependency URL. |
| `BUILDER_CONSOLE_DIRECTORY_PUBLIC_URL` | Public Directory URL for user-facing links. |
| `BUILDER_CONSOLE_STATIC_DIR` | SPA directory; defaults to `/srv/console`; `--static-dir` overrides it. |
| `BUILDER_CONSOLE_DEV_SEED=1` | Explicit development-only app fixture seeding. |
| `BUILDER_CONSOLE_RELEASE_VERSION` / `BUILDER_CONSOLE_ARTIFACT_DIGEST` | Identity reported by `/releasez`. |

`--listen` defaults to `:8080`. `/healthz` reports liveness; `/readyz` gates database
readiness. The SDK's existing issuer-less development mode requires a loopback
listener. In that mode an explicit loopback `BUILDER_CONSOLE_PUBLIC_URL` may use
HTTP or a development port; an absent value trusts no browser origin. The Platform
proxy still refuses forwarding without a configured OIDC verifier: decoding
unsigned local-development claims is not authentication.

### Operations: management origin and preview rollout (APT-798)

Production startup fails if `BUILDER_CONSOLE_PUBLIC_URL` is missing or invalid.
The shared origin parser rejects userinfo, paths (including `/`), query, fragment
and malformed hosts. Production requires the `console.<project-domain>` hostname
and the default HTTPS port (`:443` is normalized); other ports are rejected.
Neither `Host`, forwarded headers, the IdP issuer nor `PLATFORM_API_URL` supplies
the Console's public origin. Existing installations receive the value through
catalog rerender/upgrade: `publish.hostnameLabel: console` and
`releaseIdentityEnvPrefix: BUILDER_CONSOLE` already generate it.

`/api/console/*` and the `/api/*` Platform proxy share the same exact-origin
guard. Mutations from sibling apps, preview hosts, the Dashboard, `null`, duplicate
or malformed Origins receive 403 `request_origin_not_allowed`, even with a valid
bearer. Missing Origin with any Cookie or `Sec-Fetch-*` header (including empty
fields) receives 403 `request_origin_required`. Ordinary GET/HEAD/OPTIONS retain
their authentication/CORS contracts; every WebSocket upgrade requires the exact
Console Origin, including non-browser clients. `/authz` remains the dedicated
edge authorization check, not a general mutation bypass.

The Platform proxy first checks the original metadata, then verifies the OIDC
user bearer with the configured issuer, audience, signature and expiry. Invalid
or missing credentials return 401 `unauthenticated`; identity outages or a
missing verifier return 503 `identity_unavailable`. Access Assertions are not
forwarded. Only then are Cookie, Origin, all `Sec-Fetch-*`, `Forwarded`,
`X-Forwarded-*` and `X-Real-IP` removed. Ordinary HTTP reaches the Platform as a
verified-bearer server-to-server request. A legitimate WebSocket gets the validated
`PLATFORM_API_URL` origin as its upstream Origin so it passes the Platform's
Dashboard-only upgrade guard. The local Console API keeps its original metadata
and existing identity/authorization handlers. Do not ship stripping or Origin
replacement without the guard and real verification. The edge must preserve
Origin, Cookie and Fetch Metadata until these checks, and management cookies must
remain host-only.

Management pages, including the SPA viewer at `/-/workspaces/{id}/preview`, send
`Origin-Agent-Cluster: ?1`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
no-referrer`, and CSP with `frame-ancestors 'none'`, `object-src 'none'`,
`base-uri 'self'` and `form-action 'self'`. Scripts/default resources stay
same-origin; inline styles and same-origin/data/blob images support the existing
SPA. `frame-src` and `connect-src` permit `'self'` plus exactly
`https://*.<project-domain>`, derived only from the configured Console hostname.
**Approved §7 deviation:** CSP cannot express a partial-label `pv-*` wildcard;
this static policy additionally permits sibling apps of the same Project. It
does not authorize a preview or prove isolation. Isolation relies on separate
origins, the grant's audience/publication binding and the verifier's CORS/cookie
rules. No estate-wide wildcard or broad `https:` source is allowed. Preview
documents' own sandbox/CSP and HMR policy belong to the preview edge, not this
management-page CSP.

Release in this order:

1. Rerender/upgrade installations lacking the generated public URL. Deliver this
   Console's guard, bearer verification and metadata handling together. The
   Platform can still run `PLATFORM_API_MANAGEMENT_ORIGIN_MODE=observe` (the
   temporary default); the new `http-sessions` and dedicated JWKS route always
   enforce their contracts.
2. Switch the installation's Platform API to
   `PLATFORM_API_MANAGEMENT_ORIGIN_MODE=enforce`. This Console already sends the
   required HTTP and WebSocket metadata in either mode.
3. Enable slice I's new viewer only after the dedicated signer/JWKS, grant API,
   fixed workspace endpoints, verifier and Gateway publication are ready.
   This server introduces no viewer-enablement flag or guard bypass.
4. After every Console is upgraded and the new path is accepted, retire all
   legacy preview paths/aliases and remove the temporary migration settings with
   that retirement. Viewer delivery alone is not M1 isolation completion.

The catalog's `minPlatformVersion` is unchanged: the public-URL renderer already
exists and this server change does not introduce a new Platform capability.
The integrated viewer release must be gated on the Platform release containing
the APT-798 grant/read-model, dedicated JWKS and publication/verifier contracts,
plus successful `enforce` rollout; choose its concrete version when that Platform
release is assigned, not a speculative version here. The Go dependency pins
appserver-go origin-guard commit `7c1b15e3dde1` by pseudo-version
`v0.5.2-0.20261114101934-7c1b15e3dde1` (no local replacement).

Rollback must fail closed, never restore stripping-only forwarding or the old
same-origin preview. Development workspaces/preview remain internal-only until
stage 2's dedicated site is delivered; stage 1 and this CSP do not open the
external-user release gate.

## Publication

Only a `v<semver>` tag starts publication. The initial standalone release is
**v0.3.0**, stream **0.3**, at `ghcr.io/appthrust/builder-console`. Do not reuse
`0.1.0` or `0.2.0`: both served Platform-image floors remain verbatim in the committed
catalog entry. The publisher retains their images, merges persisted release history,
keeps earlier versions served, and makes the new version the only default.

The workflow builds `linux/amd64` and `linux/arm64`, signs the image index with
GitHub OIDC/cosign, then submits the catalog entry to Cloud. A queued publication is
observed directly; a snapshot-only response triggers Cloud publication with the
repository's GitHub App credentials. Success requires the exact version/image digest
in the signed catalog artifact, not merely a successful dispatch.

Required repository secrets: `CLOUD_CATALOG_ADMIN_TOKEN`,
`APPTHRUST_GITHUB_ACTIONS_APP_ID`, and `APPTHRUST_GITHUB_ACTIONS_APP_PRIVATE_KEY`.
Optional variable: `CLOUD_API_URL` (defaults to `https://api.appthrust.com`).
`GITHUB_TOKEN` needs package read/write access to install the published npm SDKs and
push the app image. No secrets belong in this repository.

Existing installations using the Platform image path require one explicit update to
`0.3.0` with `replaceRepository: true`; future updates can follow stream `0.3`.
An initial source push does not create a release, publish a catalog, or modify an
installation.
