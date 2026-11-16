---
name: playwright-e2e-testing
description: Write and run Playwright end-to-end tests for web applications from an AI agent using the Playwright CLI (non-interactive commands only), grounded in the project's own documentation and architecture rather than guessed flows and selectors. Audits existing tests first and generates new E2E tests from docs/architecture when none exist or existing ones are incomplete; produces a short run doc alongside every suite. Use when adding new E2E coverage, bootstrapping or completing a suite, setting up Playwright, or reviewing a suite for gaps or flakiness.
---

# Playwright End-to-End Testing

Guidance for writing Playwright E2E tests that exercise a web application through its real UI.
This covers only the E2E layer — see `/eng-testing-strategy` for deciding whether a scenario
belongs at the E2E level at all versus unit or integration, and
`/test-generation-with-independent-verification` for verifying generated tests actually assert
the right thing once written.

## When to invoke

- Writing new Playwright tests for a user-facing flow
- A project has no E2E tests, or the existing ones cover only part of the documented flows — generate the missing coverage from docs and architecture
- Setting up Playwright in a project that doesn't have it yet
- Reviewing an existing Playwright suite for flakiness, over-coverage, or brittle selectors
- Auditing selector or fixture strategy before it's copied across many test files

## Ground tests in the project's own documentation first

Never invent a user flow, endpoint, or expected UI state from guesswork. Before writing a single
test, gather the project's actual documentation and treat it as the source of truth for what
"correct" behavior looks like.

| Source | What to extract |
|---|---|
| `README.md` / `CONTRIBUTING.md` | How to run the app locally, required env vars, base URL, seed accounts |
| Product specs, tickets, ADRs | The real user flow and its acceptance criteria — not an assumed happy path |
| API docs (OpenAPI/Swagger, GraphQL schema) | Real endpoints, request/response shapes, and status codes to assert against when a flow crosses the network |
| Existing unit/integration tests | What's already covered lower in the pyramid, so the E2E test doesn't re-verify business logic through the UI |
| Design system / component docs | Existing `data-testid` or ARIA-role conventions — reuse them instead of inventing new selector patterns |

If the documentation doesn't describe an expected behavior for a scenario you're about to test,
say so explicitly (in the test file's description or the PR) rather than asserting a guessed
behavior silently. A test built on an assumption is a liability, not coverage.

## Discover existing tests, then fill the gaps

Always audit before writing. Start from what exists; generate only what is missing or incomplete.
Never duplicate or overwrite passing tests.

### 1. Find existing tests

- Search for `playwright.config.*`, `**/*.spec.ts`, `**/e2e/**`, `tests/`, and other E2E tools
  (Cypress, Selenium) whose flows can inform coverage
- Run `npx playwright test --list` to see what is actually discovered, not just what files exist
- Read the tests found — names and assertions, not just file counts

### 2. Classify each documented flow

Build a flow inventory from the docs (see above) and the architecture sources below, then classify:

| State | Signs | Action |
|---|---|---|
| No tests at all | No config, no spec files, or an empty suite | Set up Playwright (see Project setup), then generate tests for the critical flows |
| Flow missing | A documented critical journey has no spec | Generate a new spec for it |
| Incomplete test | Only happy path where docs define error/permission states; no assertions after the action; `test.skip`/`fixme`/TODO bodies; navigates but never verifies the outcome; covers part of a multi-step flow | Extend the existing spec — add the missing steps/assertions, keep what works |
| Complete and passing | Covers the documented acceptance criteria with real assertions | Leave untouched |
| Stale/failing | Refers to routes, labels, or endpoints no longer in docs/code | Report it; fix only if the intended behavior is clear from docs, otherwise flag for the user |

### 3. Derive tests from architecture and documentation

When tests must be created, build them from these sources in priority order:

| Source | What to derive |
|---|---|
| Specs, requirements, acceptance criteria | Test cases: one scenario per criterion on a critical flow |
| Architecture docs, ADRs, C4/sequence diagrams | User-facing entry points, service boundaries to assert across (and which third-party edges to mock), auth model, data ownership |
| Route/page definitions (router config, pages dir, controllers) | The real URLs and navigation paths — cross-check against docs; report drift |
| API contract (OpenAPI/GraphQL schema) | Status codes and payload shapes to assert when a flow crosses the network |
| Domain model / bounded contexts | Core entities and lifecycle states to cover in CRUD and state-transition journeys |
| Source code (components, forms) | Accessible names, roles, and existing `data-testid` values for selectors — never as the source of expected behavior |

Generation rules:

- Prioritize by risk: auth, money, data-loss, and core CRUD journeys first; skip what belongs lower in the pyramid (see Scope)
- Each generated test traces to its source — add a comment or `test.info().annotations` entry naming the doc/criterion (e.g. `// Source: docs/requirements.md#REQ-12`)
- Where docs and architecture are silent or contradict the code, don't guess the expected behavior: write the test as `test.fixme('<what is unspecified>')` with the question in the description, and list it in the run doc and the final report
- If the app can be started, verify selectors against the running UI (non-interactively, e.g. through the test run's failure artifacts) rather than trusting source code alone; if it can't, say so and mark selectors as unverified
- Run each generated test (`npx playwright test <file> --reporter=line`). A new test that fails because the app contradicts the docs is a finding to report, not something to "fix" by weakening the assertion

### 4. Report coverage

End with a short coverage summary: flows found already covered, flows extended, flows newly
generated, and flows skipped/`fixme` with the reason. Put the same list in the run doc.

## Scope: what deserves an E2E test

E2E tests are the most expensive tier of the pyramid (see `/eng-testing-strategy`) — slow, and
the first to break on unrelated UI changes. Reserve them for what can only be verified by
driving the real browser.

| Scenario | Right level |
|---|---|
| Critical user journey (signup, login, checkout, core CRUD path) | E2E |
| Cross-page navigation and state persistence | E2E |
| Every input validation rule and error message | Unit/integration — assert one representative case at E2E, if any |
| Business rule / calculation logic | Unit test on the underlying function |
| Third-party integration correctness (payment provider, email delivery) | Integration test against a fake/sandbox; mock it at the E2E boundary |

## Project setup

- Install with `npm init playwright@latest` (adds `@playwright/test`, config, and example tests)
- In `playwright.config.ts`, set:
  - `baseURL` from the project's documented local/staging URL — don't hardcode a guessed port
  - `use.trace: 'on-first-retry'` and `use.screenshot`/`video: 'retain-on-failure'` for debuggable CI failures
  - `retries` > 0 only in CI (`retries: process.env.CI ? 2 : 0`) — retries at 0 locally so flakiness surfaces immediately
  - `projects` for each browser the project's docs/browser-support matrix actually targets — don't test browsers nobody supports
- Structure: one spec file per user flow (`tests/e2e/<flow>.spec.ts`), page objects under `tests/e2e/pages/`, shared fixtures under `tests/e2e/fixtures/`

## Driving Playwright from an AI agent via the CLI

Tests here are written and run by an AI agent through the Playwright CLI, not through the
interactive UI mode or trace viewer a human would use — those open a GUI the agent can't drive.
Stick to commands that produce output the agent can read directly from stdout/a file.

| Task | Command | Notes |
|---|---|---|
| Scaffold a new project | `npm init playwright@latest -- --quiet` | Skip the interactive prompts; pass flags or edit `playwright.config.ts` after |
| List tests without running | `npx playwright test --list` | Sanity-check discovery/naming before a full run |
| Run the whole suite | `npx playwright test --reporter=line` | `line` reporter streams pass/fail per test; avoid the default `html` reporter alone since it needs a browser to view |
| Run one file or one test | `npx playwright test tests/e2e/login.spec.ts -g "invalid password"` | Narrow the loop while iterating on a single flow |
| Machine-readable results | `npx playwright test --reporter=json > results.json` | Parse this instead of opening the HTML report when triaging failures programmatically |
| Inspect a failure | Read the `screenshot`/`trace` paths Playwright writes under `test-results/` on failure | Don't reach for `npx playwright show-trace` (opens a GUI) — read the trace zip's `trace.json`/attached screenshots directly, or rely on the JSON reporter's `attachments` paths |
| Debug interactively | `npx playwright codegen` / `--ui` / `--debug` | Human-only — these open a browser session; do not rely on them in the agent's own workflow |

Never fall back to `waitForTimeout`-based debugging loops or manual guesswork when a run fails —
rerun the failing test with `--trace on` and inspect the artifacts under `test-results/` instead.

## Selector strategy

Prefer selectors in this order — each step down is a fallback, not a free choice:

1. `getByRole` (matches how users and assistive tech perceive the page)
2. `getByLabel` / `getByPlaceholder` for form fields
3. `getByText` for static, stable copy
4. `getByTestId` — only when the project already has a `data-testid` convention (check the docs/design system first) or the element has no accessible role/text
5. CSS/XPath selectors tied to implementation details (class names, DOM structure) — last resort; these break on unrelated styling changes

## Page Object Model

- One class per page or feature area: locators and actions live in the page object, assertions live in the test
- Page objects should not know about other page objects — a flow test composes multiple page objects, not one page object reaching into another
- Reuse a login/auth fixture (`storageState`) across tests instead of re-implementing UI login in every page object

## Handling asynchronicity and flakiness

- Use Playwright's web-first assertions (`await expect(locator).toBeVisible()`) instead of manual `waitForTimeout` — they auto-retry until the condition holds or times out
- Avoid `waitForLoadState('networkidle')` as a general-purpose wait; it's unreliable with polling/analytics traffic — wait for the specific element or response that signals readiness
- Use `page.route()` to mock third-party/external calls (payment, email, analytics) that aren't the system under test; do not mock the app's own backend in an E2E test — that's what integration tests are for
- Give each test unique data (timestamp- or UUID-suffixed emails, records) so tests can run in parallel without colliding
- Don't rely on execution order or shared mutable state between test files — each test should set up its own preconditions

## Authentication and test data

- Log in once per worker via a `storageState` fixture and reuse the session, rather than performing UI login in every test — UI login is itself a flow that deserves its own dedicated test, not a repeated setup step
- Seed test data through an API or DB setup hook when the data itself isn't what's under test; use the UI only when the creation flow is the thing being verified
- Tear down or isolate seeded data so runs don't accumulate state across test executions

## CI integration

- Run headless in CI (`headless: true`, the default when `CI` env var is set)
- Upload the HTML report and traces/videos for failed runs only — always-on video capture bloats CI artifacts for no benefit
- Shard large suites (`--shard=1/4`) to keep CI wall-clock time bounded rather than raising timeouts
- See `/eng-cicd-review` (if present in this repo's `deploy/` skills) when wiring the suite into the pipeline itself

## Document how to run the suite

Every time E2E tests are added or a suite is set up, write or update a short run doc alongside
the tests (e.g. `tests/e2e/README.md`). This is what lets a human or another agent run the suite
without re-deriving setup from the config files. Keep it short — a few bullet points, not prose:

- **Prerequisites** — required env vars, seed accounts/credentials, and whether the app under
  test must be started separately or is started by the test run itself
- **Install** — the one-time setup command (`npm install && npx playwright install --with-deps`)
- **Run commands** — full suite, a single file, and a single test by name (the exact CLI
  invocations from the table above, copy-pasteable)
- **Where results land** — report/trace/screenshot paths on failure, and how to read them without
  a GUI (per the CLI section above)
- **Known flaky tests or skips**, if any, and why — so a failure can be triaged against a known
  issue instead of treated as new
- **Coverage map** — documented flows → spec files, including which were pre-existing, extended,
  or generated, and which are `fixme` pending unspecified behavior

Keep this doc next to the tests it describes, not buried in a wiki, so it stays in sync as the
suite changes.

## Implementation checklist

- [ ] Flows and expected behavior were confirmed against the project's actual docs/specs, not assumed
- [ ] Existing tests were located and read (`--list`) before anything was written; passing tests were left untouched
- [ ] Each documented critical flow is classified (covered / incomplete / missing) and gaps were filled from docs and architecture
- [ ] Every generated test traces to a named doc/criterion; unspecified behavior is `test.fixme`, not guessed
- [ ] Each test covers a critical flow, not every input permutation
- [ ] Selectors follow the role/label/text/test-id priority, reusing existing `data-testid` conventions
- [ ] Assertions are web-first (`expect(locator)...`), no `waitForTimeout` or fixed sleeps
- [ ] Auth uses a shared `storageState` fixture, not per-test UI login
- [ ] Test data is unique per test and doesn't depend on execution order
- [ ] Third-party calls are mocked at the network boundary; the app's own backend is not
- [ ] CI config captures trace/video/screenshot on failure only, with bounded retries
- [ ] A run doc (e.g. `tests/e2e/README.md`) exists and lists prerequisites, install step, and exact CLI commands to run the full suite / one file / one test
- [ ] All commands used to write and verify the tests were non-interactive CLI invocations (no reliance on `--ui`, `--debug`, or `show-trace`)

## Review checklist

- [ ] No test asserts a flow or endpoint behavior that isn't backed by the project's documentation or spec
- [ ] No CSS/XPath selector where a role, label, or existing test-id would work
- [ ] No `waitForTimeout` or arbitrary sleep used to paper over a race condition
- [ ] No test depends on another test having run first or on shared global state
- [ ] No E2E test re-verifies pure business logic already covered by a unit test
- [ ] No hardcoded credentials, base URLs, or environment-specific values in test files
- [ ] The run doc is present, accurate, and next to the tests (not stale relative to actual CLI flags/paths)
- [ ] No documented critical flow is left without a test or an explicit `fixme`/skip reason
- [ ] No "incomplete" test (no assertions, skipped body, happy-path only) was left as-is or counted as coverage

## Common mistakes

- Writing tests from a guessed happy path instead of the documented user flow, then treating a pass as validation of the real requirement
- Generating a fresh suite without checking what exists, duplicating or overwriting tests that already work
- Counting a spec file as coverage when it only navigates or has no meaningful assertions
- Deriving expected behavior from the current source code instead of docs/architecture, so the tests just confirm whatever the app does today
- Weakening an assertion to make a newly generated test pass when the app contradicts the docs
- Selector churn from relying on CSS classes tied to styling, breaking on every unrelated design change
- Using `waitForTimeout` to "fix" flakiness — it hides a race condition instead of resolving it
- Re-logging in through the UI in every test, multiplying suite runtime and coupling every test to the login flow's stability
- Turning every edge case into an E2E test instead of pushing it down to unit/integration, inverting the pyramid
- Mocking the system under test itself at the network layer, which makes the test assert against the mock instead of the real integration
- Shipping a new test suite with no run doc, leaving the next person (or agent) to reverse-engineer setup from `playwright.config.ts`
- Debugging failures by reaching for interactive tools (`--ui`, `--debug`, `show-trace`) that an agent can't actually drive, instead of the JSON/line reporter and on-disk artifacts
