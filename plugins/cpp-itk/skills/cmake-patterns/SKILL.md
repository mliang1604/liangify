---
name: cmake-patterns
description: Target-based modern CMake — targets and usage requirements, CMakePresets for configure/build/test across macOS (universal), Windows and Linux, dependency management for ITK and elastix (prebuilt, superbuild/ExternalProject, or package managers), install rules for command-line tools, reproducible CI builds and caching. Use when creating or changing CMakeLists.txt, presets, dependency setup or native CI.
---

# CMake Patterns

Native tools must build the same way on a developer laptop and on three CI platforms, and their binaries end up inside desktop installers. Modern, target-based CMake with presets makes that boring — which is the goal.

Check the CMake, ITK and elastix docs for your versions; minimum versions and package names change.

## 1. Targets, not variables

```cmake
cmake_minimum_required(VERSION 3.24)
project(ortstudio_native VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

find_package(ITK 5.4 REQUIRED COMPONENTS ITKCommon ITKIOGDCM ITKIOImageBase ITKTransformIO ITKRegistrationMethodsv4)
include(${ITK_USE_FILE})                     # registers ITK IO factories
find_package(Elastix REQUIRED)               # provides elastix targets / ELASTIX_USE_FILE (check your elastix version)

add_library(registration_core STATIC
  src/registration/rigid.cpp
  src/registration/deformable.cpp
  src/io/dicom_series.cpp)
target_include_directories(registration_core PUBLIC include)
target_link_libraries(registration_core PUBLIC ${ITK_LIBRARIES} PRIVATE project_warnings)

add_executable(register-rigid tools/register_rigid.cpp)
target_link_libraries(register-rigid PRIVATE registration_core)
```

- **Everything is a target** with its own sources, include directories, compile definitions and link libraries, declared with `PUBLIC` / `PRIVATE` / `INTERFACE` usage requirements. No global `include_directories`, `add_definitions` or `link_libraries`.
- **Split library and tool:** a library target holds the logic (testable); each executable is a thin `main` linking it.
- **Warnings via an interface target** (`project_warnings`) applied to project code only, so third-party headers don't break `-Werror`.
- Don't set `CMAKE_CXX_FLAGS` by hand in `CMakeLists.txt`; use target properties, toolchain files or presets.
- **Never** `file(GLOB ...)` sources (new files aren't picked up reliably); list them.

## 2. Presets

Commit a `CMakePresets.json` so configure, build and test are one command on every platform:

```json
{
  "version": 6,
  "configurePresets": [
    { "name": "base", "hidden": true, "binaryDir": "${sourceDir}/build/${presetName}",
      "generator": "Ninja",
      "cacheVariables": { "CMAKE_BUILD_TYPE": "Release", "BUILD_TESTING": "ON" } },
    { "name": "linux-release",   "inherits": "base" },
    { "name": "macos-universal", "inherits": "base",
      "cacheVariables": { "CMAKE_OSX_ARCHITECTURES": "arm64;x86_64", "CMAKE_OSX_DEPLOYMENT_TARGET": "13.0" } },
    { "name": "windows-release", "inherits": "base",
      "cacheVariables": { "CMAKE_MSVC_RUNTIME_LIBRARY": "MultiThreaded" } },
    { "name": "linux-asan", "inherits": "base",
      "cacheVariables": { "CMAKE_BUILD_TYPE": "Debug", "ENABLE_SANITIZERS": "ON" } }
  ],
  "buildPresets": [ { "name": "linux-release", "configurePreset": "linux-release" } ],
  "testPresets":  [ { "name": "linux-release", "configurePreset": "linux-release",
                      "output": { "outputOnFailure": true } } ]
}
```

- Developers use `CMakeUserPresets.json` (git-ignored) for local paths.
- `cmake --preset X && cmake --build --preset X && ctest --preset X` is the whole build in CI and locally.

## 3. ITK and elastix dependencies

They're large; build them once and reuse. Options, in order of preference for reproducibility:

1. **Prebuilt, versioned dependency artifacts** produced by a dedicated CI job (per platform/arch, per ITK+elastix version) and cached/downloaded by tool builds, then found with `find_package(ITK ...)` / `find_package(Elastix ...)` via `CMAKE_PREFIX_PATH`.
2. **Superbuild** with `ExternalProject_Add` (ITK first, then elastix against it, then the project), cached by key = versions + toolchain + options.
3. **A package manager** (vcpkg, Conan) if it provides the exact versions and options you need; pin versions/baselines.

Guidelines:

- **Pin exact versions** (ITK tag, elastix tag/commit) and record them in the tool's `--version` output.
- **Build only the ITK modules you need** (`Module_*` / `ITK_BUILD_DEFAULT_MODULES=OFF` plus the required modules; e.g. GDCM IO, transform IO, registration) to cut build time and binary size.
- **Static vs shared:** statically linking ITK into each tool (`BUILD_SHARED_LIBS=OFF`) makes bundling into desktop installers simple — one self-contained executable per tool. If you use shared libraries, install them next to the executables and set RPATH (`$ORIGIN`, `@executable_path`) correctly.
- **macOS universal:** build ITK/elastix with `CMAKE_OSX_ARCHITECTURES="arm64;x86_64"` (or build per-arch and `lipo` the final tools). Every linked library must contain both architectures.
- **Windows:** be consistent with the MSVC runtime (`/MT` static vs `/MD` dynamic) across ITK, elastix and your code.
- **Licenses:** ITK and elastix are Apache-2.0; ITK bundles third-party libraries (GDCM, etc.) with their own permissive licenses. Ship the license texts and notices with the binaries, and check any additional dependency's license before adding it.

## 4. Install and packaging

```cmake
include(GNUInstallDirs)
install(TARGETS register-rigid register-deformable RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(FILES LICENSE THIRD_PARTY_NOTICES.txt DESTINATION ${CMAKE_INSTALL_DATADIR}/ortstudio-native)
```

- `cmake --install build/<preset> --prefix dist/<platform>-<arch>` produces exactly what the desktop packager bundles (see the `electron` plugin's `electron-packaging` skill, if installed).
- Strip release binaries (keep separate debug symbols for crash analysis).

## 5. Reproducible CI

- Matrix: `ubuntu (x64, arm64)`, `macos (universal)`, `windows (x64)`; same presets as local.
- Use a compiler cache (ccache/sccache) and cache the dependency prefix keyed by versions + toolchain.
- Fixed toolchain versions (pinned runner images, explicit compiler versions); `CMAKE_BUILD_TYPE` explicit; no `-march=native` (binaries must run on users' machines, not just the build host).
- Run `ctest` (unit + regression tests) on each platform, plus a sanitizer job on Linux.
- Upload installed tool directories as artifacts with checksums for the desktop build to consume.

## 6. Review checklist

- [ ] Targets with usage requirements; no global flags/includes; no globbing.
- [ ] Logic in a library target; tools are thin executables.
- [ ] `CMakePresets.json` covers every CI platform; CI uses the presets.
- [ ] ITK/elastix versions pinned, built once and cached; only needed modules.
- [ ] macOS builds universal; Windows runtime consistent; RPATH correct if shared.
- [ ] Install rules produce a self-contained, licensed tool directory per platform.
