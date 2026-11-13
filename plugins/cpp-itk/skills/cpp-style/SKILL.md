---
name: cpp-style
description: Modern C++ (C++17/20) conventions — RAII and ownership, smart pointers, const-correctness, value semantics, error handling with exceptions or expected-style results, avoiding undefined behavior, naming and file layout, plus clang-format, clang-tidy, warnings-as-errors and sanitizers. Use when writing or reviewing C++ code, or setting up its formatting and static analysis.
---

# C++ Style

Native compute code runs on patient images for minutes at a time on three operating systems. The priorities are **correctness, no undefined behavior, and clear ownership** — performance comes from algorithms and libraries (ITK), not from clever code. Apply the `core` plugin's `clean-code` principles; this skill covers the C++-specific parts.

Target **C++17** as the baseline (ITK 5.4+ and elastix 5.2+ require it); use C++20 features only if every supported compiler/platform in CI handles them.

## 1. Ownership and RAII

- **Every resource has an owner whose destructor releases it**: memory, files, handles, threads, temporary directories. No naked `new`/`delete`, no `malloc`/`free`, no manual `fclose` in normal code.
- **Ownership is expressed in types:**
  - `std::unique_ptr<T>` — sole ownership (the default for heap objects);
  - `std::shared_ptr<T>` — genuinely shared lifetime (rare; justify it);
  - raw pointer `T*` or reference `T&` — **non-owning** access only; prefer references when non-null;
  - `std::span<T>` (C++20) / pointer + size, `std::string_view` — non-owning views; never store them beyond the owner's lifetime.
- **ITK objects** use `itk::SmartPointer` (intrusive reference counting): create with `::New()`, hold as `typename T::Pointer` / `auto`, never `delete` them, never wrap them in `std::unique_ptr`.
- **Rule of zero:** prefer classes whose members manage themselves, so no custom destructor/copy/move is needed. If you must write one of the five, think about all five (`= delete` what doesn't make sense).
- Scope guards for cleanup that isn't an object (e.g. removing a temp directory on every exit path).

## 2. Values, const and interfaces

- **Pass small types by value, large by `const&`**, sinks by value + `std::move`. Return by value (copy elision makes it cheap).
- **`const` everything that doesn't change**: locals, parameters by reference, member functions. `constexpr` for compile-time constants.
- **Strong types for units and spaces** where mix-ups are plausible (`Millimetres`, `VoxelIndex` vs `PhysicalPoint`) — or at least name variables by space and unit (`spacingMm`, `pointLps`).
- Prefer `enum class`, `std::optional` for "maybe absent", `std::variant` for closed alternatives, `std::array` for fixed sizes, `std::vector` by default for sequences.
- Mark single-argument constructors `explicit`; mark overrides `override`; make classes not designed for inheritance `final`.
- `[[nodiscard]]` on functions whose result must be checked (status codes, factories).

## 3. Error handling

- Choose one model per layer and be consistent:
  - **Exceptions** for exceptional failures inside the library/tool code (ITK throws `itk::ExceptionObject`; standard library throws). Catch at well-defined boundaries — in a command-line tool, **in `main`**, mapping to exit codes (see [cli-worker-contract](../cli-worker-contract/SKILL.md)).
  - **Result types** (`std::optional`, `std::expected` in C++23 or a small `Result<T, E>`) for expected, recoverable failures (parse errors, validation).
- **Never swallow** exceptions (`catch (...) {}`); never let one escape `main` or a thread function (it calls `std::terminate`).
- Validate inputs at boundaries (files, arguments, parameters) and fail with a message that names the bad value.
- `noexcept` on move operations and destructors; don't add it elsewhere unless you're sure.

## 4. Avoiding undefined behavior

- **Initialize every variable** (`int n{};`); prefer `auto x = ...;` which forces initialization.
- **Bounds:** use `.at()` in non-hot code or assert indices in debug; use ITK iterators/ranges for image traversal rather than raw index arithmetic.
- **Integer arithmetic:** use `std::size_t`/`std::ptrdiff_t` for sizes and indices; watch signed/unsigned comparisons and overflow when multiplying image dimensions (`512*512*400*sizeof(float)` overflows 32-bit). Use `std::int64_t` for voxel counts and byte sizes.
- **Floating point:** don't compare with `==`; use tolerances. Be aware that `-ffast-math`/`/fp:fast` changes results — don't enable it for clinical computation.
- No dangling references/views (returning `string_view` to a temporary, lambdas capturing locals by reference and outliving them).
- No data races: shared mutable state across threads must be synchronized; prefer per-thread state and reductions.

## 5. Naming and layout

- Follow the project's style; if none, a common modern choice: `PascalCase` types, `camelCase` functions and variables, `m_` or trailing `_` for members (ITK uses `m_` and `PascalCase` methods — match ITK's style in code that subclasses ITK).
- One class/component per header/source pair; headers self-contained with `#pragma once`; include what you use; forward-declare to cut compile times.
- Namespaces for the project (`ortstudio::registration`); no `using namespace` in headers.
- Keep tool `main.cpp` thin: parse arguments, call a library function, map results/errors.

## 6. Formatting and static analysis

- **clang-format** with a committed `.clang-format`; format on save and check in CI (`clang-format --dry-run --Werror`).
- **clang-tidy** with a committed `.clang-tidy`: enable `bugprone-*`, `cppcoreguidelines-*` (selectively), `modernize-*`, `performance-*`, `readability-*` subsets that the team agrees on; run in CI on changed files with `compile_commands.json` from CMake (`CMAKE_EXPORT_COMPILE_COMMANDS=ON`).
- **Warnings as errors** for project code: `-Wall -Wextra -Wpedantic -Wshadow -Wconversion` (GCC/Clang), `/W4 /permissive-` (MSVC). Treat third-party headers as system includes so their warnings don't fail the build.
- **Sanitizers** in a CI configuration: AddressSanitizer + UndefinedBehaviorSanitizer (Linux/macOS), and ThreadSanitizer for multithreaded code. Run the test suite under them.
- Optionally **cppcheck** or MSVC `/analyze` for an extra pass.

## 7. Review checklist

- [ ] No naked `new`/`delete`; ownership visible in types; ITK objects held by `SmartPointer`.
- [ ] `const`-correct; small types by value; strong names/types for units and coordinate spaces.
- [ ] Errors either thrown and caught at a defined boundary or returned as results; nothing swallowed.
- [ ] All variables initialized; sizes and byte counts in 64-bit types; no `==` on floats.
- [ ] Formatted, clang-tidy clean, no warnings; tests pass under ASan/UBSan.
