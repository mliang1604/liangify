---
name: electron-security
description: Electron security hardening — contextIsolation on, nodeIntegration off, sandboxed renderers, a narrow typed contextBridge API, validating every IPC message and its sender in main, restricting navigation and new windows, shell.openExternal safety, content security policy, custom protocols instead of file://, permission handlers, fuses, and keeping Electron current. Especially important for apps handling patient data. Use when creating windows, writing preload/IPC code, loading content, or reviewing an Electron app's security.
---

# Electron Security

In Electron, an XSS in the renderer is not "just" an XSS: with a weak configuration it becomes code execution on the user's machine, with access to every file the user can read — including locally stored patient data. Treat the renderer as untrusted, and make main the only place that holds privileges.

Follow the official checklist ([electronjs.org/docs/latest/tutorial/security](https://www.electronjs.org/docs/latest/tutorial/security)) and re-read it when upgrading majors; defaults and recommendations change.

## 1. Window configuration

```ts
const win = new BrowserWindow({
  show: false,
  webPreferences: {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,      // default since Electron 12 — keep it explicit
    sandbox: true,               // default since Electron 20 — keep it explicit
    nodeIntegration: false,      // default — keep it explicit
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    spellcheck: false,           // avoid sending typed text to an OS/cloud spellchecker
  },
});
```

- **Write the secure values explicitly** even where they're defaults: it documents intent and protects against a later copy-paste that flips one.
- **Disabling `contextIsolation` also disables the sandbox** — never turn it off.
- No `enableBlinkFeatures`, no `<webview>` unless genuinely needed (and then lock it down in `will-attach-webview`).
- Don't load remote content in a privileged window. If you must show external pages, use a separate window or `WebContentsView` with no preload and the same restrictions.

## 2. Preload and `contextBridge`

- Expose **specific functions**, never `ipcRenderer` itself, never `ipcRenderer.invoke` with a caller-supplied channel name, never Node modules (`fs`, `child_process`, `shell`).
- Keep preload logic to argument shaping and forwarding. Validation belongs in main, because a compromised renderer can call main's IPC however it likes.
- Don't pass callbacks that receive the `IpcRendererEvent` (it exposes `sender`); wrap listeners so only data reaches the page.

## 3. IPC in main: validate everything

Every `ipcMain.handle` is a network-style endpoint exposed to untrusted code:

```ts
const APP_ORIGIN = 'app://bundle';

function assertTrustedSender(event: IpcMainInvokeEvent) {
  const frame = event.senderFrame;
  if (!frame || new URL(frame.url).origin !== APP_ORIGIN) throw new Error('Untrusted IPC sender');
  if (frame !== event.sender.mainFrame) throw new Error('IPC from subframe not allowed');
}

ipcMain.handle('shell:reveal', (event, fileId: unknown) => {
  assertTrustedSender(event);
  const id = FileIdSchema.parse(fileId);          // runtime validation, e.g. zod or hand-written guards
  const filePath = catalog.resolve(id);           // main maps id → path; renderer never supplies paths
  if (!filePath) throw new Error('Unknown file');
  shell.showItemInFolder(filePath);
});
```

- **Validate the sender** (`event.senderFrame` origin, and main frame only) on every handler.
- **Validate every argument at runtime** — TypeScript types don't exist at the IPC boundary. Check types, ranges, lengths, enum values.
- **Paths:** prefer IDs; if a path must come from the renderer, resolve it and confirm it's inside an allowed directory (after `realpath`, to defeat `..` and symlinks). Paths chosen by the user in a native dialog opened by main are trustworthy for that operation.
- **No generic handlers** ("run this command", "read this file", "eval"). Each handler does one narrow thing.
- Return errors without internal detail (no stack traces or file paths to the renderer); log details in main.
- Keep a single registry of channels (shared typed map) so you can review the whole attack surface in one file.

## 4. Navigation, new windows, external links

```ts
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== APP_ORIGIN) event.preventDefault();
  });
  contents.on('will-redirect', (event, url) => {
    if (new URL(url).origin !== APP_ORIGIN) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

function isAllowedExternal(url: string): boolean {
  const u = new URL(url);
  return u.protocol === 'https:' && ALLOWED_EXTERNAL_HOSTS.has(u.hostname);
}
```

- **Deny navigation away from the app origin** and **deny all new windows** by default; open allowed links in the system browser.
- **`shell.openExternal` only with validated `https:` (or `mailto:`) URLs** from an allow-list. Passing renderer-supplied strings can launch arbitrary protocol handlers or local files.

## 5. Content Security Policy

Serve the renderer with a strict CSP (via the custom protocol handler's response headers, or a `<meta>` tag):

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:;
connect-src 'self' http://127.0.0.1:* ;
worker-src 'self' blob:;
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
```

- No `'unsafe-eval'`; avoid inline scripts. Tighten `connect-src` to the actual API origins (the local standalone server, the configured remote server).
- Frameworks (Angular, etc.) may need specific allowances (inline styles, trusted types); add the minimum and document why.

## 6. Protocols, permissions, sessions

- **Use a custom protocol** (`protocol.registerSchemesAsPrivileged` with `standard: true, secure: true` then `protocol.handle`) to serve the app, and confine the handler to the app's bundled directory (normalize and check paths; reject `..`).
- **Permission requests:** set `session.setPermissionRequestHandler` and `setPermissionCheckHandler` to deny everything by default (camera, microphone, geolocation, notifications, HID/serial/USB…), allowing only what the app needs, for the app origin only.
- **Certificate errors:** never accept invalid certificates globally (`ignore-certificate-errors`, `certificate-error` handlers that call `callback(true)`). For self-signed on-prem servers, pin the specific certificate in configuration.
- Disable or restrict DevTools in production builds if the threat model requires it (it's not a security boundary, but it reduces casual tampering).

## 7. Fuses and build hardening

Electron **fuses** flip features off at package time (`@electron/fuses`). Typical production settings:

- `RunAsNode: false` (stops `ELECTRON_RUN_AS_NODE` turning the app into a Node interpreter),
- `EnableNodeOptionsEnvironmentVariable: false`, `EnableNodeCliInspectArguments: false`,
- `EnableEmbeddedAsarIntegrityValidation: true` and `OnlyLoadAppFromAsar: true` (tamper detection),
- `EnableCookieEncryption: true`.

Check the current fuse list for your Electron version and test the packaged app after flipping them.

## 8. Keep Electron current

- Electron ships a new major every 8 weeks and supports only the **latest three majors**; older lines get no Chromium security fixes. Plan routine upgrades (each one is a Chromium and Node upgrade), read the breaking-changes page for every major crossed, and have automated dependency updates open PRs.
- Audit native and npm dependencies; prefer fewer.

## 9. Patient data specifics

- Store local data under `app.getPath('userData')` with OS file permissions restricted to the user; consider OS-level disk encryption a prerequisite and say so in documentation.
- Secrets (server tokens) go in the OS keychain via `safeStorage`, never in plain files or `localStorage`.
- **Never log patient identifiers** (names, IDs, dates of birth) in app logs or crash reports; strip them from crash-reporter metadata. Logs use UIDs or internal IDs.
- Auto-update and telemetry endpoints must not receive patient data.

## 10. Review checklist

- [ ] `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` explicitly set on every window.
- [ ] Preload exposes only specific functions; no `ipcRenderer`, Node modules or generic channels.
- [ ] Every IPC handler validates sender and arguments at runtime; renderer never supplies raw paths for privileged operations.
- [ ] Navigation, redirects and new windows denied by default; `openExternal` only for allow-listed `https:` URLs.
- [ ] Strict CSP; app served from a custom protocol confined to the bundle.
- [ ] Permission handlers deny by default; no global certificate bypass.
- [ ] Fuses set for production; Electron on a supported major.
- [ ] No patient identifiers in logs, crash reports or telemetry.
