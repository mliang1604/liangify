---
name: wgsl-style
description: WGSL conventions — naming, file/module organization (shader source in TypeScript modules), struct and uniform buffer layout and alignment rules, packing uniforms from TypeScript, sharing constants between WGSL and TypeScript, and numeric/sampling pitfalls. Use when writing or reviewing WGSL shaders or the TypeScript that fills their buffers.
---

# WGSL Style

The most expensive WGSL bugs are silent: a uniform field read from the wrong byte offset, a constant that differs between the shader and the CPU, a texture sampled with the wrong filter. These conventions make those mismatches hard to write and easy to test.

Check details against the [WGSL spec](https://www.w3.org/TR/WGSL/) — the language still gains extensions (see `navigator.gpu.wgslLanguageFeatures`).

## 1. Naming

- **Types (`struct`) in `PascalCase`**: `Params`, `VSOut`, `Light`.
- **Functions, variables and fields in `camelCase`**: `windowLevel`, `planeToTex`, `slicePos`. Match the TypeScript name of the same quantity exactly, so `grep` finds both sides.
- **Module-scope constants in `UPPER_SNAKE_CASE`**: `const MAX_STEPS: u32 = 512u;`.
- **Name the coordinate space in the name** when a value could be in more than one: `posPatient`, `uvScreen`, `coordTex`, `planeToTex` (a matrix *from* plane *to* texture space). Most geometry bugs are a value in the wrong space.
- **Entry points:** `vsMain`, `fsMain`, `csMain` — or descriptive (`fsSlice`, `csHistogram`) when one module has several.
- Bindings are declared together at the top, ordered by `@group` then `@binding`, with a comment for anything non-obvious (sampler filtering, value encoding).

## 2. Where shader source lives

- **Keep WGSL in TypeScript modules** as exported template strings: `export const SLICE_SHADER = /* wgsl */ \`...\`;`. This works with any bundler (Angular's esbuild builder, for example, has no `?raw` text import), keeps the shader next to the TypeScript that packs its uniforms, and lets the two be reviewed in one diff. The `/* wgsl */` tag (or a `// language=wgsl` comment) enables editor highlighting.
- **One file per pipeline's shader**, named after the pipeline (`slice-shader.ts`, `raycast-shader.ts`). Shared WGSL snippets (colormap lookup, ray-box intersection) go in their own exported strings and are concatenated in — don't copy-paste functions between shaders.
- **Interpolate only constants**, never runtime data: `${MAX_STEPS}` is fine; building shader text from user input or per-frame values is not (and recompiles pipelines).

## 3. Uniform and storage layout

WGSL lays out host-shareable structs with alignment rules that differ from tightly packed TypeScript arrays. Get them wrong and fields silently read from the wrong offset.

Alignment / size of common types:

| Type | Align | Size |
|---|---|---|
| `f32`, `i32`, `u32` | 4 | 4 |
| `vec2<f32>` | 8 | 8 |
| `vec3<f32>` | **16** | 12 |
| `vec4<f32>` | 16 | 16 |
| `mat3x3<f32>` | 16 | **48** (3 columns × 16) |
| `mat4x4<f32>` | 16 | 64 |
| struct | max member align | rounded up to its align |

Rules to follow:

- **Order fields by alignment, largest first** (matrices, then `vec4`s, then `vec2`s, then scalars) to avoid hidden padding.
- **Avoid `vec3` and `mat3x3` in uniform/storage structs.** A `vec3` occupies 16 bytes of alignment, so a following scalar packs into its fourth lane — easy to get wrong on the CPU side. Use `vec4` (put a meaningful scalar in `.w`, or name the padding) and `mat4x4`.
- **Uniform address space, arrays and nested structs:** historically, array elements and nested structs in uniform buffers needed 16-byte alignment (so `array<f32, N>` had a 16-byte stride). The `uniform_buffer_standard_layout` language extension removes that restriction, but don't depend on it unless you've checked `navigator.gpu.wgslLanguageFeatures.has('uniform_buffer_standard_layout')` on every target. For portable code use `array<vec4<f32>, N>`, or a storage buffer for arrays.
- **Document the byte layout** next to the struct and next to the packing function: offset of each block, total size. A comment like `// mat4 (0) + scale.xy, pan.xy (64) + center, width, slicePos, flipX (80) = 96 bytes` pays for itself the first time someone adds a field.
- **Encode booleans as `u32`** (0/1). `bool` isn't host-shareable.
- **Uniform buffers ≤ 64 KiB by default** (`maxUniformBufferBindingSize`); larger or variable-length data goes in a storage buffer.

## 4. Packing from TypeScript

- **One pure packing function per struct**, returning (or filling) a `Float32Array` with a `Uint32Array` view on the same buffer for `u32` fields:

  ```ts
  export const PARAMS_SIZE = 96; // bytes; must match struct Params in slice-shader.ts

  export function packSliceParams(p: SliceParams, out = new ArrayBuffer(PARAMS_SIZE)): ArrayBuffer {
    const f = new Float32Array(out);
    const u = new Uint32Array(out);
    f.set(p.planeToTex, 0);           // mat4x4  @ byte 0
    f[16] = p.scaleX; f[17] = p.scaleY; // vec2  @ 64
    f[18] = p.pan[0]; f[19] = p.pan[1]; // vec2  @ 72
    f[20] = p.windowCenter;             // f32   @ 80
    f[21] = p.windowWidth;              // f32   @ 84
    f[22] = p.slicePos;                 // f32   @ 88
    u[23] = p.flipX ? 1 : 0;            // u32   @ 92
    return out;
  }
  ```

- **Export the byte size** and use it for `createBuffer`. Unit-test that the packer writes exactly that many bytes and that each field lands at its documented offset (read back through the views).
- **Matrices are column-major** in WGSL. A `Float32Array` of 16 in column-major order (the convention of gl-matrix and most graphics libraries) maps directly; a row-major matrix must be transposed. Test this with a non-symmetric matrix.
- **Reuse the output buffer** across frames; don't allocate a new `ArrayBuffer` per draw.

## 5. Sharing constants

A value that exists on both sides — enum codes, maximum counts, sentinel values, LUT sizes — has **one definition in TypeScript**, interpolated into the shader:

```ts
export const enum ProjectionModeCode { Mip = 0, MinIp = 1, Average = 2, Dvr = 3 }
export const MAX_RAY_STEPS = 1024;

export const RAYCAST_SHADER = /* wgsl */ `
const MAX_RAY_STEPS: u32 = ${MAX_RAY_STEPS}u;
const MODE_MIP: u32 = ${ProjectionModeCode.Mip}u;
const MODE_DVR: u32 = ${ProjectionModeCode.Dvr}u;
// ...
`;
```

- Use **pipeline-overridable constants** (`override MAX_STEPS: u32 = 512u;` with `constants: { MAX_STEPS: n }` in the pipeline descriptor) when the value varies per pipeline but is fixed for its lifetime.
- Never hand-copy a number into WGSL that also appears in TypeScript.

## 6. Numerics and sampling

- **Filtering:** intensities use a linear sampler; **label/id textures use `nearest`** (or `textureLoad`) — interpolating ids invents labels. Integer-format textures can't be filtered at all.
- **Sample at texel centers:** texture coordinate `(i + 0.5) / size` addresses texel `i`. Off-by-half-texel errors shift the whole image.
- **Uniform control flow:** `textureSample` (implicit derivatives) must be called in uniform control flow in fragment shaders. Inside data-dependent loops or branches (raymarching), use `textureSampleLevel(..., 0.0)`.
- **Guard divisions** by values that can be zero (window width, ray direction components) — `max(w, 1e-6)` — since the GPU won't throw, it'll produce `inf`/`NaN` pixels.
- **Clamp loop counts** to a constant maximum; unbounded loops can hang the GPU and trigger device loss.
- **Prefer `select`** over branching for simple per-pixel choices.
- **Precision:** `f32` everywhere unless the `shader-f16` feature is enabled and you've measured a benefit. Remember `f32` has ~7 significant digits: express positions relative to a nearby origin (volume center) rather than large absolute patient coordinates.

## 7. Comments

- A header comment per shader: what it renders, what space its inputs are in, which TypeScript module packs its uniforms.
- Comment each struct field with its meaning and units/space (`// mm, patient LPS`), and each binding with its format and filtering.
- When the shader mirrors CPU code, say so and name the file (see [shader-cpu-parity](../shader-cpu-parity/SKILL.md)).
