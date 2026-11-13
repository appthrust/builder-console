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

### Console response contracts (APT-832 / W1)

`web/src/api/contracts/console/schema/` is the canonical Zod source for Console
success wires and the HTTP error envelope. `operations.ts` in that directory
registers all 33 SPA operations, including `/config`, screenshot multipart
responses, and the three 204 deletes. Adapters in the parent directory reuse
those schemas and expose the domain types in `model/contracts/console.ts`.
Feature migrations remain separate; this slice does not replace the unverified
facade's callers.

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
| `BUILDER_CONSOLE_PUBLIC_URL` | HTTPS console origin for access-request redirects. |
| `BUILDER_CONSOLE_DIRECTORY_URL` | Internal Directory dependency URL. |
| `BUILDER_CONSOLE_DIRECTORY_PUBLIC_URL` | Public Directory URL for user-facing links. |
| `BUILDER_CONSOLE_STATIC_DIR` | SPA directory; defaults to `/srv/console`; `--static-dir` overrides it. |
| `BUILDER_CONSOLE_DEV_SEED=1` | Explicit development-only app fixture seeding. |
| `BUILDER_CONSOLE_RELEASE_VERSION` / `BUILDER_CONSOLE_ARTIFACT_DIGEST` | Identity reported by `/releasez`. |

`--listen` defaults to `:8080`. `/healthz` reports liveness; `/readyz` gates database
readiness. `/config`, `/launcher`, `/launcher/entries`, `/api/console/*`, `/authz`,
and the `/api/*` Platform proxy retain their existing contracts.

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
