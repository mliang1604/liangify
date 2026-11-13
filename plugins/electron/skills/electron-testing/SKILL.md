---
name: electron-testing
description: Testing Electron apps — unit-testing main-process and IPC handler logic, testing the renderer as a web app, launching the packaged app under Playwright's Electron support, running headless on Linux CI with a virtual display (xvfb), and smoke-testing installers per platform. Use when writing or reviewing tests for an Electron app or setting up its CI.
---

# Electron Testing

Test each layer where it's cheapest, and always test the **packaged** app at least once per platform — packaging is where things break (missing files in the asar, unsigned helpers, wrong resource paths, flipped fuses).

## 1. Layers

| Layer | How | What |
|---|---|---|
| **Renderer** | Its own unit tests (e.g. Vitest) and browser E2E — it's a web app | UI logic, with the desktop API faked |
| **Main / IPC handlers** | Unit tests in Node with Electron modules mocked | Validation, path confinement, sender checks, error mapping |
| **Preload** | Small; covered by the integration tests | Shape of the exposed API |
| **Integration** | Playwright launching Electron (dev build) | Windows open, IPC round-trips, desktop-only features |
| **Packaged smoke test** | Playwright launching the built executable | App starts, reaches ready, bundled helpers run |

## 2. Main-process logic

- Keep IPC handlers thin: a validation step and a call into plain functions. Test the plain functions without Electron.
- Test the handlers with a fake `IpcMainInvokeEvent` (a `senderFrame` with a chosen `url`) to cover: trusted sender accepted; foreign origin rejected; subframe rejected; invalid arguments rejected; path traversal (`../`, symlinks, absolute paths) rejected.
- Mock `electron` modules (`app`, `dialog`, `shell`, `BrowserWindow`) at the module boundary. Don't try to unit-test real windows.
- Test the helper-path resolution for packaged and dev modes, and the job runner that spawns native helpers (with a fake helper script that emits progress and exits with chosen codes).

## 3. Renderer with a fake desktop API

- Provide a fake `DesktopApi` in unit tests and in browser E2E so desktop-dependent UI paths are covered without Electron.
- Also test the **absent** case (`window.desktop` undefined): the UI must degrade to its browser behavior.

## 4. Playwright with Electron

Playwright can launch and drive Electron apps (`_electron` from `@playwright/test`; the API is marked experimental, so check the current docs):

```ts
import { _electron as electron, expect, test } from '@playwright/test';

test('app starts and reaches the viewer', async () => {
  const app = await electron.launch({
    args: ['.'],                       // or executablePath: '<packaged binary>' for the packaged app
    env: { ...process.env, APP_E2E: '1', APP_DATA_DIR: tmpDataDir() },
  });
  const window = await app.firstWindow();
  await expect(window.getByRole('heading', { name: /open studio/i })).toBeVisible();

  // Evaluate in main for state that isn't in the DOM
  const isPackaged = await app.evaluate(({ app }) => app.isPackaged);
  expect(isPackaged).toBe(false);

  await app.close();
});
```

- **Isolate state:** point the app at a fresh temporary user-data directory for each test (an env var or CLI flag your main process honors), so tests don't share databases or settings.
- **Stub native dialogs** in E2E mode (an env flag that makes main return a predetermined folder of synthetic fixtures) — Playwright can't click OS dialogs.
- **Wait on app readiness signals** in the DOM, not timeouts.
- Capture `console` messages and page errors from each window, and fail on unexpected errors, as for web E2E.
- Use **synthetic data only** for any medical images.

## 5. Headless on Linux CI

- Electron needs a display server. On Linux runners, wrap the test command with **`xvfb-run --auto-servernum`** (install `xvfb`), or start Xvfb and set `DISPLAY`.
- Some environments also need `--no-sandbox` because of container restrictions on Chromium's sandbox. Prefer fixing the runner (unprivileged user namespaces, or the `chrome-sandbox` SUID helper) over disabling the sandbox, and **never** ship `--no-sandbox` in the product; confine it to the CI test launch.
- GPU is usually absent: WebGPU/WebGL features will fall back or be unavailable. Assert the app degrades gracefully and keep GPU-dependent checks in separate jobs on GPU machines (see the `webgpu` plugin's testing skill if installed).
- macOS and Windows runners have a desktop session; no virtual display needed.

## 6. Packaged-app smoke tests (per platform)

After packaging (and signing) in CI, on the same OS:

- Launch the packaged executable with Playwright (`executablePath`) — or, at minimum, start it with a `--smoke-test` flag that makes main load the UI, wait for readiness, run a self-check, and exit with a status code.
- Verify: the window reaches the ready state; the app version matches the tag; bundled resources load; **each native helper runs** (`--version` or a tiny synthetic job) from its packaged location; the standalone local service starts and answers a health check.
- On macOS, also verify signatures and notarization (`codesign --verify --deep --strict`, `spctl --assess`) in CI.

## 7. Review checklist

- [ ] IPC handlers have unit tests for sender, argument and path validation.
- [ ] Renderer tests cover both the desktop API present and absent.
- [ ] Integration tests launch Electron with an isolated user-data directory and stubbed dialogs.
- [ ] Linux CI runs under xvfb; `--no-sandbox` (if any) is confined to tests.
- [ ] The packaged app is smoke-tested on every platform, including bundled helpers.
