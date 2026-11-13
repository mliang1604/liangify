---
name: playwright-patterns
description: Writing reliable Playwright end-to-end tests — locator strategy (roles, labels and test ids over CSS), web-first assertions and auto-waiting, never using fixed sleeps, fixtures for setup and test data, helpers and page objects only where they pay off, test isolation, and debugging flaky tests. Use when writing, reviewing or de-flaking Playwright tests.
---

# Playwright Patterns

E2E tests are worth their cost only if they're **trusted**: they fail when the product is broken and pass when it isn't. Flakiness almost always comes from three habits — brittle selectors, fixed waits, and shared state. Avoid all three by construction.

Check the current Playwright docs ([playwright.dev](https://playwright.dev/docs/best-practices)) for API details; the patterns below are stable.

## 1. Locators: how a user finds things

Prefer, in order:

1. **`getByRole(role, { name })`** — buttons, links, headings, checkboxes, dialogs, tabs, rows. It doubles as an accessibility check: if you can't find it by role and name, neither can a screen reader.
2. **`getByLabel`**, **`getByPlaceholder`**, **`getByText`** (for non-interactive text), **`getByAltText`**, **`getByTitle`**.
3. **`getByTestId('series-chip')`** — for elements with no stable accessible name (canvas overlays, repeated custom widgets, list items whose text is data). Configure the attribute once (`use: { testIdAttribute: 'data-testid' }`) and treat test ids as a public contract: named for meaning, not layout.
4. **CSS/XPath** — last resort. Class names (`.study-tile`, `.chip-modality`) and component tags change with styling refactors; if a test depends on them, add a test id or improve the accessible name instead.

Refine instead of reaching for selectors:

```ts
const row = page.getByRole('row').filter({ hasText: 'PTV_7000' });
await row.getByRole('checkbox', { name: /visible/i }).check();

const chip = page.getByTestId('series-chip').filter({ has: page.getByText(/^CT$/) });
```

- Locators are lazy and re-resolve on each action — create them once, reuse them.
- Avoid `.first()` / `.nth()` unless order *is* the behavior under test; ambiguity is usually a missing filter.
- Strict mode is your friend: an action on a locator matching several elements fails, surfacing ambiguous tests.

## 2. Web-first assertions, no sleeps

```ts
await expect(page.getByRole('button', { name: /layout/i })).toBeEnabled();
await expect(page.getByTestId('probe-value')).toHaveText(/-?\d+ HU/);
await expect(page).toHaveURL(/\/viewer\//);
```

- **`expect(locator).toBe…/toHave…`** retries until the condition holds or the timeout expires. Use them for everything visible.
- **Never `page.waitForTimeout(ms)`** (or `setTimeout`) to "let things settle". Wait for the thing you need: an element state, a URL, a response (`page.waitForResponse`), an event, or an app readiness signal.
- **Don't assert on values read imperatively** (`expect(await el.textContent()).toBe(...)`) — that doesn't retry. Use the locator assertion.
- **`expect.poll(fn)`** for values not in the DOM (app state via `page.evaluate`, a backend query); **`expect(async () => { ... }).toPass()`** for a multi-step check that must eventually succeed. Use `toPass` sparingly and with a bound; if you need it to retry clicks, the app probably lacks a readiness signal (expose one).
- Actions auto-wait for actionability (visible, enabled, stable). Don't add `waitFor` before `click()`.
- Keep timeouts explicit and justified per assertion (`{ timeout: 30_000 }` for a cold GPU init), not raised globally.

## 3. Test isolation

- **Every test gets a fresh browser context** (Playwright's default): no shared cookies, storage or tabs. Don't fight it with `test.describe.serial` or module-level state.
- **Each test creates its own data** (or uses read-only fixtures) and doesn't depend on another test having run. Tests must pass alone, in any order and in parallel.
- **Seed state directly, not through the UI**, when the UI isn't what's under test: `page.addInitScript` to set `localStorage` flags (e.g. a pre-acknowledged disclaimer), API calls in a fixture to create records, `storageState` for authentication.
- Clean up server-side data the test created (or use per-test namespaces) so reruns don't collide.
- **Synthetic data only** for anything resembling patient data (generate fixtures in code; see the `dicom-rt` plugin's `dicom-test-data` skill, if installed).

## 4. Fixtures

Use `test.extend` for setup that many tests share — it composes, is lazy, and tears down reliably:

```ts
type Fixtures = { viewer: ViewerPage; syntheticCt: SyntheticFile[] };

export const test = base.extend<Fixtures>({
  syntheticCt: async ({}, use) => { await use(syntheticCtSeries(12, 32)); },
  viewer: async ({ page }, use) => {
    await page.addInitScript(() => localStorage.setItem('disclaimer-acknowledged', 'true'));
    await page.goto('/');
    await use(new ViewerPage(page));
  },
});
export { expect } from '@playwright/test';
```

- Worker-scoped fixtures (`{ scope: 'worker' }`) for expensive, read-only setup (starting a mock service, generating large fixtures once).
- Fixtures replace `beforeEach` chains and global setup in most cases; keep `globalSetup` for truly global work (building the app, seeding a database once).

## 5. Helpers and page objects — only where they pay off

- **Start with plain tests.** Extract a helper when the same multi-step flow appears in several specs (e.g. `importAndLoad(page, files, 'CT')`), named for the user intent.
- **Page objects** (a class per screen exposing intent-level methods and locators) are worth it for large, frequently changing screens shared by many tests. They're not worth it for a screen used by two tests; a thin page object that just wraps every locator adds indirection without value.
- Helpers return locators or perform actions; **assertions stay in the test** (or in clearly named `expect…` helpers), so failures point at the behavior.
- Wrap logical phases in `test.step('load the CT', async () => { ... })` for readable reports and traces.

## 6. Writing good E2E tests

- **Test user-visible behavior and critical journeys** end to end (load a study, contour, view dose). Push edge cases down to unit/component tests.
- **One behavior per test**, named as the behavior: `test('a same-frame dose loads as a fusion overlay')`.
- **Fail on unexpected errors:** collect `pageerror` and relevant `console` errors in a fixture and assert none occurred at the end.
- **Network:** mock third-party services with `page.route`; for your own backend prefer the real service in CI (see [playwright-ci](../playwright-ci/SKILL.md)), mocking only specific failure cases.
- Use `test.fixme`/`test.skip` with a reason and an issue link — never delete a failing test to get green.

## 7. Debugging flakes

- Reproduce with `--repeat-each=20` and `--workers` matching CI; run headed or with `--ui` locally.
- Read the **trace** (`npx playwright show-trace`): it shows each action, the DOM snapshot, network and console at that moment — almost every flake is visible there.
- Typical root causes: a locator matching a stale or duplicate element; asserting before the app signalled readiness; a test depending on another's data; animations (disable with `reducedMotion: 'reduce'` or CSS); time-dependent UI (use `page.clock` to control time).
- Fix the cause; **retries in CI are a safety net for infrastructure noise, not a cure** for test bugs.

## 8. Review checklist

- [ ] Locators by role/label/text or test id; no styling-class or DOM-structure selectors without a reason.
- [ ] Web-first assertions; no `waitForTimeout`; no imperative reads in `expect`.
- [ ] Tests independent, parallel-safe, creating their own (synthetic) data.
- [ ] Shared setup in fixtures; helpers/page objects only where reused; assertions in tests.
- [ ] Page errors and console errors fail the test.
