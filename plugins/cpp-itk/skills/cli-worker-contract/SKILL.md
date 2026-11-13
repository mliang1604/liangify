---
name: cli-worker-contract
description: The contract for native command-line workers driven by a job runner (e.g. Node) on any platform — argument and file-based inputs/outputs, a params JSON file, machine-readable JSON Lines progress and results on stdout, logs on stderr, meaningful documented exit codes, cancellation via signals, no interactive prompts, --version and self-check, and cross-platform path/encoding rules. Use when building or reviewing a C++ (or other native) tool that a service or desktop app will spawn.
---

# CLI Worker Contract

A native tool that a service spawns is an API, and its contract is its command line, its files, its stdout and its exit code. Make that contract **explicit, machine-readable and identical on macOS, Windows and Linux**, so the job runner (see the `node-service` plugin's `job-queue-contract` skill, if installed) can drive every tool the same way.

## 1. Invocation

```
register-rigid --input <dir> --output <dir> --params <file.json> [--threads N] [--progress jsonl|none] [--log-level info]
register-rigid --version
register-rigid --self-check
register-rigid --help
```

- **Named flags only**, long form (`--input`), parsed with a small, well-tested parser (e.g. CLI11 or cxxopts). Unknown flags are an error.
- **Inputs and outputs are files/directories**, not giant command-line values. Put structured parameters in a **JSON params file**, validated against a documented schema (versioned: `"schemaVersion": 1`).
- **Paths are absolute** (the runner provides them); treat them as UTF-8. On Windows, use wide-character file APIs (`std::filesystem::path` from `std::u8string`/`u8path`, ITK's UTF-8 support) so non-ASCII user paths work.
- **No interactive prompts, ever**; no reading stdin unless documented; no GUI.
- **No dependence on the current directory or environment** beyond documented variables. Write nothing outside `--output` (and a temp dir under it if needed).
- **`--threads N`** bounds CPU use; default to a sensible value, never unbounded.

## 2. Output directory

```
<output>/
├── result.json        # the machine-readable result (written last, atomically)
├── transform.tfm      # or .h5 / matrix.json / displacement.nrrd — documented per tool
└── log.txt            # optional detailed log
```

- Write outputs to temp names and **rename into place**; write `result.json` **last** — its presence means "complete".
- `result.json` includes: `schemaVersion`, `tool`, `version` (including ITK/elastix versions), the effective parameters, input identifiers (e.g. series UIDs read from the data), outputs (file names, checksums), and quality metrics (final metric value, iterations, warnings).
- Output geometry-bearing data in formats that **preserve geometry** (NRRD/MHA for images and fields; explicit 4×4 matrices with the direction convention stated in the file).

## 3. stdout: JSON Lines protocol

stdout carries **only** protocol messages, one JSON object per line, flushed after each line:

```json
{"type":"start","tool":"register-rigid","version":"0.3.1","itk":"5.4.4","elastix":"5.3.1"}
{"type":"progress","fraction":0.05,"stage":"read","message":"Reading fixed series"}
{"type":"progress","fraction":0.42,"stage":"optimize","level":2,"iteration":180}
{"type":"warning","code":"irregular-spacing","message":"Fixed series has irregular slice spacing; resampled to 2.5 mm"}
{"type":"result","path":"result.json"}
```

- `fraction` is 0–1 and non-decreasing; `stage` from a documented set. Throttle to a few messages per second.
- **Everything else goes to stderr** (human-readable logs, library output). Redirect library console output (ITK/elastix logging) away from stdout. A stray `printf` to stdout breaks the protocol.
- **No patient identifiers in any message** — use UIDs or nothing.
- Use `\n` line endings on every platform (open stdout in binary mode on Windows or write `\n` explicitly and flush).

## 4. Exit codes

Document them in `--help` and in the repo; keep them stable:

| Code | Meaning |
|---|---|
| 0 | Success — `result.json` written |
| 2 | Usage error (bad/missing arguments, unknown flag) |
| 3 | Invalid input data (unreadable files, wrong modality, inconsistent geometry, missing series) |
| 4 | Invalid parameters (params file fails schema/range validation) |
| 5 | Computation failed (did not converge, diverged, quality check failed) |
| 6 | Resource error (out of memory, disk full, output not writable) |
| 130 / 143 | Cancelled (SIGINT / SIGTERM received) |
| 1 | Unexpected internal error (bug) |

- Map exceptions to codes **in `main`**, with a one-line JSON error on stdout before exiting (`{"type":"error","code":"invalid-input","message":"..."}`) and details on stderr.
- A non-zero exit leaves **no `result.json`**.

```cpp
int main(int argc, char** argv) {
  try {
    const auto args = parseArgs(argc, argv);          // throws UsageError
    installSignalHandlers();                           // sets an atomic cancel flag
    Protocol out{std::cout};
    out.start(toolInfo());
    const auto result = runRegistration(args, out);    // checks cancel flag between stages/iterations
    writeResultAtomically(args.output, result);
    out.result("result.json");
    return 0;
  } catch (const UsageError& e)      { return fail(2, "usage", e.what()); }
    catch (const InvalidInput& e)    { return fail(3, "invalid-input", e.what()); }
    catch (const InvalidParams& e)   { return fail(4, "invalid-params", e.what()); }
    catch (const ComputationFailed& e) { return fail(5, "computation-failed", e.what()); }
    catch (const Cancelled&)         { return fail(143, "cancelled", "cancelled"); }
    catch (const std::bad_alloc&)    { return fail(6, "out-of-memory", "out of memory"); }
    catch (const std::exception& e)  { return fail(1, "internal", e.what()); }
}
```

## 5. Cancellation

- Handle **SIGTERM/SIGINT** (POSIX) and console control events (Windows `SetConsoleCtrlHandler`; note that `child.kill()` from Node on Windows terminates the process outright) by setting an **atomic flag**; check it between stages and inside long loops (optimizer iteration observers).
- On cancel: stop promptly, clean up partial outputs, exit with the cancel code. Never leave a `result.json`.

## 6. `--version` and `--self-check`

- `--version` prints one JSON line with the tool version, git commit, ITK/elastix versions and build platform, and exits 0. The runner records it with every result.
- `--self-check` runs a tiny built-in synthetic case (e.g. registers two generated 16³ images with a known shift) and exits 0 only if the answer is right — used by packaged-app smoke tests on every platform.

## 7. Testing the contract

- Golden tests for argument parsing (each flag, unknown flag → 2, missing required → 2).
- Params validation tests (out-of-range → 4) and invalid-input tests (empty dir, wrong modality → 3).
- Protocol tests: run the tool on a small synthetic case and assert stdout is valid JSONL only, with monotonic progress, and `result.json` matches its schema.
- Cancellation test: send SIGTERM mid-run; assert exit code and no `result.json`.
- Same tests on every CI platform (paths with spaces and non-ASCII characters included).

## 8. Review checklist

- [ ] Named flags; params in a versioned JSON file; absolute UTF-8 paths; no prompts or stdin.
- [ ] Only JSONL protocol on stdout; logs on stderr; no PHI in messages.
- [ ] Documented, stable exit codes mapped in `main`; no `result.json` on failure.
- [ ] `result.json` written last and atomically with versions, params, inputs, outputs and metrics.
- [ ] Cancellation handled on all platforms; `--threads` honored.
- [ ] `--version` and `--self-check` implemented and used by packaging smoke tests.
