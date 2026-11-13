---
name: webgpu-testing
description: Testing WebGPU code where CI runners have no GPU — unit-testing pure geometry, layout and uniform-packing helpers without a device, faking `navigator.gpu` for init/error-path tests, what can and can't be asserted in CI, and Playwright checks that use real WebGPU when available and degrade to DOM-level assertions when it isn't. Use when writing or reviewing tests for rendering code.
---

# WebGPU Testing

Most CI runners have no GPU, headless WebGPU support varies by browser and platform, and pixels from a GPU are hard to read back and compare deterministically. So structure the code so that **almost everything worth testing runs without a GPU**, and keep the GPU-dependent tests small and tolerant.

## 1. Testing pyramid for rendering code

| Layer | Runs on | Asserts |
|---|---|---|
| **Pure helpers** (geometry, layout, pan/zoom, window/level, colormaps, transfer functions, uniform packing, half-float conversion) | Unit tests (Vitest/jsdom or Node) — every CI run | Exact numbers, round trips, edge cases |
| **Renderer orchestration** with a fake device | Unit tests | Which resources are created/destroyed/rebuilt when; error paths |
| **Init and failure paths** with a fake `navigator.gpu` | Unit tests | Typed errors, device-loss and uncaptured-error handlers |
| **End-to-end in a browser** | Playwright — CI (degrading) and GPU machines | The app comes up, pipelines compile without validation errors, the UI reflects state; pixel checks only where a GPU is guaranteed |

If a behavior can only be tested at the top layer, that's usually a sign the logic should move into a pure helper.

## 2. Pure helpers: the bulk of the tests

- Keep all math out of the renderer class and out of WGSL-only code, in pure exported functions (see [webgpu-patterns](../webgpu-patterns/SKILL.md) §7 and [shader-cpu-parity](../shader-cpu-parity/SKILL.md)).
- Test with **non-trivial parameters**: non-square panes, zoom ≠ 1, non-zero pan, anisotropic spacing, oblique orientation, flipped axes. Use `toBeCloseTo` with an explicit precision for floating-point results.
- **Uniform packing:** assert the byte length equals the exported size constant, and read fields back through `Float32Array`/`Uint32Array` views at their documented offsets. Use a non-symmetric matrix so a transposition bug fails.
- **Half-float conversion:** known values (0, 1, −2, 65504, smallest subnormal, NaN, ±Infinity) and integers up to 2048 round-trip exactly.
- **Property-style round trips** (a loop over seeded random inputs) catch inverse-mapping bugs that hand-picked cases miss. Seed the generator so failures reproduce.

## 3. Fakes instead of a GPU

- **Fake `navigator.gpu`** to test initialization and failure handling: no `navigator.gpu`; `requestAdapter()` resolving `null`; `getContext('webgpu')` returning `null`; a device whose `lost` promise you resolve (with `reason: 'destroyed'` and `'unknown'`); an `uncapturederror` dispatch. Install with `Object.defineProperty(navigator, 'gpu', { configurable: true, value })` and **restore the original in `afterEach`**.
- **Fake device for orchestration tests:** an object whose `createBuffer` / `createTexture` return stubs with a `destroy: vi.fn()`, and whose `queue.writeBuffer` / `writeTexture` are spies. Assert lifecycle, not GPU behavior:
  - loading a second volume destroys the first texture and rebuilds dependent bind groups;
  - `dispose()` destroys everything created, and is idempotent;
  - a parameter change writes the uniform buffer but creates nothing new;
  - an oversized volume is rejected against `device.limits` with a clear message.
- jsdom has no WebGPU constants: define the few globals the code under test uses (`GPUBufferUsage`, `GPUTextureUsage`, `GPUShaderStage`) in a test setup file, with the spec's numeric values.
- **Don't over-fake.** A fake that re-implements WebGPU validation is a second implementation to maintain. Fake only what the unit touches and test validation-sensitive things (layouts, shader compilation) in the browser layer.

## 4. What CI without a GPU can and can't assert

Can:

- All pure logic, packing and lifecycle (above).
- That WGSL **parses and validates**, if a real WebGPU implementation is available headlessly (some runners expose a software adapter). Treat it as a bonus, not a guarantee.
- That the app **degrades gracefully** when WebGPU is missing: a clear message, no uncaught errors, non-GPU features still work.
- DOM-level outcomes: controls enabled once the renderer is ready, labels/overlays shown, status text, canvas sized.

Can't (reliably):

- **Pixel output.** Software adapters and different GPUs produce slightly different results; read-back of a canvas in headless browsers is often unreliable. Don't put pixel comparisons on the required CI path.
- Performance and frame timing.
- Driver-specific bugs. Those need real-hardware runs (developer machines, a self-hosted GPU runner, or periodic manual checks) on each target platform.

## 5. Playwright: use WebGPU when present, degrade when not

```ts
async function hasWebGpu(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try { return !!(await navigator.gpu?.requestAdapter()); } catch { return false; }
  });
}

test('loads a synthetic volume', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', e => pageErrors.push(String(e)));

  // WebGPU validation failures don't throw; Chromium logs them. Collect them.
  const gpuErrors: string[] = [];
  const GPU_ERROR = /error while parsing wgsl|invalid due to a previous error|invalid (shadermodule|renderpipeline|bindgrouplayout|computepipeline)/i;
  page.on('console', m => { if (GPU_ERROR.test(m.text())) gpuErrors.push(m.text().split('\n')[0]); });

  await page.goto('/');
  const webgpu = await hasWebGpu(page);
  await loadSyntheticSeries(page);

  if (webgpu) {
    await expect(page.getByRole('button', { name: /layout/i })).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByText(/axial/i)).toBeVisible();      // DOM proxy for "panes are live"
    expect(gpuErrors, gpuErrors.join('\n')).toEqual([]);
  } else {
    await expect(page.locator('.status')).toContainText(/webgpu/i);
    test.info().annotations.push({ type: 'note', description: 'WebGPU unavailable; render assertions skipped.' });
  }
  expect(pageErrors, pageErrors.join('\n')).toEqual([]);
});
```

- **Detect, then branch** — don't `test.skip()` the whole test when WebGPU is missing; the no-GPU branch is itself a requirement (graceful degradation).
- **Annotate** which branch ran so a run that never exercised the GPU path is visible in the report.
- **Capture console WebGPU validation errors** and `pageerror`s, and fail on them. That's the most valuable headless signal: a broken shader or bind-group layout shows up there even when you can't see pixels.
- **Assert at the DOM level**: readiness flags, enabled controls, overlay labels, probe readouts, status text. Expose a readiness signal in the UI (a disabled control that enables, a `data-state` attribute) rather than sleeping.
- **Chromium flags** for WebGPU in automation: `--enable-unsafe-webgpu` and, on Linux, `--enable-features=Vulkan` (check current Chromium docs; these change). Serve over `http://localhost` — WebGPU requires a secure context.
- **Synthetic fixtures** only: generate test volumes with a known pattern in the test (or commit small synthetic files). Never real patient data.
- **Pixel/screenshot tests** (`toHaveScreenshot`) belong in a separate, opt-in project that runs on a known GPU machine, with a tolerance (`maxDiffPixelRatio`) and a pinned browser version. Prefer asserting probe values (CPU) against a known synthetic pattern over comparing images.

See the `playwright` plugin's `canvas-app-testing` skill, if installed, for more on testing canvas-centric apps.

## 6. Review checklist

- [ ] New geometry or packing logic has unit tests with non-trivial parameters, runnable without a GPU.
- [ ] Init failure paths and device loss are covered with a fake `navigator.gpu`.
- [ ] Resource lifecycle (create/replace/dispose) is tested against a fake device.
- [ ] E2E tests branch on WebGPU availability, fail on console validation errors, and assert the no-GPU path degrades cleanly.
- [ ] No pixel comparisons on the required CI path.
