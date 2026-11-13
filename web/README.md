# Builder Console

The in-Project console for non-engineer users: build an internal app from a
business template, an AI consultation, or an existing repository; publish it
to a part of the organization; find and open apps. Served by
[`cmd/server`](../cmd/server) as the standalone `builder-console` built-in app.
See the [repository README](../README.md) for builds and publication. Product design: Nexus Vault
`50-projects/appthrust/features/builder-console/ux-design.md`.

## Layout

- `src/routes/` — code-based TanStack Router tree. Static reserved routes
  (`/`, `/mine`, `/company`, `/help`, `/new`, `/-/account`, `/-/admin/*`), the `/-/apps/$appId`
  permalink, and a `$` splat that resolves GitLab-style
  `<group-path>[/<app-slug>][/-/<sub>]` through `/api/console/resolve` in the
  loader. Code-based because the file router excludes `-`-prefixed files.
- `src/features/{discover,create,excel2app,app,admin}/` — pages; `create/ai/` is the
  plan-generation chat; `create/templates.ts` holds the business template cards
  joined against the platform catalog (`category: business`). `build/` is the
  AI build session (`/-/build/{id}`); `improve/` is the AI improvement session
  for a live app (`/-/improve/{id}`); `excel2app/` turns an Excel ledger into
  an editable specification (`/-/excel2app`).
- `src/model/` — pure status/progress/share/create derivations with tests.
- `src/api/` — `console.ts` (`/api/console/*`), `queries.ts` (TanStack Query
  factories), `platform-error.ts` (Platform API error envelope: `OpenAPILink`
  puts the HTTP body under `ORPCError.data.body`).
- `src/ui/` — the console's own kit (Radix + lucide): dialogs that return focus,
  `useDocumentTitle`, `useUnsavedChangesGuard`, `Stepper`, `DataTable`.
- `src/dev/` — the mock console + platform API used by `bun run mock`.

## Publication readiness when creating apps

`/new` distinguishes a missing publication domain from a configured domain
waiting for readiness. The domains API reports `ProjectGatewayPending` in
`publishUnavailableReason` when the project Gateway has not converged; runtime
capability observation can similarly report `PublishRuntimeCapabilityPending`.
The console shows a preparing message and polls create connections every ten
seconds while no usable domain exists and a managed publish base has either
pending reason. When a domain becomes usable, the existing AI/template controls
become available without reloading and polling stops. Missing or unsupported
configuration still shows the setup guidance, without readiness polling.


## Excel から作る

`/new` → 「Excel から作る」 follows five steps: Excel を集める → AI の解析 →
仕様書 → UI プレビュー → 実装. Collect 1–20 `.xlsx`/`.xlsm` files with a
multi-file picker or a folder drop; hidden paths and Excel owner files (`~$*`)
are skipped. Each file has its own parse/save state and remove action. Failures
do not prevent the remaining files from being collected. The counter shows
persisted grid bytes, files and sheets against the shared API limits.
Add an optional hint, then explicitly press 「N 件のファイルを読み取る」.
Samples store their whole set and start immediately, including two monthly
order ledgers and a separate customer master. If a sample member cannot be
stored, collection stays open with the error rather than silently starting with
an incomplete sample.

The result is one business design: entities merge compatible ledgers, refer to
masters across files, and retain their source sheets and column mappings. The
analysis screen shows flows, entity sources, findings to confirm and collapsed
per-file readings. The preview maps rows from every entity source, including
master labels from other files; chat instructions such as 「一覧をカード表示に」
update that design.

This is a server-backed ApplicationDraft flow, using the same draft-scoped
DevWorkspace and Codex sidecar as 「AI と作る」:

- The browser parses and stores files sequentially through
  `POST /api/v1/projects/{projectId}/application-drafts/{id}/workbooks`, with a
  stable per-file `Idempotency-Key` retained across a failed save and retry.
  A draft is created only after the first file parses; a failed first POST
  deletes that new draft or retains it for reuse when cleanup fails.
  Binary files are never uploaded. The draft's source contains ordered workbook
  summaries and a membership `revision`; grids are separate immutable artifacts.
- Starting PATCHes the set's title and intent, then submits one conversation turn
  with `kind: 'excel-analysis'` and the hint. The staged turn reads byte-bounded
  batches and then designs one integrated `excelAnalysis` and `specMarkdown`.
  The page polls the draft and shows its persisted `excelProgress`, not a timer.
  A failed turn keeps completed readings; 「続きから読み取る」 submits a new turn
  that reuses those readings. A 412 stays an explicit unavailable notice.
- The editor hides the specification's front-matter and saves body edits on
  blur or 「次へ」 through the draft PATCH endpoint, preserving that metadata.
  Preview initialization sends a `kind: 'ui-design'` turn with message
  `__init__`; later chat instructions use the same turn kind. The server's
  `uiDesign` and assistant message drive the preview and chat.
- Implementation keeps the same draft and opens `/-/build/{id}`, with
  `## 9. 画面の決定` in its saved `specMarkdown`. It does not create a second
  draft or send the specification through a new `/new` intent. The build
  session offers 「この内容で提案して」 without replaying Excel/UI-design chat.

The running app preview on the build page is different from step 4's design
preview: it runs without a database. In every preview state, unpublished
apps whose plan includes a database show a notice explaining this limitation;
Excel apps explicitly say that the imported data appears after publication.
The notice is hidden after publication and for plans without a database.

`/-/excel2app?draft={id}` resumes from persisted state: no source, or a set with
no analysis turn since its revision, returns to collection with the stored list.
An analysis turn without a result resumes analysis; an analysis without a
UI-design turn resumes the specification; any current UI-design turn/design
resumes preview. Reloading the implementation summary also resumes preview.
In-flight turns are observed, not resubmitted. Adding/removing a member after
analysis asks for confirmation, clears the integrated analysis and screen
decisions, and retains readings of unchanged members. Turns older than
`source.revision` no longer contribute to analysis, resume or design history.
Binding a draft just created by this page to its `?draft=` URL keeps the active
flow, including per-file failures and analysis admission notices (412 or
`ApplicationCreated`). Navigating to another draft starts a fresh flow. An
analysis request opens the analysis step even when admission rejects it before
creating a turn; reload still follows the persisted-state resume rule above.

The reader samples the first 5,000 Excel row coordinates per sheet; additional
populated rows set the optional `truncated` flag surfaced in the UI and
specification. Parsed workbook JSON is limited to 512 KiB per file; the set is
limited to 4 MiB and 200 sheets. These budgets come from
`ApplicationDraftWorkbookLimits`, never from the compressed file sizes. Hidden
and very-hidden sheets are omitted from inference but can supply validation
choices. `.xlsm` files are accepted without loading or executing VBA.

The local mock runtime (`src/dev/mock-platform.ts`) implements the same
workbook and turn APIs with deterministic heuristics. With the default manual
lifecycle, acknowledge each turn POST before `POST /api/v1/__mock/advance`;
alternatively, `POST /api/v1/__mock/plan-generation {autoAdvance: true}` lets
draft/turn GETs advance it. The browser uses local heuristics only when the
project reports `codexAvailable=false` and the user chooses the explicitly
labelled 「AI なしで続ける」 fallback, not after an arbitrary API failure.
The creation-tools response also exposes `codexUnavailableReason` and
`codexPolicy`; policy reasons keep the AI entry visible but disabled with a
policy explanation and the policy name when available, rather than hiding it.
Policy rejections from AI operations use HTTP 412 `failed_precondition` with
`details.reason` and are shown as non-retryable policy failures.
Workbook grid/DTO conversion lives in the pure `features/excel2app/model.ts`;
E2E fixtures use it without importing the React draft hook or browser API queries.

That per-tab choice survives reload. The fallback fetches every member grid and
uses `designFromReadings` to produce the same integrated entity model, then
`excelSpecMarkdown` to save its specification. It is local (not persisted as
`excelAnalysis`); a missing grid prevents an invented or partial result.
The local preview design resets to its default on reload; its decisions are saved
into the specification when proceeding to implementation.

Implementation reconnects interrupted task streams for up to ten minutes and
records a stable failure reason if it cannot resume; the console uses that
reason before legacy error text and explains when retry continues the stopped
task. Every task reports its
acceptance-criterion checks, gets at most one repair pass, and leaves any unmet
criteria visible while the run continues. Plans, specifications and chat use
business wording rather than implementation file names or identifiers.
Step 5 and the build preparation Q&A save the publish name and audience as
draft `publishPreferences` (alongside title alignment), so a new tab skips
answered preparation questions
and defaults the publish dialog to the same scope; all three surfaces share
the same audience labels, including the owner group's name.
Its import count, like the build page's, sums `entities[].importRows`, not raw
source rows, headers or summary sheets. 「元のデータ」 names a single workbook,
or the first plus the number of other files and total sheets in the set.
Once `createdApplicationId` is set, Excel analysis and UI-design turns return
409 `ApplicationCreated`: the console keeps analysis, specification and preview
readable, disables editing, and links to the build page. A creation race shows
the same read-only notice.
Build retries use the draft's stack ID without waiting for the console-app
binding, and show a pending state until they can act. The opening build
message shows only the user's intent, without the console's appended reply
sections or publication marker.

AI allowance failures keep a manual retry for analysis, UI chat, build conversation,
plan generation and implementation. Ask the administrator to restore the allowance,
then retry to resume the failed work; implementation preserves completed tasks and
does not offer task skipping for quota failures. Plan generation never retries quota
failures automatically. This is not an Excel or input problem.

To exercise recovery locally, `POST /api/v1/__mock/ai-quota {exhausted: true}` makes
AI work fail with the provider's “You have no credits remaining” message on advance.
Set `{exhausted: false}` before pressing retry; `__mock/reset` also clears it.

The authoritative contract and runtime documents are described in
`design/platform/builder-console-excel2app-workbook-set.md` and
`design/platform/builder-console-excel2app.md`.

`e2e/stories/app-create-excel2app-set.mock.spec.ts` covers explicit collection,
reload before analysis, merging two ledgers, cross-file references, rows from
both months in preview and hand-off. Regenerate its three deterministic fixtures
with `python3 e2e/stories/fixtures/generate-excel2app-set.py`. The sparse ledger
fixture remains generated by `generate-excel2app-ledger.py`.

## Wording and language

The console is Japanese by default and switchable to English from
`/-/account` (user menu → アカウントの設定). The choice is the
`appthrust-language` cookie shared with the Dashboard; the browser language is
not consulted. `src/shell/language.ts` owns the store (`useLanguage`,
`currentLanguage` for code outside React, `locale()` for `Intl`/`toLocale*`).

No screen hardcodes user-facing text. Every catalog is a Japanese tree that
owns the keys and function signatures, an English sibling typed
`typeof <ja tree>` (a missing key is a compile error), and one export joined
with `localized({ ja, en })`, which resolves the current language on each
property access so `text.section.key` call sites and model code need no hook:

- `src/copy/{shell,apps,sharing,access-request}.ts` + `.en.ts` → `copy` (`src/copy.ts`);
- feature/model-local catalogs: `src/features/*/copy.ts`, `src/features/app/data/copy{,-write}.ts`,
  `src/features/build/implement/copy.ts`, `src/model/build/copy.ts`, each with its `.en.ts`.

Switching remounts `<RouterProvider key={language}>` (`src/main.tsx`), so
component-local state is dropped on a switch. Tests run with the default
(`ja`) and assert Japanese wording; reference `textJa`/catalog values rather
than new literals. Data from the platform (group and app names, AI-written
plans, table labels from AI column comments) is shown as written; the AI
prompts in `platform-api` still produce Japanese labels.

## Development

Run these commands from `web/` after the authenticated install described in
the repository README:

```sh
bun run mock            # mock console + platform API (CONSOLE_MOCK_PORT, default 54385)
bun run dev             # vite (CONSOLE_PORT, default 5199); /api is proxied to the mock
bun run typecheck && bun test src
```

`bun --watch src/dev/mock-server.ts` restarts the mock when `src/dev/*`
changes (a restart drops in-memory mock state).

Test files share the local `test/dom.ts` preload and must not depend on file
order. Restore the exact previous descriptors when replacing globals, and use
`test/language.ts`'s `preserveLanguage()` before changing the language. The
preload does not install storage globals. Shell state imports use defaults when
`localStorage` is absent; browser imports still read saved choices.

### Against a real backend

The vite proxy can target a real console instead of the mock
(`vite.config.ts`):

| Upstream | Env | Auth |
|---|---|---|
| Local `cmd/server` | `CONSOLE_API_UPSTREAM=http://127.0.0.1:8080` | `CONSOLE_DEV_BEARER=<Keycloak access token>` (expires in minutes) |
| A deployed console behind its OIDC edge | `CONSOLE_API_UPSTREAM=https://console.<project>.<base>` | `CONSOLE_DEV_COOKIE_FILE=<file>` holding the browser session's `Cookie` header (the edge does not accept a bearer). The file is re-read per request; rotate it from an authenticated browser session every few minutes because the access cookie expires. |

Treat a deployed upstream as read-only: use the mock for mutations and edge
states. The deployed upstream is what catches contract drift the mock hides
(for example server `omitempty` arrays arriving as `undefined` while the
schema declares a default).

### Mock toggles

`POST /api/v1/__mock/...` (platform) and `POST /api/console/__mock/...`
(console) switch states for browser checks; see the comments at the top of
`src/dev/mock-platform.ts` and `src/dev/mock-console.ts` for the current list
(`role`, `registry`, `codex`, `stack-conflict`, `github-repository`,
`plan-generation`, `implementation-run`, `logs`, `bare-500`, `app-draft`, ...).

### Browser stories

`e2e/stories/*.mock.spec.ts` drive Chromium through the SPA against the
in-memory mock. Playwright starts its own mock (`CONSOLE_E2E_MOCK_PORT`, default
54395) and Vite (`CONSOLE_E2E_PORT`, default 5209):

```sh
bun x playwright install chromium   # once per @playwright/test version
bun run typecheck:e2e
bun run test:e2e:mock               # every @mock story, one worker
bun run test:e2e:mock -- e2e/stories/app-delete.mock.spec.ts   # one file
```

`APPTHRUST_E2E_REUSE_SERVER=1` reuses servers you already started (ignored in
CI). Reports: `playwright-report/` (HTML), `test-results/junit.xml` and
`test-results/results.json`; failure screenshots and traces under `e2e/results/`
(`bun x playwright show-trace <trace.zip>`). There are no retries and
`test.only` fails the run. Each test has 30 s; a story that needs more calls
`test.setTimeout` (at most 120 s).

CI (`console-mock-stories`) runs the same command in the
`mcr.microsoft.com/playwright` image of the locked Playwright version, rejects a
report with no executed test, a skipped/fixme test or a story file without an
executed `@mock` test, and uploads the reports. Bumping `@playwright/test` in
`bun.lock` requires the matching image tag and digest in `.github/workflows/ci.yml`.

Import `test`, `expect` and helpers from `e2e/support/fixtures.ts` only. For
every test it automatically:

- resets both mocks before the test (no need to request the `mock` fixture);
- watches every page, popup and iframe of the browser context from before the
  first navigation, and fails the test at teardown when it saw any of:
  `console.error` (warnings are only counted); an uncaught exception or
  unhandled rejection; a transport failure (`requestfailed`); an HTTP 4xx/5xx
  response for any request (API, document, script, style, image, preview);
  the shared error boundary (`data-testid="console-error-boundary"` in
  `src/routes/root.tsx`) being inserted, even if a retry replaced it before the
  end; text nodes rendering `undefined` or `NaN` at the end of the test.
  The 404 page, 「権限がありません」 and 「準備中」 states are ordinary UI and not the boundary.

The failure lists each problem with its URL, method and status or message
(never request or response bodies); the `browser-problems` attachment keeps the
same list plus counts of console warnings and of GETs the page ended itself.
Three such endings are not transport failures, although Chromium reports them as
`net::ERR_ABORTED`: a read the page aborts through its own request signal with no
timeout (a query cancelled when its last observer unmounted, such as `/launcher`
when the shell re-renders, or before a cache write) is the page deciding it no
longer needs the answer; the Vite dev server runs React StrictMode, which mounts every
effect twice, so the first `/launcher` read or preview probe of a page is aborted
in the same task that started it and sent again; and the preview probe cancels
the body after reading the status (the status itself is still judged). A
navigation scope covers each test-driven `page.goto`, `reload`, `goBack`,
`goForward` and `close` (until the call returns) and each main-frame document load such as a
followed link (until the new document commits): a GET/HEAD the replaced document
started before the navigation landed may be cut off during it. A GET of an iframe
the page removed while it loaded is not a failure either. A probe aborted by its
timer, a read timeout, an aborted
write, a failed document load and any other `net::ERR_ABORTED` is a problem
unless declared.

A story that provokes a failure on purpose declares it around the action that
causes it:

```ts
import { test, expect, withExpectedFailures } from '../support/fixtures'

await withExpectedFailures([{
  method: 'PUT',
  path: '/api/v1/projects/{projectId}/publishes/{publishId}/access',
  status: 403,           // or transportError: 'net::ERR_ABORTED'
  count: 1,
  reason: 'Team Viewer cannot change publication access',
}], async () => {
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByText('基盤の編集権限（Team Editor）が必要です')).toBeVisible()
})
```

`path` is the URL pathname with `{name}` for one segment (or a RegExp). The
declaration is one test step and applies only while its action runs: exactly
`count` matching responses must occur inside it (one missing or one extra fails
the step), and the same failure outside it is a problem. After the action the
scope stays open until each declared response has arrived (up to 10 s), so the
count never depends on the UI rendering before the response event; make the
action wait for the UI that shows the failure. Console errors and other failures inside the
step still fail the test. Polling failures need a deterministic count: hold or
release the route explicitly instead of counting timer ticks.

Every declaration is an exact count except one: the create wizard's URL-name
probe (`freeUrlNameChecks(moments)` in `e2e/support/fixtures.ts`). The wizard
checks a name when it proposes one, when the name field is left and on 次へ, and
次へ joins a check of the same name that is still running. How many `GET
/api/console/resolve` 404s that produces depends on machine speed (CI saw two
where a local run saw three), so this probe accepts one up to the number of
distinct moments the flow can check. What matters is asserted exactly instead:
`continueToShare` waits for the 404 of the final name itself, so the wizard never
moves on without a completed check of the name it shows. Do not use a range for
anything else.

## Japanese UI copy

Copy lives in `src/copy/*` and the per-feature `copy.ts` files. Render it
through those keys, not inline literals: a hard-coded `作るを続ける` once
drifted from the existing `resume` key (`続きから作る`) for the same link.
Vocabulary follows the product design (ux-design §4): plain words for
non-engineers, with engineering words only under 「詳しい人向け」
(`src/model/build/wording.ts` hides them in model-written text).

- **Product terms are deliberate.** 置き場 (repository), 下地 (prepared app
  base), 版 (release), 出す (ship a version), 作れる人 (creator role). Keep
  them. Quote a role or screen name with 「」 inside a sentence:
  「作れる人」に登録されていません.
- **Grammar.** A verb cannot take を: 続きから作る, not 作るを続ける.
  入力する and 失敗する take に: 「名前」に入力した内容,
  下地の組み立てに失敗しました. Prefer 数値 over 数, and
  先頭と末尾は英数字に over 英数字で始めて終えて.
- **Composed strings.** A template argument is often a complete phrase:
  `shareSentence()` returns 全社に公開 / 自分だけに公開 / 営業1課 に公開.
  Append a verb to such a phrase (`${share}します`). Never put a particle
  after it: `${share}で作ります` rendered 全社に公開で作ります. Before
  shipping a template, read it with every value its arguments can take.
- **Parallel labels.** Option cards in one group read as parallel phrases
  (AI と作る / 作ったコードから / コンテナイメージから). Placeholders say
  what to write (変えたいところを書く).
- **Punctuation.** If a string has 「。」 inside it, it also ends with 「。」.
  Exceptions: strings that end in 「？」 or in an 「例: …」 example. Quote UI
  labels and values with 「」, never 『』.

## Contracts worth knowing

- A bound app's `stackId` selects its Platform stack once. Status, version,
  release-state, logs, and environment settings use that stack's explicit
  `branchId` and `webComponentId`; another stack sharing the Application ID
  (including an older/recreated stack) must not replace the binding.
  `Application.sourceId` identifies the Application's creation source, not
  the Console app's binding. The recreated-stack release story exercises
  both the HTTP scope and the version label in the app header.
- Platform API 409s carry `details.reason`; `delivery_pending` means "retry
  the same request", not "name taken". Read envelopes through
  `platformErrorEnvelope`.
- Private/group publication uses `externalAuthorization.appInstallation` with
  `builder-console`; the request type, model and mock follow the Platform API
  contract. Retired authorizer keys are rejected with HTTP 400 and a migration
  hint, not accepted as aliases.
- A failed access write is shown as failed in the sharing dialog, app header,
  settings and creation progress. If the observed policy is still public, the
  failure label explicitly warns that anyone can still access the URL.
  Closing the dialog does not clear the failure; a successful apply clears it.
  Console share metadata is updated only after the Platform access write succeeds.
- Draft, draft-list, and individual app reads retry HTTP 500/502/503/504
  (including coded errors), network failures and read timeouts up to five times
  after 3, 6, 12, 24 and 30 seconds. HTTP 4xx answers are not retried.
  Initial reads stay loading until these attempts settle. TanStack Query keeps
  successful data for the same key during failed polls; build/draft pages show
  a load-error card only when no data has loaded, never in place of cached work.
  Data from another draft, app or project is not used as placeholder data.
- API requests use manual redirects: an edge 401, OIDC redirect (including an
  opaque cross-origin redirect), or successful HTML login page ends the local
  session instead of masquerading as an API result. Platform and Console/Directory
  requests share this check. The page shows 「セッションが切れました。再サインインしてください」
  and a 「再サインイン」 action; query observers are removed and further API calls
  are blocked until sign-in. The action navigates to the same URL through the edge,
  preserving the draft and its session storage. There is no automatic redirect
  loop or never-settling authentication promise.
- A successful build kickoff resumes plan generation from the draft even when
  session storage is absent. A queued kickoff also persists its plan reservation
  atomically. An idle conversation without a plan has a visible 「この内容で提案して」
  primary action rather than a fake progress state. The handoff reads the draft
  under the existing mutation lock and uses an idempotency key bound to the latest
  turn and prior generation; an already accepted/current plan is not recreated.
  Active draft polling continues while the tab is hidden (subject to browser
  suspension); normal focus refetch catches up after resume.
- A source repository kept from a failed create attempt is reused only when
  its origin (URL name, entry, picked repository, template) matches the retry.
- AI build sessions default an absent/disabled plan publish to the wizard's
  `pickCreateEnvironment(...).domain`, using the application's name as the
  wildcard subdomain. Enabled publish destinations are preserved; a rename
  updates the subdomain. The default is persisted before creation starts and
  never replaces a plan after a creation execution exists.
- Reopening a created build session repairs a missing production web publish
  through `POST /projects/{projectId}/publishes`. It uses the bound stack's
  branch/web component and the same project domain, with a stable HTTP
  `Idempotency-Key` across retries and visits. A missing domain leaves the
  current behavior unchanged. Opening an app page directly does not trigger
  this repair. The old persisted one-shot reservation is no longer used.
  Both publish repair and automatic creation-access setup treat 409
  `builtin_app_not_ready` and 412 `failed_precondition` with reason
  `ApplicationBranchRuntimeMigrationInProgress` or `OrganizationRenameInProgress`
  as preparation: no error notice, retries after 30 s, 1 min, 2 min, then every
  5 min while mounted; a later visit resumes repair. After four pending answers
  the build page quietly says 「公開の準備がまだです。自動で続けます」.
  Manual actions with those same typed waits show a temporary notice in the
  selected language: the platform is updating; wait a minute or two and press
  again. They do not show a failure heading or the raw server message.
  Other failures retain their existing error behavior; creation-access
  `delivery_pending` retains its existing 3 s / 20 retry policy. Generic
  placement/port/identity preconditions are not treated as transient because
  they also cover missing configuration and mismatched identities.
  Mock `plan-generation` accepts `{ publish: false }` to exercise the omission.
- Implementation runs belong to Platform API. Start/retry POST
  `application-drafts/{id}/implementation-runs` without a body; skip sends
  `{ skipTaskIds: [id] }`. A change cancels an active run first, then starts
  `{ change: { taskId, message } }`. A 409 observes the existing run.
  The draft and draft-list queries poll every three seconds while its latest
  run is pending/running. Closing or reloading a tab does not cancel execution,
  create another workspace, or replay a task. Codex, document synchronization,
  commits, retry backoff, leases and recovery are exclusively server-owned.
  There is no browser-local task state; conversation/UI session storage remains.
  The preview reads `run.devWorkspaceId` through the workspace GET. Workspace
  Ready and the `PreviewReady` condition describe containers, not an HTTP-serving
  app: before mounting the iframe, the console probes the same-origin preview
  URL with GET every four seconds until it returns 2xx/3xx. A 500 shows an app
  error message (the AI may be mid-change) and enables the new-tab link, while
  gateway and network failures keep the preparing message and both actions disabled.
  After ten minutes probing continues every fifteen seconds; unless the app
  returns 500, the message offers waiting or opening a new tab. The iframe stays
  hidden until a later 2xx/3xx response makes the preview ready and stops probing
  for that URL. Changing the URL or leaving cancels the reader.
- Build sessions use four stages: 聞く → 決める → 作る → 公開. The `build`
  stage has internal `preparing`, `implementing`, and `done` phases. One ladder
  retains the placement, design, and template-startup steps, then adds each
  screen and publication readiness. The preview card appears when a task starts;
  its iframe additionally requires a successful HTTP readiness probe. A preview
  already shown stays mounted when a retry, skip or change starts a new run
  with every task pending, so the app is not reloaded.
  `model/build/progress.ts#implementationProgress` takes tasks, current task,
  step, the current task's start time and activity tail, plus a clock.
- Improvement sessions (`design/platform/builder-console-app-improvement.md`)
  are drafts with `kind: 'improvement'`, born `created` and bound to the app's
  stack. 「AIで直す」 on the app page (editors, bound app, no unfinished build)
  resumes the newest open session for that `stackId` or creates one and sends
  the dialog's text as its first turn. Stages 聞く → 直す → 確認 come from
  `model/improve.ts#deriveImprove`: a proposal is the handoff tasks the latest
  run has not made (task identity `implementationTodoId`, as on the server);
  「この内容で直す」 POSTs an empty implementation run. Completion sends an
  owner-reviewed proposal, not a live update (`design/platform/source-change-proposal.md`).
  The console server enriches improvement draft POSTs with the bound app's owner
  subjects, overriding caller-supplied reviewers and skipping pending invitations;
  no signed-in owner returns `412 reviewers_unavailable`.
  `/-/improve/{id}` shows the reviewers, preview and proposal state. Proposed,
  Accepted and Applying lock the composer; ChangesRequested shows the comment and
  reopens it. A proposer who is also a reviewer can explicitly 「反映する」.
  Only Applied displays the correlated version; a closed proposal starts a new
  session from the app's 「AIで直す」 entry.
  `/-/proposals/{id}` shows tasks, change counts, a collapsible bounded diff and
  reviewer-only decisions. The current principal is `me.person.subject`; names
  resolve through Directory `people?subject=`. Platform API remains authoritative
  for decision authorization. Nonterminal proposals poll through TanStack Query.
  The app header links its Proposed count to `/-/proposals?applicationId=...`.
  `/-/drafts` separates sent proposals from reviews waiting for the caller;
  proposal-backed drafts never count as unfinished builds. `/-/build/{id}` and
  `/-/improve/{id}` still redirect to each other by kind.
  The mock answers improvement turns after ~2 s and advances runs every ~1.5 s.
  Accept goes through Accepted and Applying to Applied after one second (or two
  manual advances), then creates one release and adds task version labels.
  Reject never changes releases. Switch both console/proposal identity with
  `POST /api/console/__mock/caller {personId, role: "Editor"}`: `p-sato` manages
  `p-yamada`'s seeded 見積作成 app and can propose a change for Yamada to review.
- Active screen rows show elapsed time, request/working/saving, and whether
  output exists. They do not invent output-event counts, retry waits or lease
  resumption evidence absent from the API. Raw activity is expert-only.
- Source repository build failures come from the controller's `BuildHealthy`
  condition, not AI task progress or image-tag availability. `BuildSucceeded`
  is True; `BuildFailed` is False for failure/cancelled/timed_out; `BuildRunning`,
  `NoBuild`, and `BuildUnobservable` are Unknown. GitHub Actions is observed with
  the existing repository installation credential every 30 seconds, including
  after an image becomes available. Terminal observations are cached by
  repository/ref/head/generation and invalidated on another accepted dispatch.
  A manual rerun at the same head is not re-observed until that cache is invalidated.
  Actions 403/404 responses remain Unknown without stopping image observation.
  `status.build` records repository/ref/headSha/runUrl/observedAt; Platform API
  extends response `build` (mode/workflow/ref) with
  `state: healthy|failed|running|unknown` and optional runUrl/headSha/observedAt.
  These observation fields are not part of create requests. Response fixtures
  copied from a create request must add `state: 'unknown'` when `build` is
  present; an omitted `build` remains omitted. The ladder shows
  「アプリのビルドに失敗しています」 on the failed startup rung, while app details
  and `/mine` prioritize 「ビルドに失敗しています」 over 「作っています」.
  The exact run link is under 「詳しい人向け」. An older Ready image does not
  hide a new build failure.
  Stack and draft read responses also expose optional `buildFailure`
  (`lines`, `kind`, `observedAt`, `buildRef`). The API reads at most 512 KiB
  of diagnostic text from the existing bounded Actions log reader, only for a
  current-generation failed build and an exactly matching completed run URL.
  `pkg/buildfailure.Extract` emits only reconstructed structured facts:
  `Module not found: '<relative path>'`, or `<file>:<line>:<column> で型エラー`
  for type/syntax errors. Paths must match `[A-Za-z0-9_./-]+`, be at most 256
  bytes, have no leading `/` or `..` segment, and not be workspace/token-looking
  paths. Everything else uses a fixed sentence. Controls are removed before
  recognition; **no free-form log message or source excerpt is emitted**.
  ZIP entries share one 512 KiB inflation budget.
  Missing/unavailable logs do not fabricate a cause. A successful later build
  clears the response field without deleting persisted terminal handoff history.
  App and build pages show 「ビルドが失敗しました。原因: …」 as plain text.
  Authorized editors can click 「AI に直させる」 to create an improvement draft
  through the existing API and send the cause lines as its first turn; this
  action does not resume an unrelated open improvement or grant new authority.
- The public card and app-list URL stay hidden until a persisted task was pushed
  **and** the latest web-component release succeeded after the template release.
  Without the session's initial release ID, two releases in that web component
  and branch are required in addition to the server's task evidence.
  App details and `/mine` join drafts by `createdApplicationId`, show the run's
  current screen/saving/stopped status, and offer `続きから作る` → `/-/build/{id}`
  until the build is done, even after its first screen becomes available.
  The proposal retains its planned address as non-clickable `公開先（予定）`.
  Default publish creation/repair still runs behind this presentation gate.
- Build-session publication requires `build.phase === 'done'`: a finished
  checklist with at least one successfully pushed task. Skipping every task
  leaves publication disabled and offers a retry that reopens the checklist.
  All-skipped retries explicitly select the skipped task IDs; ordinary retries
  leave done/skipped work untouched. The mock `implementation-run` toggle and
  manual `__mock/advance` drive request → working → pushing → done without any
  browser executor, including while the build tab is closed.
- Component logs answer 403 until the Project's owning Team members are
  projected as `ProjectWorkloadReader` (`design/platform/project-workload-reader.md`);
  the logs tab stops polling on 403 and names the next action.
- Component logs send the bound stack's `branchId` and cache each branch
  separately. Without a branch, the API prefers `Application.spec.defaultBranchRef`
  (the concrete ApplicationBranch key), then the newest instance within that
  branch. Older instances and other branches never replace a selected instance
  merely because it has scaled to zero.
- A successful logs response with no Pods shows
  「いまは停止中です。アプリを開くと起動し、ログが出ます」 and an 「開く ↗」
  link to the published app URL when available. 「ログはまだありません。」 is
  reserved for running Pods with no returned lines.
- Business template repositories (`appthrust/template-biz-*`) do not run
  migrations on boot; AppThrust applies `db/migrations` through
  `DatabaseChange`.
- Directory (部署フロント / つかいかた / コメント / ディレクトリ; design: Nexus Vault
  `50-projects/appthrust/features/builder-console/directory/`): a
  **bound** app (`stackId` set) is listed as a `DirectoryEntry` to every project
  member regardless of `share`, with `canOpen` computed server-side; the entry
  omits `share`, `guide` and `createdBy`. Discovery grants no visibility:
  `GET /apps/{id}` stays 404 and the app URL's authorization is unchanged.
  `/resolve` answers `kind: 'entry'` for bound-but-invisible apps; drafts stay
  404. The SPA additionally hides unfinished apps (`model/directory.ts#isFinished`)
  from the directory. `GET /apps` (every scope, `directory` included) answers
  `{items: [...]}` and filters by `group` (a group id, descendants included);
  `GET /apps/{id}/comments` is a bare array (newest first, 100 max).
  The group introduction (`about`) is written in the Directory and shown
  read-only; guide/capabilities go through `PATCH /apps/{id}` (owner/manager/admin).
- Store view (design: `…/directory/store-ux.md`): directory cards, department
  fronts and search results use `AppStoreCard`, ordered by
  `model/directory.ts#storeOrder` (screenshots 4 + capabilities 2 + guide 1,
  then name); score-0 apps fold under 「試用・準備中」 on a department front.
  Screenshots (`BusinessApp`/`DirectoryEntry.screenshots`, never null) are
  multipart uploads to `POST /apps/{id}/screenshots` (PNG/JPEG/WebP sniffed
  from bytes, ≤ 2 MB, ≤ 5; 400 / 409), `DELETE …/{sid}`, `PATCH {order}`;
  the SPA builds the image URL with `screenshotUrl`, served to any member
  while the app is bound. `/-/people/<id>` redirects to the Directory profile
  (`<me.directoryPublicURL>/people/<id>`); only without a linked Directory does
  it render an in-console card from `GET directory/people/{id}` (direct
  memberships) and `GET /apps?scope=directory&ownerId=`; no email is shown.
- People, groups and memberships belong to the Directory built-in app
  (`design/platform/builtin-app-directory/console-cutover.md`). The SPA reaches its
  API through the console's same-origin proxy `/api/console/directory/*`
  (`consoleApi.directory`: `groups`, `groups/{id}/members`, `people?q=`,
  `people?ids=` (batched by 100), `people/{id}`, `POST people`,
  `directory-users?q=`); list answers are `{items: [...]}` as the Directory
  sends them. `GET /me` carries `effectiveGroupIds` (direct
  memberships plus descendants; `membershipRoots` derives the 所属 choices),
  `managedGroupIds` (app edit for group managers), `directoryPublicURL` and
  `migration`. Group pages, members and the left tree are read-only and link
  to the Directory (「ディレクトリで管理」); the person pickers search
  `directory-users` and pre-register unknown emails with `POST people`.
- Every app belongs to a group, so the AI build needs one before it starts:
  `features/build/entry.ts` resolves `currentGroup?.id ??
  membershipRoots(me, groups)[0]?.id ?? me.effectiveGroupIds[0]` (the wizard's
  own picker adds a catalog fallback the AI path deliberately lacks). Without
  a group the wizard disables 「AI と作る」/「AI でカスタマイズ」 and the build
  page shows 「所属する部署がありません」 instead of mounting the session; the
  group is fixed in the build session at start. The console answers an
  unknown or empty `groupId` with `400 invalid_request` (`groupId must be one
  of your directory groups`), which `classifyBuildFailure` reports as a
  settings problem (kind `group`), not a platform failure (appthrust.ink
  2026-10-18: a member of no group reached the bind step and saw the
  console's 404 as 「The requested resource was not found」).
- Profile pictures: every `Person` carries `avatarVersion` (null, or when the
  picture last changed). `ui/misc.tsx#Avatar({ person })` loads
  `<directoryPublicURL>/api/directory/v1/people/{id}/avatar?v=<version>` and
  falls back to the name's first character when there is no picture, no linked
  Directory, or the image fails to load. Pictures and names are changed on the
  Directory "you" page (`/people/me`), linked from アカウントの設定.
- Release N only: when `me.migration.pending`, 基盤の設定 shows console admins a
  one-time banner with the counts; confirming calls
  `POST /api/console/admin/directory-migrate` and shows the imported counts
  and conflicts. Mock: `POST /api/console/__mock/migration {pending?}`.
- Tools for this app (Built-in app Connect; design: Nexus Vault
  `50-projects/appthrust/features/builtin-app/connect/console-tools.md`): the 概要 of
  every app shows `features/app/tools-panel.tsx#ToolsPanel` from
  `GET /apps/{id}/tools`; the panel only follows the answer (an unbound app is
  `{available: true, tools: []}`, no `editUrl`). `{available: false}` (no Tools built-in app) renders nothing;
  `pending` shows 「Tools を準備しています…」; `{available: true, tools}` lists
  cards opening `tool.url` in a new tab, or 「まだツールはありません」 with
  「ツールを作る」 → `editUrl` (sent only to people who may create tools);
  `error: 'tools_unavailable'` and failed reads stay one line with a retry inside
  the panel (403/404 hide it). Polls every 60 s, every 5 s while installing.
  Mock: 見積作成 lists two tools, 日報 has none, 勤怠申請 is installing, 会議室予約
  cannot reach Tools, the rest have no Tools, drafts answer as unbound;
  `POST /api/console/__mock/tools {appId, state}` switches one bound app.
