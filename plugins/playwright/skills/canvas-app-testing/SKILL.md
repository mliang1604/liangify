---
name: canvas-app-testing
description: End-to-end testing apps whose main output is a <canvas> (WebGPU/WebGL viewers, editors, charts) — asserting on application state, readouts and DOM overlays instead of pixels, exposing test hooks safely, driving pointer/wheel/keyboard interactions at canvas coordinates, when screenshot comparison is worth it and how to make it stable, and degrading gracefully when WebGPU is unavailable. Use when writing E2E tests for a canvas-based UI or deciding how to verify rendering.
---

# Canvas App Testing

A `<canvas>` is opaque to Playwright's locators: there's no DOM to query inside it. And pixels are a poor oracle — they vary by GPU, driver, browser version and anti-aliasing, and are often unavailable headlessly. So test **what the canvas is supposed to show** through the state and DOM around it, and reserve pixel comparison for the few cases where it's the only way to catch a bug.

## 1. What to assert instead of pixels

Ranked from most to least robust:

1. **DOM overlays and readouts** the app already renders: orientation labels, slice index, window/level values, a voxel probe readout ("−12 HU at (120, 88, 40)"), ROI lists, measurement results, scale bars, status messages. These are what users read; assert them with locators.
2. **Readiness and state signals**: a control that enables when the renderer is ready, `data-state="ready"` on the canvas container, `aria-busy` while loading.
3. **Application state** read through a deliberate test hook (§2): current camera, zoom/pan, selected structure, loaded series UIDs, last rendered frame parameters.
4. **Error signals**: no `pageerror`s, no WebGPU/WebGL validation errors in the console (collect them and fail; for Chromium, messages like *"Error while parsing WGSL"* or *"... is invalid due to a previous error"*).
5. **Pixels** — only as described in §4.

Pair interactions with these assertions: *drag to pan → probe readout under a fixed screen point changes as expected*; *wheel → slice index increments*; *window/level drag → W/L readout changes*. That tests input handling, the geometry, and the shader/CPU agreement (see the `webgpu` plugin's `shader-cpu-parity` skill, if installed) without reading a pixel.

## 2. Test hooks, safely

When state isn't visible in the DOM, expose a **small, read-only, test-only** view of it:

```ts
// app: only when built/launched for E2E
if (environment.e2e) {
  (window as unknown as { __viewerTest?: ViewerTestApi }).__viewerTest = {
    state: () => ({ ready: viewer.isReady(), zoom: viewer.zoom(), sliceIndex: viewer.sliceIndex(), seriesUid: viewer.seriesUid() }),
    frames: () => renderer.frameCount(),
  };
}

// test
await expect.poll(() => page.evaluate(() => window.__viewerTest!.state().ready)).toBe(true);
const before = await page.evaluate(() => window.__viewerTest!.state().zoom);
```

- **Read-only, minimal, and absent from production builds** (compile-time flag), so it can't become an API or a security hole.
- Prefer adding a visible readout or a `data-*` attribute when the information is useful to users or for accessibility anyway.
- Don't use hooks to *drive* the app — interact through real input events so the test covers the input path.

## 3. Driving the canvas

- Compute coordinates **relative to the canvas bounding box** (`await canvas.boundingBox()`), in CSS pixels, not device pixels.
- For multi-pane layouts, get each pane's rectangle from the app (DOM overlay positions or the test hook) rather than hard-coding fractions.
- Use `page.mouse.move/down/up` with intermediate `steps` for drags, `page.mouse.wheel(0, dy)` for scrolling, modifiers via `page.keyboard.down('Alt')`, and the right button with `{ button: 'right' }`. Middle-button and pointer-capture behavior varies — test it explicitly if the app uses it.
- After an interaction, **wait for the state change**, not for time: `await expect(readout).toHaveText(...)` or `expect.poll` on the hook.
- Set a **fixed viewport and device scale factor** in the project config so coordinates are reproducible.

## 4. Screenshots: when they're worth it and how

Worth it for: regressions only visible in pixels (colormap mapping, overlay compositing order, contour rendering, letterboxing), and only when a stable rendering environment exists.

Make them stable:

- Run them in a **separate project** on a **known machine/GPU and pinned browser**, never in the required GPU-less CI job (see [playwright-ci](../playwright-ci/SKILL.md)).
- Render **deterministic synthetic scenes** (a known gradient volume, fixed window/level, fixed camera), with animations and cursors disabled (`animations: 'disabled'`, `caret: 'hide'`).
- Compare **the canvas element only** (`await expect(canvas).toHaveScreenshot('axial-ramp.png', { maxDiffPixelRatio: 0.01 })`), masking volatile overlays (`mask: [page.getByTestId('fps')]`).
- Use a **tolerance** (`maxDiffPixelRatio` / `threshold`) tuned once; review baseline updates (`--update-snapshots`) as code changes, with the reason in the commit.
- Prefer **probe-style pixel checks** over full images where possible: read a few known points (via `canvas` read-back or the test hook) and assert their values within a tolerance.

## 5. When WebGPU (or WebGL) is unavailable

The app must handle "no GPU" gracefully, and tests must check that it does:

```ts
const webgpu = await page.evaluate(async () => {
  try { return !!(await navigator.gpu?.requestAdapter()); } catch { return false; }
});
if (webgpu) {
  await expect(page.getByRole('button', { name: /layout/i })).toBeEnabled({ timeout: 30_000 });
  // ... rendering-path assertions (DOM overlays, readouts, no GPU validation errors)
} else {
  await expect(page.getByRole('status')).toContainText(/webgpu/i);  // clear message, no crash
  test.info().annotations.push({ type: 'note', description: 'WebGPU unavailable; rendering assertions skipped' });
}
```

- **Branch, don't skip**: the no-GPU path is a product requirement and gets real assertions (clear message, non-GPU features still usable, no uncaught errors).
- **Annotate** which branch ran, so a suite that never exercised the GPU path is visible in reports. Consider failing a dedicated "GPU" project if it unexpectedly ran without a GPU.
- Detect capability **inside the page** (it's the page's environment that matters), after navigation.
- Device loss: if the app supports recovery, a test hook or debug control that triggers `device.destroy()` lets you test the "GPU was reset" path.

## 6. Review checklist

- [ ] Rendering is verified through DOM overlays, readouts, readiness and state — not pixels by default.
- [ ] Test hooks are read-only, minimal and compiled out of production.
- [ ] Canvas interactions use bounding-box-relative coordinates with fixed viewport/DPR, and wait on state changes.
- [ ] GPU/console validation errors and page errors fail the test.
- [ ] Screenshot tests isolated to a stable GPU environment, canvas-scoped, masked and toleranced.
- [ ] The no-WebGPU path is asserted, and which path ran is annotated.
