---
name: shader-cpu-parity
description: Keeping GPU shader math and CPU code consistent when both implement the same geometry, often in opposite directions (e.g. a reslice fragment shader mapping screen→voxel and a CPU cursor probe, picking, measurements or overlays doing the same or the inverse). Covers shared pure helpers, single-source transforms, change discipline and round-trip tests. Use when editing a shader's geometry, or CPU code that must agree with what the shader draws.
---

# Shader / CPU Parity

In a rendering app the same mapping often exists twice:

- the **fragment shader** maps a screen pixel → pane UV → plane → patient/texture coordinate to decide *what to draw*;
- the **CPU** maps a mouse position through the same chain to decide *what the user pointed at* (voxel probe, picking, crosshair, measurement endpoints, annotations, ROI hit-testing) — or runs it backwards to place an overlay at a voxel.

If the two disagree by even half a pixel, the probe reports a different value than the one displayed, a click selects the wrong structure, or overlays drift as you zoom. Nothing crashes; the numbers are just wrong — which in a medical viewer is the worst kind of bug.

## 1. One source of truth for each transform

- **Build every matrix once, on the CPU**, in a pure function (`planeToTex(volume, orientation, slicePos)`, `paneTransform(rect, zoom, pan, aspect)`). The shader receives the matrix as a uniform; the CPU inverse uses the *same function's output* (or its inverse). The shader should not re-derive a matrix from raw parameters the CPU also derives it from.
- **Decompose the chain into named steps** with one helper per step: framebuffer px → pane UV → centered UV (aspect fit) → panned/zoomed UV → plane (u, v, slicePos) → texture/patient. Each step is a pure function in TypeScript.
- **Mirror each step in WGSL with the same name and the same order**, and keep the shader's arithmetic a direct transcription: if the TypeScript helper is `(uv - 0.5) * scale + pan`, the WGSL is `(uv - 0.5) * P.scale + P.pan`, not an algebraically equivalent rearrangement.
- **Inverses are written as inverses of the helpers**, step by step (`unpan`, `unfit`, …), not as a fresh derivation.
- Where the GPU does something the CPU must reproduce exactly (window/level, colormap index, interpolation), put that formula in a shared helper too, and have the shader mirror it.

## 2. Make the coupling visible

- At the top of the shader and of each CPU counterpart, **name the other side**: `// Mirrors probe.ts:probeVoxel and pan-zoom.ts:aspectScale — change together.`
- In the repo's `CLAUDE.md` / contributor docs, list the coupled pairs (e.g. `slice-shader.ts` ↔ `probe.ts`, `raycast-shader.ts` ↔ `pick.ts`). Agents and new contributors won't infer it.
- Keep coupled files in the same directory.

## 3. Change discipline

When you change geometry on one side:

1. **Find every counterpart** — search for the helper and uniform names, and check the listed pairs. Include overlays, reference lines, crosshairs, annotations and measurement tools, not just the probe.
2. **Change both sides in the same commit.** A commit that changes only the shader's mapping is a bug, even if it looks right on screen.
3. **Update or add a test that pins the behavior** (below) *before* touching the shader, so it fails if only one side changes.
4. **Check visually at non-trivial settings**: zoomed in, panned, non-square pane, anisotropic voxel spacing, flipped/mirrored view, oblique plane. Default settings hide most mismatches.

## 4. Tests that pin parity

You usually can't read GPU pixels back in CI, so test the shared helpers and the CPU mirror thoroughly — the shader is a transcription of them.

- **Round trip:** for random pane rects, zooms, pans and slice positions, `screenToVoxel(voxelToScreen(v)) ≈ v` and vice versa, within a tight tolerance.
- **Known answers:** the pane center at zoom 1, pan 0 maps to the volume center; a pixel at the left edge maps to voxel 0 (or the letterbox, explicitly); flipping X mirrors the column index.
- **Anisotropy and obliquity:** spacing like `[0.7, 0.7, 3.0]` and a gantry-tilted orientation — the cases where wrong axis order or a missing spacing factor shows up.
- **Letterbox/outside:** points in the letterbox or outside the volume return `null`/"outside" on the CPU, matching what the shader renders (background, not a clamped edge voxel).
- **Texel centers:** a probe exactly on a voxel's center returns that voxel; ±0.49 voxel still does; ±0.51 doesn't.
- **Uniform packing:** the values the CPU helpers produce are what lands in the uniform buffer at the right offsets (see [wgsl-style](../wgsl-style/SKILL.md)).
- When a mismatch is found in the field, **add a regression test with those exact parameters** before fixing.

If a GPU is available in some environment (a developer machine, a self-hosted runner), an optional end-to-end check that renders a synthetic volume with a known pattern and compares the probe value to a read-back pixel is worthwhile. Keep it out of the default CI path (see [webgpu-testing](../webgpu-testing/SKILL.md)).

## 5. Smells

- The shader computes aspect ratio, zoom or pan differently from the TypeScript helper "because it's simpler in WGSL".
- A magic constant (`0.5`, a half-texel offset, a flip) appears on one side only.
- CPU picking that re-implements the mapping inline instead of calling the shared helpers.
- A fix described as "adjusted the probe offset by one pixel" — that's a symptom of two diverged mappings, not a fix.
- Tests that only cover zoom 1, pan 0, square panes and isotropic spacing.
