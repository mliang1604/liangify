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
    └── dicom-rt/                 # DICOM/RT: geometry, RT objects + registration, DIMSE, test data, dose math
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
| **dicom-rt** | `/plugin install dicom-rt@liangify` | DICOM and radiotherapy: LPS geometry and slice ordering, RTSTRUCT/RTDOSE/RTPLAN, rigid and deformable registration objects, DIMSE networking and TLS, synthetic test data rules, dose summation and BED/EQD2. Depends on `core`. |

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
