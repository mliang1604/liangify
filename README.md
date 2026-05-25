# liangify

A [Claude Code](https://docs.claude.com/en/docs/claude-code) **plugin marketplace** containing Michael Liang's personal customizations — reusable agents, slash commands, skills, and hooks — shared across his projects.

## Layout

```
liangify/
├── .claude-plugin/
│   └── marketplace.json          # marketplace manifest
└── plugins/
    ├── core/                     # language-agnostic: clean-code, code review, git workflow
    └── angular/                  # Angular 17+ / TypeScript: patterns, RxJS, forms, testing
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
| **core** | `/plugin install core@liangify` | Language-agnostic skills: clean code (Uncle Bob), code-review style, git workflow. |
| **angular** | `/plugin install angular@liangify` | Angular 17+ patterns, TypeScript style, RxJS, reactive forms, testing. Depends on `core`. |

## Consuming from another repo

In any project where you want these tools available:

```
/plugin marketplace add mliang1604/liangify
/plugin install core@liangify
/plugin install angular@liangify     # only where you want Angular tooling
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
    "angular@liangify": true
  }
}
```

Teammates cloning the repo will be prompted to install on first run.

## Updating

The plugin manifest intentionally omits a `version` field, so Claude Code tracks the latest commit on `main`. Consumers get updates with:

```
/plugin marketplace update liangify
```

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
