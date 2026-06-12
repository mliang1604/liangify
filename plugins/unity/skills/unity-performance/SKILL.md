---
name: unity-performance
description: Unity runtime performance discipline — per-frame allocation hygiene, object pooling, physics query patterns, batching/draw calls, profiling-first workflow. Use when writing code that runs in hot paths (Update/FixedUpdate, spawners, projectiles, per-enemy logic) or investigating frame rate, GC spikes, or memory.
---

# Unity Performance Discipline

Frame rate is a feature. The two recurring killers in gameplay code are **per-frame GC allocations** and **per-frame lookups** — both invisible in a quick read, both cheap to avoid at write time.

## 1. Profile before optimizing

- Suspected problem → **Profiler** (CPU/GPU/memory), **Frame Debugger** (draw calls), **Memory Profiler** (leaks, asset duplication). Name the actual cost before changing code.
- Wrap suspicious systems in `ProfilerMarker` so they're visible by name:

```csharp
static readonly ProfilerMarker s_AilmentTick = new("Ailments.Tick");
using (s_AilmentTick.Auto()) { TickAll(dt); }
```

- Optimizations land with before/after numbers, or they're refactors, not optimizations.

## 2. Zero allocations in hot paths

In `Update`/`FixedUpdate` and anything per-enemy/per-projectile:

- No LINQ, no lambdas capturing locals (closure alloc), no `string` concat/interpolation, no boxing (struct → `object`/interface, enum dictionary keys without a comparer).
- Reuse collections: clear-and-refill a cached `List<T>` instead of `new`; preallocate to expected capacity.
- `foreach` over `List<T>`/arrays is fine (struct enumerators); `foreach` over an `IEnumerable<T>`-typed variable allocates.
- `CompareTag("Enemy")` over `tag == "Enemy"` (the property allocates a string).
- Incremental GC smooths spikes but doesn't excuse steady-state garbage — the budget for hot-path allocation is zero.

## 3. Pool everything that churns

Projectiles, VFX, damage numbers, enemies — anything spawned in waves:

```csharp
private ObjectPool<Projectile> pool;        // UnityEngine.Pool
pool = new(() => Instantiate(prefab),
           p => p.gameObject.SetActive(true),
           p => p.gameObject.SetActive(false),
           defaultCapacity: 64);
```

- Pooled objects need an explicit `Reset()` — stale state from the previous life is the classic pooling bug.
- `Instantiate`/`Destroy` churn costs both the spawn spike and the later GC; pools convert it to `SetActive` flips.

## 4. Physics

- NonAlloc queries with preallocated buffers: `Physics.OverlapSphereNonAlloc(pos, r, results, mask)` — never the allocating variants in hot paths.
- Always pass a **LayerMask**; unmasked queries test everything.
- Physics work in `FixedUpdate`; movement of kinematic actors via `Rigidbody.MovePosition`, not `Transform` writes (which desync the physics scene).
- Many moving hitboxes → consider a single spatial query per system per tick rather than per-entity queries.

## 5. Lookups and references

- Cache components/transforms in `Awake`. A `GetComponent` per frame per enemy is a frame-time tax with no upside.
- No `Find*`/`FindObjectsByType` outside initialization. Systems that need "all enemies" maintain a registry (enemies register `OnEnable`, unregister `OnDisable`).
- `transform` is cheap, but cache it too when used many times per frame in tight loops.

## 6. Rendering basics (URP)

- Keep materials **SRP Batcher**-compatible (shader-graph/URP-lit variants of one shader, properties per-material — not per-renderer `MaterialPropertyBlock`s that break batching, and never `renderer.material` at runtime, which silently clones the material).
- Unity 6: enable **GPU Resident Drawer** + GPU occlusion culling for large instance counts (crowds, projectiles, foliage).
- Atlas small textures; fewer unique materials = fewer batches. Verify with Frame Debugger, not intuition.
- LOD groups and culling distances for anything spawned at density.

## 7. Smells to flag in review

- Any `new`, LINQ, `$"..."`, or lambda inside `Update`/`FixedUpdate`/per-tick loops.
- Allocating physics queries (`Physics.OverlapSphere`, `RaycastAll`) in gameplay code.
- `Instantiate`/`Destroy` in a loop or per-shot path without a pool.
- `renderer.material` (clone) where `sharedMaterial` or a property block is intended.
- `tag ==` string comparison; missing LayerMasks; `Find*` outside init.
- Pooled prefab without a `Reset()`/re-init path.
- "Optimization" commits with no profiler numbers attached.
