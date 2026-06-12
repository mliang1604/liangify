---
name: unity-testing
description: Unity Test Framework and headless verification — EditMode vs PlayMode tests, test assemblies, running tests and builds from the CLI in batchmode so changes can be verified without the editor GUI. Use when writing Unity tests or when verifying Unity code changes from the command line.
---

# Unity Testing & Headless Verification

The Unity Test Framework is NUnit. The agent-relevant part: tests and builds run headless from the CLI, so changes can be *verified*, not just written.

## 1. Architect for fast tests first

The best Unity test is one that doesn't need Unity. Keep simulation/game logic in plain C# classes (no MonoBehaviour, no scene dependencies) — they test as ordinary NUnit EditMode tests in milliseconds. Reserve PlayMode tests for genuinely engine-coupled behavior (physics, lifecycle, scene loading).

## 2. Test assemblies

Tests live in their own asmdef with **Test Assemblies** enabled (references `UnityEngine.TestRunner`/`UnityEditor.TestRunner`, define constraint `UNITY_INCLUDE_TESTS`):

- `Tests/EditMode/` — asmdef platform: *Editor only*. Pure logic, editor scripting. Fast; default home for most tests.
- `Tests/PlayMode/` — runs in play mode; can load scenes, tick physics, await frames.

Test asmdefs reference the runtime asmdefs they test — which forces the runtime code into asmdefs too (good).

## 3. Test shapes

```csharp
[Test]                      // synchronous, EditMode or PlayMode
public void Shock_IncreasesDamageTaken() { ... }

[UnityTest]                 // IEnumerator — spans frames
public IEnumerator Projectile_DespawnsAfterLifetime()
{
    var go = Object.Instantiate(prefab);
    yield return new WaitForSeconds(lifetime + 0.1f);
    Assert.That(go == null, Is.True);   // Unity null semantics: destroyed == null
}
```

- `LogAssert.Expect(...)` when a test legitimately logs an error; unexpected `Debug.LogError` fails the test.
- PlayMode tests that need a scene should build their fixtures in code where possible — scene-file dependencies make tests brittle and slow.

## 4. Running tests from the CLI

```powershell
& "C:\Program Files\Unity\Hub\Editor\<version>\Editor\Unity.exe" `
  -batchmode -projectPath . `
  -runTests -testPlatform EditMode `
  -testResults "$PWD\TestResults-EditMode.xml" `
  -logFile -
```

- **Do not pass `-quit` with `-runTests`** — the runner exits on its own; `-quit` can kill it early.
- `-testPlatform EditMode|PlayMode` (PlayMode headless works; add `-nographics` only if no GPU work is needed).
- Exit code 0 = all passed, 2 = test failures; parse the NUnit XML in `-testResults` for details.
- `-logFile -` streams the editor log to stdout — essential for diagnosing compile errors that prevent tests from even running.
- **The editor must be closed first** — one process per project (`Temp/UnityLockfile`). A CLI run against an open project fails immediately; say so rather than retrying.
- Compile-only check (no tests): `-batchmode -quit -projectPath . -logFile -` and grep the log for `error CS`.

## 5. Headless builds

```powershell
& $unity -batchmode -quit -projectPath . `
  -executeMethod BuildScripts.BuildWindowsClient -logFile -
```

with a small `Editor/BuildScripts.cs` calling `BuildPipeline.BuildPlayer` (or `BuildPipeline.BuildPlayer(BuildProfile)` with Unity 6 build profiles — keep client / dedicated-server profiles as committed assets so CI and local builds agree). Check `BuildReport.summary.result` and fail loudly.

## 6. Verification checklist for a Unity change

1. Editor closed? (lockfile check)
2. Compile check or EditMode run passes (`error CS` grep + exit code).
3. New logic covered by EditMode tests if it's plain C# — write the test in the same change.
4. PlayMode run only when the change touches engine behavior.
5. Report actual results — exit codes and failing test names, not "tests should pass."
