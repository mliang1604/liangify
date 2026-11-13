---
name: electron-architecture
description: Electron application architecture — main, preload and renderer responsibilities; keeping the renderer a plain web app that also runs in a browser; a narrow, typed desktop API with feature detection instead of platform branching; hosting server/domain code in the main process (or a utility process) for standalone mode; window and lifecycle management. Use when structuring or reviewing an Electron app or adding a desktop-only capability.
---

# Electron Architecture

Electron is three different programs in one bundle. Most long-term pain comes from blurring them: Node APIs leaking into UI code, UI state living in the main process, or a renderer that only works inside Electron. Keep the boundaries sharp and the desktop surface small.

Check the current Electron docs for API details — a new major ships every 8 weeks and only the latest three majors are supported.

## 1. The three processes

| Process | Runs | Owns | Must not |
|---|---|---|---|
| **Main** | Node.js, one per app | App lifecycle, windows, menus, native dialogs, file system, OS integration, spawning helpers, hosting local services | Render UI, hold UI state, block its event loop with heavy work |
| **Preload** | Isolated context in each renderer, before page scripts | Exposing a small, typed API with `contextBridge` | Contain business logic; expose `ipcRenderer` or Node modules |
| **Renderer** | Chromium, sandboxed | The UI — a normal web app | Use Node, `require`, or `electron` imports |

Add **utility processes** (`utilityProcess.fork`) for CPU-heavy or crash-prone Node work (indexing, parsing large files, a local server), so a crash or a long loop doesn't freeze the main process and every window with it. Spawn **native executables** (e.g. C++ compute tools) with `child_process` from main or a utility process, never from the renderer.

## 2. The renderer is a web app first

- Build the renderer with the same toolchain and code as the browser version (e.g. the Angular client). **It must run in a plain browser** against a server, with no Electron present. That keeps one UI codebase, lets you test it with ordinary web tooling, and keeps desktop-specific code isolated.
- Talk to data through the **same service interfaces** in both environments. In the browser they call HTTP; in Electron standalone mode they can call the same HTTP API served locally, or a desktop transport behind the same interface.
- **Load from a custom protocol** (e.g. `app://`) registered with `protocol.handle` rather than `file://` — `file://` grants broad file access and behaves differently for origins, CORS and routing. In development, load the dev server URL.
- Client-side routing must work under the custom protocol (fallback to `index.html` for unknown paths).

## 3. A narrow, typed desktop API

Expose only what the UI needs, as intent-level functions — not generic pipes:

```ts
// shared/desktop-api.ts — imported by preload (implementation) and renderer (type only)
export interface DesktopApi {
  readonly version: string;
  openDicomFolder(): Promise<FolderSelection | null>;   // shows a native dialog in main
  revealInFolder(fileId: string): Promise<void>;
  onUpdateAvailable(listener: (info: UpdateInfo) => void): () => void; // returns unsubscribe
}

// preload.ts
contextBridge.exposeInMainWorld('desktop', {
  version: process.versions.electron,
  openDicomFolder: () => ipcRenderer.invoke('dialog:open-dicom-folder'),
  revealInFolder: (fileId: string) => ipcRenderer.invoke('shell:reveal', fileId),
  onUpdateAvailable: (listener) => {
    const wrapped = (_e: unknown, info: UpdateInfo) => listener(info);
    ipcRenderer.on('update:available', wrapped);
    return () => ipcRenderer.removeListener('update:available', wrapped);
  },
} satisfies DesktopApi);
```

- **One shared type** for the API, plus a typed channel map for main's handlers, so the three sides can't drift.
- **Never expose `ipcRenderer`, `send`/`invoke` with arbitrary channel names, or Node modules.** Every exposed function maps to one specific channel.
- Pass **identifiers, not raw paths**, where possible (`revealInFolder(fileId)` with main resolving the path) so the renderer can't ask for arbitrary files.
- Prefer `invoke`/`handle` (request/response, promise-based) over fire-and-forget `send`; never `sendSync`.
- Everything crossing the bridge is structured-cloned: plain data only (no class instances, functions or DOM objects). Use transferable `ArrayBuffer`s or `MessagePort`s for large binary data.
- Main validates every message — see [electron-security](../electron-security/SKILL.md).

## 4. Feature-detect, don't branch on platform

In the renderer, wrap the bridge in a service that reports capabilities:

```ts
@Service()
export class DesktopService {
  private readonly api = (globalThis as { desktop?: DesktopApi }).desktop;
  readonly isDesktop = this.api !== undefined;
  readonly canOpenFolders = this.api?.openDicomFolder !== undefined;
  openDicomFolder() { return this.api?.openDicomFolder() ?? Promise.resolve(null); }
}
```

- UI asks **"can I do X?"**, not "am I on Electron/macOS?". Scattered `if (isElectron)` / `process.platform` checks in components are a smell.
- The browser build gets a graceful alternative (a file input instead of a native folder dialog), not a broken button.
- Platform differences (menu conventions, paths, shortcuts) are handled **in main**, behind the API.

## 5. Standalone mode: hosting the server in-process

When the app must work with no server (single-user, offline), run the server's domain code locally:

- Keep the server's **domain core free of transport and process assumptions** (no global singletons tied to `process.env`, no hard-coded ports or data paths) so it can be constructed with an injected config: data directory under `app.getPath('userData')`, an embedded database (e.g. SQLite) instead of a server database.
- **Host it in a utility process** (preferred) or main, listening on `127.0.0.1` on an ephemeral port, or speaking over a `MessagePort` instead of TCP. If it listens on TCP, bind to loopback only and require a per-launch random token, so other local processes or web pages can't call it.
- The renderer reaches it through the same API client it uses for a remote server (base URL injected via the preload API).
- Long-running jobs (e.g. native registration tools) are started by that local service with the same job contract as on the server.
- Shut it down cleanly on `before-quit` (finish or cancel jobs, close the database).

## 6. Windows and lifecycle

- Create windows from main with secure `webPreferences` (see electron-security) and `show: false`, showing on `ready-to-show` to avoid a white flash.
- Single-instance apps: `app.requestSingleInstanceLock()`; focus the existing window on `second-instance` (and handle file/URL arguments passed there).
- macOS conventions: keep the app alive with no windows; re-create on `activate`. Windows/Linux: quit when the last window closes.
- Persist window bounds yourself (validated against current displays) — don't restore a window to a monitor that no longer exists.
- Deep links / file associations: handle `open-file`, `open-url` (macOS) and argv (Windows/Linux) in one place, and validate the input.

## 7. Project layout

```
desktop/
├── src/main/        # main process: app lifecycle, windows, IPC handlers, protocol, updater
├── src/preload/     # contextBridge API only
├── src/shared/      # DesktopApi type, IPC channel map, validation schemas
└── resources/       # icons, bundled native helpers per platform
client/              # the web app (renderer), buildable without Electron
server/              # domain core + transports; reused by desktop standalone mode
```

Build main and preload with their own TypeScript configs (Node targets); the renderer is the client's production build.

## 8. Review checklist

- [ ] Renderer has no Node/Electron imports and runs in a plain browser.
- [ ] Preload exposes a small, typed, intent-level API; no raw `ipcRenderer` or generic channels.
- [ ] UI uses capability checks, not platform/Electron branching.
- [ ] Heavy or crash-prone work runs off the main process.
- [ ] App content served via a custom protocol, not `file://`.
- [ ] Standalone services bound to loopback with a token, or over `MessagePort`, and shut down cleanly.
