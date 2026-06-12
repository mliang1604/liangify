---
name: unity-asset-hygiene
description: How to safely create, move, rename, delete, and edit Unity assets outside the editor — .meta files, GUIDs, YAML scenes/prefabs, editor coexistence, Git LFS discipline. Use for EVERY file operation inside a Unity project's Assets/ or Packages/ folders from CLI or code tools, not just art-asset work.
---

# Unity Asset Hygiene (for work outside the editor)

Unity identifies assets by the **GUID in their `.meta` file**, not by path. Every reference between assets (scene → prefab → material → texture → script) is stored as `{fileID, guid}`. Break a GUID and every reference to that asset silently becomes "Missing" — often discovered much later. These rules exist to prevent that.

## 1. The four GUID rules (non-negotiable)

1. **Move or rename an asset together with its `.meta`**, in the same operation and the same commit. `git mv Foo.cs Bar.cs` without `git mv Foo.cs.meta Bar.cs.meta` = Unity sees a deleted asset and a brand-new one → new GUID → all references break.
2. **Never copy a `.meta` file.** Two assets with the same GUID is corruption; Unity will reassign one arbitrarily.
3. **Never regenerate or hand-edit the GUID of an existing asset.** Deleting a `.meta` to "fix" something destroys the asset's identity.
4. **Delete the `.meta` when deleting an asset** (the editor does this for you; CLI deletes must do it manually).

## 2. Creating files outside the editor

Unity generates the `.meta` on its next focus/refresh. So:

- Create the file → focus the editor once (or run a batchmode refresh) → commit **file + generated `.meta` together**.
- Don't hand-author `.meta` files; let Unity produce them.
- Never commit an asset without its `.meta` — a teammate's (or CI's) Unity will generate a *different* GUID, and the two clones diverge.

## 3. Editing scenes / prefabs / .asset YAML by hand

With Force Text serialization these are YAML and agents *can* edit them — carefully:

- **Safe:** changing existing property values (a float, a name, a flag, a serialized field on an existing component).
- **Risky:** structural edits — adding/removing components or GameObjects, reordering, anything touching the `fileID` graph or `m_Component` lists. Internal `fileID`s are file-local object IDs; cross-file references are `{fileID, guid, type}`. Get one wrong and the file imports broken or not at all.
- Prefer making structural changes through the editor (or editor scripting in batchmode). If hand-editing, keep diffs minimal and targeted; verify by letting Unity import before committing.
- A script's serialized field rename without `[FormerlySerializedAs]` silently drops data in every scene/prefab using it — flag this in review.

## 4. Coexisting with an open editor

- The editor rewrites files on save/refresh: don't edit a scene the editor has **unsaved changes** in — one side will lose.
- After external file changes, the editor picks them up on focus (auto-refresh). Make edits → focus editor → let the import finish → then build/test/commit.
- Only one editor (or batchmode process) can hold a project open — `Temp/UnityLockfile`. CLI runs fail while the editor is open; close it first.

## 5. Version control discipline

- Required project settings: **Asset Serialization: Force Text**, **Version Control: Visible Meta Files**. Verify in `ProjectSettings/EditorSettings.asset` (`m_SerializationMode: 2`) and `VersionControlSettings.asset` (`m_Mode: Visible Meta Files`).
- Never commit `Library/`, `Temp/`, `Logs/`, `UserSettings/`, `obj/`, builds.
- Binaries go through **Git LFS**, and LFS storage is *cumulative* — a binary deleted in a later commit still counts against quota forever. Audition/iterate outside the repo; commit only finals. After committing binaries, verify: `git lfs ls-files`. If a new binary type isn't listed, fix `.gitattributes` *before* pushing.
- Scene/prefab merge conflicts: resolve with **UnityYAMLMerge** (Smart Merge), never by hand-picking YAML hunks.

## 6. Never-do list (instant review flags)

- File moved/renamed/deleted without its `.meta` in the same commit.
- A committed asset missing its `.meta`, or a `.meta` missing its asset.
- Duplicated GUIDs (copied `.meta`).
- Hand-written or modified `guid:` lines.
- Binary committed outside LFS (`git lfs ls-files` doesn't show it).
- Editing `Library/` or treating it as a source of truth — it's a regenerable cache.
- Committing a scene saved mid-conflict or with merge markers inside YAML.
