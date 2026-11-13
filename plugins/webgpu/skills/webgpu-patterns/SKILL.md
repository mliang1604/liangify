---
name: webgpu-patterns
description: WebGPU application patterns in TypeScript — adapter/device setup with graceful failure, limits and feature checks, canvas configuration, pipeline/bind-group/buffer layout conventions, texture format choices (e.g. `r16float` volumes), explicit `destroy()` and resource lifetime, device-loss and uncaptured-error handling, and avoiding per-frame allocations. Use when writing or reviewing code that calls `navigator.gpu`, `GPUDevice`, pipelines, buffers or textures.
---

# WebGPU Patterns

WebGPU is explicit: nothing is created, freed, recovered or synchronized unless you do it. Most WebGPU bugs are lifetime bugs (leaks, use-after-destroy), layout bugs (CPU and WGSL disagree on bytes), or silent failures (a validation error that produces a blank frame instead of an exception). These patterns target all three.

Verify API details against the current spec ([gpuweb.github.io/gpuweb](https://gpuweb.github.io/gpuweb/)) and [MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API) — implementations still add features and relax limits.

## 1. Initialization and graceful failure

WebGPU is not available everywhere: as of 2026 it ships in Chromium, Safari 26 and Firefox (Windows, Apple-silicon macOS), while Linux support is still uneven and CI runners usually have no GPU at all. Treat "no WebGPU" as an expected state, not a crash.

```ts
export class WebGpuUnavailableError extends Error {}

export async function initWebGpu(canvas: HTMLCanvasElement, handlers: GpuHandlers = {}) {
  if (!navigator.gpu) throw new WebGpuUnavailableError('WebGPU is not available in this browser.');

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new WebGpuUnavailableError('No suitable GPU adapter was found.');

  const requiredFeatures = (['float32-filterable'] as const).filter(f => adapter.features.has(f));
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: { maxTextureDimension3D: adapter.limits.maxTextureDimension3D },
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new WebGpuUnavailableError('Could not create a WebGPU canvas context.');

  void device.lost.then(info => { if (info.reason !== 'destroyed') handlers.onDeviceLost?.(info); });
  device.addEventListener('uncapturederror', e => handlers.onUncapturedError?.((e as GPUUncapturedErrorEvent).error));

  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });
  return { device, context, format, canvas, features: new Set(requiredFeatures) };
}
```

- **Throw a typed "unavailable" error** for each distinct failure (no API, no adapter, no context) and let the UI show a clear message. Never let a missing `navigator.gpu` surface as `TypeError: cannot read properties of undefined`.
- **`requestAdapter()` resolves to `null`** rather than throwing when there's no usable adapter. Check it.
- **Request only optional features you actually use, and only if the adapter has them.** `requestDevice` rejects if you ask for something the adapter lacks. Record what you got so the code can branch (e.g. sample `r32float` with filtering only if `float32-filterable` was granted).
- **Ask for limits explicitly when you need more than the defaults** (large 3D textures, big storage buffers), capped at `adapter.limits`. The device only gets the default limits unless you ask.
- **Initialize once per canvas**, keep the result in one owner object (a renderer class or service), and pass the device to helpers rather than reaching for globals.

## 2. Device loss and uncaptured errors

- **`device.lost` resolves once** — when the driver resets, the GPU is removed, the browser reclaims it, or you call `device.destroy()`. Ignore `reason === 'destroyed'` (your own teardown); anything else should move the UI to a recoverable state ("GPU was reset — reload view") and allow a fresh `initWebGpu`. Every resource from the lost device is dead; rebuild them all from CPU-side state.
- **Keep the CPU-side source of truth** (volume data, parameters, camera) so recovery is "re-init and re-upload", not "reload the app".
- **Listen for `uncapturederror`.** Validation and out-of-memory errors don't throw; without a listener they only reach the console and you get a blank frame. Log them with context, and surface them in development.
- **Use error scopes around risky creation** — large allocations, pipelines built from generated WGSL:

  ```ts
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('validation');
  const texture = device.createTexture(desc);
  const validation = await device.popErrorScope();
  const oom = await device.popErrorScope();
  if (validation || oom) { texture.destroy(); throw new Error((validation ?? oom)!.message); }
  ```

- **Check shader compilation** in development with `await module.getCompilationInfo()` and report messages with line numbers. Prefer `createRenderPipelineAsync` / `createComputePipelineAsync` for pipelines built at load time: they reject with a `GPUPipelineError` instead of producing an invalid pipeline, and don't block the main thread.

## 3. Resource lifetime: explicit `destroy()`

GPU memory is not reclaimed promptly by garbage collection. A 512³ `r16float` volume is 256 MB of VRAM; leaking a few on reload exhausts the GPU.

- **Every `GPUBuffer`, `GPUTexture` and `GPUQuerySet` you create has one owner who calls `destroy()`.** Pipelines, bind groups, samplers, shader modules and layouts have no `destroy()` — drop references to them.
- **Destroy before replace.** When loading a new volume, `this.texture?.destroy()` then create; and rebuild any bind group that referenced the old view (a bind group holding a destroyed texture fails validation when used).
- **Owner exposes a `dispose()`** that destroys everything it created, wired to component teardown (`DestroyRef.onDestroy` in Angular). Make it idempotent.
- **Don't destroy in-flight resources mid-frame.** `destroy()` is safe after `queue.submit` (the GPU finishes queued work), but don't destroy something that a command encoder you're still recording refers to.
- **Size guards before allocation.** Check `device.limits` (`maxTextureDimension3D`, `maxBufferSize`, `maxStorageBufferBindingSize`) and fail with a message naming the dimensions and the limit, instead of a generic validation error.

## 4. Pipelines, bind groups and buffers

- **Create pipelines and layouts once** (at init or first use), never per frame. Prefer an **explicit `GPUBindGroupLayout` / `GPUPipelineLayout`** over `layout: 'auto'` when several pipelines share bind groups, or when bind groups are built separately from the pipeline: `'auto'` layouts aren't interchangeable between pipelines.
- **Group bindings by update frequency**: group 0 per-frame/global (camera, time), group 1 per-material or per-volume (textures, LUTs, samplers), group 2 per-draw (object params). Rebinding a group invalidates the ones after it.
- **Bind groups are cheap but not free.** Cache them keyed by the resources they reference; rebuild only when a referenced resource is replaced.
- **Uniform buffers:** one buffer per pane/draw with a fixed size, updated with `queue.writeBuffer`. Pack with a dedicated, tested function (see [wgsl-style](../wgsl-style/SKILL.md) for layout rules) and write from a reused `Float32Array`. `minUniformBufferOffsetAlignment` (usually 256) applies if you suballocate one buffer with dynamic offsets.
- **Usage flags are minimal and explicit:** `UNIFORM | COPY_DST` for uniforms, `TEXTURE_BINDING | COPY_DST` for uploaded textures, add `RENDER_ATTACHMENT` / `STORAGE_BINDING` / `COPY_SRC` only when used.
- **Upload with `queue.writeBuffer` / `queue.writeTexture`.** For textures, `bytesPerRow` must match the data layout you pass (`writeTexture` has no 256-byte alignment rule; `copyBufferToTexture` does). Use `mappedAtCreation` for large one-time buffer uploads you can fill directly.
- **Partial updates:** re-upload only the changed sub-region (`writeTexture` with an `origin` and a smaller `size`) — e.g. a brush stroke touching a small box of a label volume — instead of re-encoding the whole texture.

## 5. Texture formats and feature checks

- **Volumes: `r16float`** is a good default for CT/MR intensities — half the memory of `r32float`, filterable on every implementation, and integers are exact up to 2048 (so it also works for label ids sampled with `nearest`). Convert from `Float32Array` to half on the CPU once at upload.
- **`r32float`** is only filterable with the optional `float32-filterable` feature. Without it, sample with `textureLoad` or a non-filtering sampler, or fall back to `r16float`.
- **Integer labels:** `r8uint` / `r16uint` with `textureLoad` (integer textures can't be filtered). Never linearly interpolate label ids.
- **`shader-f16`** (optional feature) is needed to use `f16` *in WGSL arithmetic*. It's unrelated to `r16float` textures, which sample as `f32`.
- **Canvas format:** always `navigator.gpu.getPreferredCanvasFormat()` (`bgra8unorm` or `rgba8unorm` depending on the platform) — don't hard-code it.
- **Lookup tables** (colormaps, transfer functions): a small `1d` or `2d` `rgba8unorm` texture with a linear sampler.

## 6. Frame loop and allocations

- **Render on demand**, not in a perpetual `requestAnimationFrame` loop: schedule one frame when state changes (coalescing multiple changes into one rAF). Continuous loops waste battery on a mostly static medical viewer.
- **No per-frame allocation of GPU objects** (buffers, textures, bind groups, pipelines). Per-frame JS allocations (`new Float32Array`, closures, arrays of descriptors) also add GC pauses; reuse scratch arrays.
- **One command encoder and one `queue.submit` per frame** where possible; several passes can share an encoder.
- **Resize correctly:** size the canvas backing store from `ResizeObserver` with `devicePixelContentBoxSize` (fall back to `contentRect × devicePixelRatio`), clamp to `maxTextureDimension2D`, and re-render. Recreate depth/offscreen targets on resize; destroy the old ones.
- **Viewports and scissors** let several panes share one canvas and one render pass. Keep pane rectangles in framebuffer pixels, computed by a pure, tested layout function.
- **Interactive LOD:** reduce expensive work (raymarch step count, resolution) while the user is dragging, then render a full-quality frame when interaction settles.

## 7. Structure

- Keep **GPU objects in one renderer class** that owns lifecycle (what to (re)build when), and keep **descriptor construction and parameter packing in pure functions** that take the device and data. The pure parts are unit-testable; the class stays small.
- Keep **geometry math out of the renderer** — in pure helpers shared with CPU code (see [shader-cpu-parity](../shader-cpu-parity/SKILL.md)).
- Framework code (Angular components, signals) talks to the renderer through a narrow API (`load(volume)`, `setParams(...)`, `render()`, `dispose()`); it never touches `GPUDevice` directly.

## 8. Review checklist

- [ ] Missing WebGPU, missing adapter and missing context each produce a clear, typed error and a usable UI state.
- [ ] Optional features and raised limits are requested only when the adapter supports them.
- [ ] `device.lost` and `uncapturederror` are handled.
- [ ] Every created buffer/texture/query set has an owner that destroys it; replaced resources are destroyed and their bind groups rebuilt.
- [ ] No pipelines, bind groups, buffers or textures are created per frame.
- [ ] Uniform packing is a pure function with a test, and its size matches the WGSL struct.
- [ ] Allocation sizes are checked against `device.limits` with a helpful message.
