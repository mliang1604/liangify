---
name: unity-patterns
description: Unity 6 C# scripting conventions — lifecycle, serialization, Unity null semantics, component access, Awaitable async, ScriptableObject data, asmdef architecture. Use when writing or reviewing Unity C# scripts, MonoBehaviours, or project/code architecture.
---

# Unity Patterns (Unity 6, C#)

Modern Unity conventions. In an older codebase, match existing style and surface migrations as separate work.

## 1. Unity null semantics — the #1 AI-written-code bug

`UnityEngine.Object` overloads `==`. A *destroyed* object is not C#-null but compares equal to `null`. The C# null operators bypass the overload and lie about destroyed objects:

```csharp
// WRONG on UnityEngine.Object types — miss destroyed objects:
target?.TakeDamage(dmg);
var t = target ?? fallback;
if (target is null) { ... }

// RIGHT:
if (target) target.TakeDamage(dmg);     // implicit bool = alive check
if (target == null) target = fallback;
```

Never use `?.`, `??`, `??=`, `is null`, or `is not null` on anything deriving from `UnityEngine.Object`. Plain C# classes — use them freely.

## 2. Serialization

- `[SerializeField] private` over `public` fields — inspector access without API surface.
- Renaming a serialized field drops its data everywhere it's used; rename with `[FormerlySerializedAs("oldName")]`, remove the attribute a release later.
- Inspector references over runtime lookup: a serialized reference is free and fails loudly (visible in inspector); a `Find` at runtime is slow and fails late.

## 3. Component access

- Cache in `Awake`; never `GetComponent`/`Find*` per-frame.
- `TryGetComponent` over `GetComponent` + null check.
- `FindObjectOfType` is deprecated → `FindFirstObjectByType<T>()`, or `FindObjectsByType<T>(FindObjectsSortMode.None)` (unsorted is much faster). Treat any scene-wide find as initialization-only code.
- `[RequireComponent(typeof(Rigidbody))]` to make dependencies structural instead of runtime-checked.

## 4. Lifecycle discipline

- `Awake` — self-initialization only (own components, own state). Other objects' `Awake` order is undefined.
- `Start` — first contact with other objects.
- `OnEnable`/`OnDisable` — symmetric event subscribe/unsubscribe. Asymmetry here is the classic leak/double-fire bug.
- Script Execution Order settings are a smell at scale; prefer explicit initialization (a bootstrap/composition root) over ordering tweaks.

## 5. Async: Awaitable over coroutines (Unity 6)

```csharp
private async Awaitable FirePattern(CancellationToken ct)
{
    for (int i = 0; i < burst; i++)
    {
        SpawnProjectile();
        await Awaitable.WaitForSecondsAsync(interval, ct);
    }
}
// call with: _ = FirePattern(destroyCancellationToken);
```

- Pass `destroyCancellationToken` so the task dies with the component — the Awaitable equivalent of a coroutine stopping on destroy.
- Coroutines remain fine for trivial frame-timed sequences; don't mix both styles in one system.
- Engine API only from the main thread; hop with `await Awaitable.MainThreadAsync()` / `BackgroundThreadAsync()`.

## 6. Data: ScriptableObjects, not constants or Resources/

- Tunable/shared data (weapon stats, loot tables, ailment definitions) lives in `ScriptableObject` assets — designer-editable, diffable YAML, shared without duplication.
- ScriptableObjects are data + pure helpers; mutable runtime state lives in components or plain C# state objects, not in the shared asset.
- **Never `Resources/`** — it defeats build stripping and couples by string path. Use direct serialized references; reach for Addressables when content must load dynamically or stream.

## 7. Architecture: asmdefs and engine-light logic

- Assembly definitions from day one: at minimum `Game.Runtime`, `Game.Editor`, plus test assemblies. Editor-only code must live in an Editor asmdef or it breaks player builds.
- Keep core simulation/game logic in plain C# classes that take data in and return results (humble-object); MonoBehaviours are thin adapters wiring them to the engine. This makes logic unit-testable without a scene, and shareable between client and dedicated-server builds.

## 8. Events and wiring

- C# `event Action<T>` for code-to-code communication; `UnityEvent` only where designers wire callbacks in the inspector.
- Static events demand paranoid unsubscription (they outlive scene loads and survive domain-reload-off play mode) — prefer instance events on a known lifetime.

## 9. Smells to flag in review

- Any `?.` / `??` / `is null` on a `UnityEngine.Object`.
- `GetComponent`, `Find*`, `Camera.main`-style lookups inside `Update`/`FixedUpdate`.
- `public` fields used only for inspector wiring → `[SerializeField] private`.
- Serialized field renames without `[FormerlySerializedAs]`.
- `Resources.Load` in new code.
- Subscribe in `OnEnable` without matching unsubscribe in `OnDisable`.
- Logic embedded in MonoBehaviours that could be a testable plain class.
- New systems built on coroutines where `Awaitable` + `destroyCancellationToken` is cleaner.
