# liangify

A [Claude Code](https://docs.claude.com/en/docs/claude-code) **plugin marketplace** containing Michael Liang's personal customizations — reusable agents, slash commands, skills, and hooks — shared across his projects.

## Layout

```
liangify/
├── .claude-plugin/
│   └── marketplace.json          # marketplace manifest
└── plugins/
    ├── core/                     # language-agnostic: clean-code, code-review, git-workflow, code-tutor agent
    ├── typescript/               # TypeScript language style
    ├── angular/                  # Angular 22: zoneless patterns, RxJS/resources, forms, Vitest
    ├── unity/                    # Unity 6: C# patterns, asset/GUID hygiene, performance, testing
    ├── webgpu/                   # WebGPU: device/resources, WGSL style, shader/CPU parity, GPU-free testing
    ├── dicom-rt/                 # DICOM/RT: geometry, RT objects + registration, DIMSE, test data, dose math
    ├── electron/                 # Electron: architecture, security, packaging/signing, testing
    ├── node-service/             # Node services: structure, storage, jobs, security/audit, testing
    ├── cpp-itk/                  # C++/ITK: style, CMake, ITK/elastix pipelines, CLI worker contract, testing
    └── playwright/               # Playwright: test patterns, CI setup, canvas/WebGPU app testing
```

Each plugin follows the same internal layout:

```
plugins/<name>/
├── .claude-plugin/plugin.json    # plugin manifest
├── agents/                       # subagent definitions (*.md)
├── commands/                     # slash commands (*.md)
├── skills/                       # skills (<name>/SKILL.md)
└── hooks/hooks.json              # event-matched hooks
```

Additional plugins can be added under `plugins/<name>/` and registered in [marketplace.json](.claude-plugin/marketplace.json).

## Available plugins

| Plugin | Install | Description |
|---|---|---|
| **core** | `/plugin install core@liangify` | Language-agnostic skills: clean code (Uncle Bob), code review, git workflow. Agent: `code-tutor`, a Socratic tutor that teaches you to implement a task instead of writing it for you. |
| **typescript** | `/plugin install typescript@liangify` | TypeScript language style: strict typing, narrowing, discriminated unions, branded types. Depends on `core`. |
| **angular** | `/plugin install angular@liangify` | Angular 22: zoneless + signals patterns, RxJS and resources, Signal Forms and reactive forms, Vitest testing. Depends on `core` and `typescript`. |
| **unity** | `/plugin install unity@liangify` | Unity 6: C# scripting patterns, asset/GUID/meta hygiene for AI-assisted work, performance discipline, headless test/build verification. Depends on `core`. |
| **webgpu** | `/plugin install webgpu@liangify` | WebGPU: device setup and graceful failure, resource lifetime and device loss, WGSL style and uniform layout, keeping shader and CPU geometry in sync, testing without a GPU. Depends on `core` and `typescript`. |
| **dicom-rt** | `/plugin install dicom-rt@liangify` | DICOM and radiotherapy: LPS geometry and slice ordering, RTSTRUCT/RTDOSE/RTPLAN, rigid and deformable registration objects, DIMSE networking and TLS, synthetic test data rules, dose summation and BED/EQD2. Includes the `dicom-guard` hook (below). Depends on `core`. |
| **electron** | `/plugin install electron@liangify` | Electron: main/preload/renderer split with a browser-runnable renderer, security hardening and IPC validation, packaging/signing/notarization/auto-update with bundled native helpers, Playwright + xvfb testing. Depends on `core` and `typescript`. |
| **node-service** | `/plugin install node-service@liangify` | Node/TypeScript services: transport-independent core (runs as a server or inside Electron), storage ports with SQLite/PostgreSQL backends and streaming, job contract for native CLI workers, auth/audit/PHI-safe logging, Vitest + Testcontainers. Framework-agnostic. Depends on `core` and `typescript`. |
| **cpp-itk** | `/plugin install cpp-itk@liangify` | C++ / ITK native compute: modern C++ style + static analysis, target-based CMake with presets and pinned ITK/elastix on macOS/Windows/Linux, ITK geometry and transform conventions vs DICOM REG/DSR, CLI worker contract (JSONL progress, exit codes), GoogleTest regression tests on known transforms. Depends on `core`. |
| **playwright** | `/plugin install playwright@liangify` | Playwright E2E: role/test-id locators, web-first assertions, fixtures and isolation; CI with webServer, retries/traces, sharding, GPU-less runners; testing canvas/WebGPU apps through state, overlays and selective screenshots. Depends on `core` and `typescript`. |

### dicom-rt: `dicom-guard` hook

The `dicom-rt` plugin ships a `PreToolUse` hook that stops Claude from writing, staging or committing DICOM files outside a designated synthetic test-data folder. In a public repository a committed patient study can't be un-published, so this is enforced mechanically rather than left to instructions.

- **What it checks:** `Write`, `Edit`, `MultiEdit` and `NotebookEdit` targets, and `git add` / `git commit` run through `Bash` or `PowerShell` (it asks git which files would be staged or committed, including `-A`, globs and `commit -a`).
- **What counts as DICOM:** a `.dcm` extension (any case), or the `DICM` magic bytes at offset 128 (so extensionless Part 10 files are caught too).
- **When it blocks:** the tool call is refused (exit code 2) and Claude is told which files were blocked, why, and where synthetic fixtures belong. Files inside the allowed folder pass.
- **Default allowed folder:** `**/testdata/synthetic/**` (any `testdata/synthetic/` directory in the project).
- **Changing the allowed folder** (globs relative to the project root; `**`, `*` and `?` supported). The first of these that is set wins:
  1. the `DICOM_GUARD_ALLOWED` environment variable, comma-separated. To commit it with the project, set it in `.claude/settings.json`:
     ```json
     { "env": { "DICOM_GUARD_ALLOWED": "test/fixtures/dicom/**,e2e/fixtures/synthetic/**" } }
     ```
  2. a `.claude/dicom-guard.json` file in the project: `{ "allowed": ["test/fixtures/dicom/**"] }`.
- **Requirements:** Node.js on `PATH` (the hook runs `node` directly, with no shell, so it behaves the same on macOS, Windows and Linux), and git for the `git add`/`commit` checks. It has no dependencies.
- **Limits:** it guards file-writing tools and git staging/commits. Other shell commands that create files (`cp`, `curl`, an export script) aren't inspected, but their output is still caught when someone tries to stage or commit it. If the hook itself fails (malformed input, git missing), it reports the error and lets the call through rather than wedging the session.
- **Tests:** `node --test plugins/dicom-rt/hooks/dicom-guard.test.mjs`.

## Consuming from another repo

In any project where you want these tools available:

```
/plugin marketplace add mliang1604/liangify
/plugin install core@liangify
/plugin install typescript@liangify  # any TS project (Node, library, etc.)
/plugin install angular@liangify     # Angular projects (also pulls in core + typescript)
/plugin install unity@liangify       # Unity projects (also pulls in core)
/plugin install webgpu@liangify      # WebGPU rendering (also pulls in core + typescript)
/plugin install dicom-rt@liangify    # DICOM / radiotherapy work (also pulls in core)
/plugin install electron@liangify    # Electron desktop apps (also pulls in core + typescript)
/plugin install node-service@liangify  # Node/TypeScript backends (also pulls in core + typescript)
/plugin install cpp-itk@liangify     # C++/ITK native tools (also pulls in core)
/plugin install playwright@liangify  # end-to-end tests (also pulls in core + typescript)
```

That enables the plugins for your user account. To pin them for the whole project (commit alongside the repo), add to `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "liangify": {
      "source": { "source": "github", "repo": "mliang1604/liangify" }
    }
  },
  "enabledPlugins": {
    "core@liangify": true,
    "typescript@liangify": true,
    "angular@liangify": true
  }
}
```

Teammates cloning the repo will be prompted to install on first run.

## Updating

Each plugin carries an explicit `version` field in its `plugin.json`. Consumers get updates when the version bumps. Pull the latest with:

```
/plugin marketplace update liangify
```

> **Maintainer note:** bump the `version` in `plugin.json` whenever you change a plugin's contents — Claude Code does not auto-detect changes via git SHA when a `version` is present. Version is required (and must be present on every plugin) because cross-plugin `dependencies` resolution needs it.

## Adding components

Drop files into the right directory under any plugin (`plugins/<plugin>/...`) — no manifest edits needed.

| Component | Where it goes | Format |
|-----------|---------------|--------|
| Subagent | `plugins/<plugin>/agents/<name>.md` | Markdown + YAML frontmatter (`name`, `description`, `tools`) |
| Slash command | `plugins/<plugin>/commands/<name>.md` | Markdown (becomes `/name`) |
| Skill | `plugins/<plugin>/skills/<name>/SKILL.md` | Markdown + YAML frontmatter (`description`) |
| Hook | `plugins/<plugin>/hooks/hooks.json` | Event-matcher JSON (same shape as `settings.json` hooks) |

See the [plugin reference](https://code.claude.com/docs/en/plugins-reference) for full schemas.

## License

MIT — see [LICENSE](LICENSE).
