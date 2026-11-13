---
name: playwright-ci
description: Running Playwright in CI — starting the app and backing services from the test config (webServer, containers), environment-specific config, retries and traces/videos on failure, reporters and artifacts, sharding and report merging, browser installation and caching, and running on runners with no GPU and no display (headless, xvfb, WebGPU flags). Use when setting up or changing Playwright configuration or the CI jobs that run it.
---

# Playwright in CI

CI should run the same tests the same way as a developer's machine, start everything they need by itself, and leave enough evidence (traces, logs, reports) to diagnose a failure without rerunning it.

## 1. Start the app (and its services) from the config

```ts
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 4200);
const CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [['blob'], ['github'], ['list']] : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    testIdAttribute: 'data-testid',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: CI ? `npm run serve:dist -- --port ${PORT}` : `npm start -- --port ${PORT}`,
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !CI,
      timeout: 180_000,
      stdout: 'pipe',
    },
    // { command: 'npm run api:test', url: 'http://localhost:3000/health', reuseExistingServer: !CI },
  ],
});
```

- **`webServer`** starts the app (and the API, as a second entry) and waits for its URL. In CI, serve a **production build** when possible (closer to what ships, faster to start) rather than the dev server; locally, reuse a running dev server.
- **Backing services** (database, DICOM archive): start them as containers in the CI job (`services:` or `docker compose up -d --wait`) or from `globalSetup` with Testcontainers, and pass connection details through environment variables. Pin image versions.
- **Readiness:** `webServer.url` should hit a health endpoint that's only OK when the app can actually serve tests.
- **Configuration via environment**, not edits: base URL, ports, feature flags, credentials for test identities. Never commit real credentials; CI secrets only.

## 2. Retries, traces and evidence

- **`retries: 1` in CI**, 0 locally. A test that passes on retry is reported as **flaky** — track and fix those (see [playwright-patterns](../playwright-patterns/SKILL.md) §7) rather than raising retries.
- **`trace: 'on-first-retry'`** (or `'retain-on-failure'`) keeps CI fast while capturing a full trace of every failure. Add `screenshot: 'only-on-failure'` and `video: 'retain-on-failure'` where helpful.
- **Upload artifacts** on failure: the HTML report, `test-results/` (traces, screenshots, videos) and server logs (`webServer.stdout: 'pipe'` plus container logs).
- Use the `github` reporter (annotations on the PR) or JUnit for other CI systems, plus `html`/`blob` for humans.
- `forbidOnly: true` in CI so a stray `test.only` can't silently skip the suite.

## 3. Sharding and parallelism

- Within a machine: `fullyParallel: true` and `workers` tuned to the runner (CPU and memory — GPU-heavy or memory-heavy apps may need `workers: 1`). Tests must be isolated for this to be safe.
- Across machines: shard with `npx playwright test --shard=${{ matrix.shard }}/${{ strategy.job-total }}` in a matrix, use the **`blob` reporter** in each shard, then a final job runs `npx playwright merge-reports --reporter html ./all-blob-reports`.
- Keep a fast **smoke subset** (tag with `@smoke` in the title, run with `--grep @smoke`) for every push, and the full suite on PRs/main.

## 4. Browsers on CI

- Install browsers matching the installed Playwright version: `npx playwright install --with-deps chromium` (only the browsers you run). Cache the browser directory keyed by the Playwright version, or use the official Playwright Docker image pinned to the same version.
- Pin `@playwright/test` in the lockfile; upgrade deliberately (browser versions change with it).

## 5. No GPU, no display

Most CI runners have neither a GPU nor a display:

- **Headless is the default** in Playwright and needs no display server. Only headed runs (or Electron apps) need a virtual display: wrap them with `xvfb-run --auto-servernum` on Linux (see the `electron` plugin's `electron-testing` skill, if installed).
- **WebGL** usually works via a software rasterizer (SwiftShader) in headless Chromium.
- **WebGPU** support in headless CI is not guaranteed. Chromium may expose an adapter with flags such as `--enable-unsafe-webgpu` (and on Linux `--enable-features=Vulkan`); some environments provide a software adapter, others none. Flags change between Chromium versions — check current docs.

  ```ts
  projects: [{
    name: 'chromium-webgpu',
    use: { ...devices['Desktop Chrome'],
      launchOptions: { args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] } },
  }],
  ```

- **Design tests to branch on capability** (detect `navigator.gpu?.requestAdapter()` in the page) and assert graceful degradation when it's missing, instead of skipping wholesale — see [canvas-app-testing](../canvas-app-testing/SKILL.md).
- Put **pixel/screenshot tests** and GPU-dependent assertions in a separate project that runs on a known GPU-capable runner (self-hosted or a GPU instance), not in the required job.
- Keep `workers` low for GPU-heavy apps even on capable runners; GPU memory is shared across workers.

## 6. Example GitHub Actions job (sketch)

```yaml
e2e:
  runs-on: ubuntu-latest
  strategy: { matrix: { shard: [1, 2] } }
  steps:
    - uses: actions/checkout@v6
    - uses: actions/setup-node@v6
      with: { node-version-file: .nvmrc, cache: npm }
    - run: npm ci
    - run: npx playwright install --with-deps chromium
    - run: npm run build
    - run: npx playwright test --shard=${{ matrix.shard }}/2
    - uses: actions/upload-artifact@v4
      if: ${{ !cancelled() }}
      with: { name: blob-report-${{ matrix.shard }}, path: blob-report, retention-days: 7 }
```

(Add a merge-reports job, and check current action versions.)

## 7. Review checklist

- [ ] The config starts the app and services itself; CI uses a production build; readiness via a health URL.
- [ ] Retries only in CI (≤ 1), flaky tests tracked; traces/screenshots/videos kept on failure and uploaded.
- [ ] `forbidOnly` in CI; browsers pinned to the Playwright version and cached.
- [ ] Sharding with blob reports merged; smoke subset for fast feedback.
- [ ] GPU-dependent and pixel tests isolated from the required GPU-less job; capability-branching tests in the required job.
