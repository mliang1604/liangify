---
name: electron-packaging
description: Packaging and shipping Electron apps for macOS, Windows and Linux — choosing Electron Forge or electron-builder, universal macOS builds, code signing and notarization, Windows signing, auto-update, bundling and signing native helper executables (e.g. C++ command-line tools) with asar unpacking, CI build matrices, and keeping Electron current. Use when setting up or changing builds, installers, signing, updates or bundled binaries.
---

# Electron Packaging

A desktop release is only as good as its worst platform's installer. Unsigned builds get blocked by Gatekeeper and SmartScreen; a helper binary that isn't signed or isn't executable silently breaks a feature on one OS. Automate the whole pipeline in CI and test the **packaged** app, not just the dev build.

Tooling and signing requirements change; check current docs for Electron Forge / electron-builder, Apple notarization and Windows signing before changing the pipeline.

## 1. Tooling

- **Electron Forge** (maintained by the Electron team) or **electron-builder** (widely used, many targets, built-in `electron-updater`). Pick one per project; don't mix.
- Pin exact versions of Electron and the packager in the lockfile; upgrade deliberately (see §7).
- Package from a **clean, production build**: renderer built for production, main/preload compiled, dev dependencies excluded, source maps handled per policy.
- Package app code into an **asar** archive; enable asar integrity and `OnlyLoadAppFromAsar` via fuses (see [electron-security](../electron-security/SKILL.md)).

## 2. Targets per platform

| Platform | Typical artifacts | Notes |
|---|---|---|
| **macOS** | `.dmg` (+ `.zip` for auto-update) | Build **universal** (x64 + arm64 merged via `@electron/universal`) or separate per-arch builds. Every native binary must exist for both architectures (or be universal itself). |
| **Windows** | NSIS or Squirrel installer, optionally MSIX | x64 and arm64 if you support Windows on ARM. |
| **Linux** | AppImage, `.deb`, `.rpm` (Flatpak/Snap optional) | x64 and arm64; test on at least one Debian- and one RPM-based distro. |

Build each platform on its own OS in CI (macOS runners for signing/notarization; Windows runners for Windows signing). Cross-building is fragile, especially with native modules and signing.

## 3. Code signing and notarization

**macOS**

- Sign with a **Developer ID Application** certificate, with **hardened runtime** enabled and minimal **entitlements** (only what you use; a JIT entitlement is typically needed for Electron).
- **Notarize** with Apple's notary service (`notarytool`, via `@electron/notarize` or the packager's built-in support), then **staple** the ticket.
- **Every executable and dylib in the bundle must be signed** with hardened runtime — including bundled helper tools in `Resources`. Unsigned nested binaries fail notarization or get killed at launch.
- Store credentials (App Store Connect API key, certificate) as CI secrets; never commit them.

**Windows**

- Sign installers and executables (including bundled helpers) with an OV/EV certificate held in a hardware token or a cloud signing service (e.g. Azure Trusted Signing), invoked from CI. Unsigned or newly signed apps trigger SmartScreen warnings until reputation builds.
- Timestamp signatures so they remain valid after the certificate expires.

**Linux**

- No OS-level code signing for AppImage/deb in general; sign release artifacts and checksums (GPG or Sigstore), and publish checksums.

## 4. Auto-update

- macOS/Windows: `electron-updater` (electron-builder) or Electron's built-in `autoUpdater` with Squirrel (Forge) and a release server (GitHub Releases, S3, or `update.electronjs.org` for open-source apps on GitHub).
- Updates must be **signed** and served over HTTPS; the updater verifies signatures — don't disable verification.
- Let users (and administrators) control updates: on-prem/clinical deployments often need updates disabled or pointed at an internal server. Make the update channel and URL configuration, and support a "no auto-update" policy.
- Never send patient data or identifiers to the update server; telemetry, if any, is opt-in and anonymous.
- Linux: AppImage can self-update (with AppImageUpdate/electron-updater); deb/rpm update through package repositories.

## 5. Bundling native helper executables

For compute tools built outside Node (e.g. C++ ITK/elastix registration CLIs):

- Put them in **`extraResources`** (electron-builder) / `extraResource` (Forge), organized per platform and arch, e.g. `resources/bin/<platform>-<arch>/register-rigid[.exe]`. Don't put executables inside the asar — they can't be executed from it; if they must live under the app path, list them in `asarUnpack`.
- Resolve the path at runtime from **`process.resourcesPath`** in packaged builds and from the build output directory in development — in one helper function, used everywhere:

  ```ts
  export function helperPath(name: string): string {
    const exe = process.platform === 'win32' ? `${name}.exe` : name;
    const base = app.isPackaged
      ? path.join(process.resourcesPath, 'bin')
      : path.join(__dirname, '../../native/dist', `${process.platform}-${process.arch}`);
    return path.join(base, exe);
  }
  ```

- **Preserve the executable bit** on macOS/Linux (check after packaging; some archive steps drop it).
- **Sign them** on macOS (hardened runtime) and Windows, as part of the app signing step.
- **Universal macOS:** ship universal (lipo'd) helper binaries, or both arch variants with the right one chosen at runtime.
- **Bundle their runtime dependencies** (shared libraries) or link statically; test on a clean machine/VM without developer toolchains installed.
- Spawn them with `child_process.spawn` (argument arrays, no shell), from main or a utility process, using the CLI worker contract (machine-readable progress on stdout, exit codes).
- Check licenses of bundled third-party binaries and include their notices.

## 6. CI pipeline

- Matrix: `{ macos (universal or x64+arm64), windows (x64[, arm64]), linux (x64[, arm64]) }`.
- Steps: install (`npm ci`) → build renderer/main/preload → build or download native helpers for that platform → package → sign/notarize → **smoke-test the packaged app** (launch, check it reaches the ready state; see [electron-testing](../electron-testing/SKILL.md)) → upload artifacts with checksums.
- Release from tags; publish only artifacts produced by CI, never locally built ones.
- Cache wisely (npm, Electron downloads), but rebuild native modules for the exact Electron version (`@electron/rebuild` or the packager's built-in rebuild).

## 7. Keeping Electron current

- A new Electron major ships every 8 weeks; only the **latest three majors** receive fixes, so a release line is supported for roughly six months. Falling behind means shipping known Chromium vulnerabilities.
- Automate dependency PRs (Renovate/Dependabot) for Electron, and run the full packaged-app test matrix on them.
- Read the breaking-changes doc for each major; native modules and fuses are the usual breakers.
- Track the Electron version's macOS/Windows minimums (new Chromium versions drop old OS releases) and state supported OS versions in release notes.

## 8. Review checklist

- [ ] Builds for all target platforms/architectures run in CI on native runners.
- [ ] macOS: signed with hardened runtime, notarized, stapled; all nested binaries signed.
- [ ] Windows: installer and all executables signed and timestamped.
- [ ] Auto-update signed, HTTPS, configurable/disable-able for managed deployments.
- [ ] Native helpers outside asar, executable, signed, per-arch, resolved through one path helper, dependencies bundled.
- [ ] Packaged app smoke-tested per platform before release; checksums published.
- [ ] Electron on a supported major, with automated upgrade PRs.
