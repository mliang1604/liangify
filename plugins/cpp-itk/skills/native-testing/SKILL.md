---
name: native-testing
description: Testing native C++/ITK code — unit tests with GoogleTest (or Catch2) wired into CTest, regression tests on synthetic images with known transforms (translations, rotations, affine, smooth deformations) and tolerance-based assertions, geometry and direction tests for exported registrations, contract tests for command-line tools, sanitizer and cross-platform CI runs. Use when writing or reviewing tests for C++ libraries and command-line tools, especially image registration.
---

# Native Testing

Registration code is hard to test by eye and easy to get subtly wrong (a sign flip, a transposed matrix, a half-voxel shift). The answer is **synthetic inputs with known answers**, assertions on geometric quantities with explicit tolerances, and the same tests on every platform the binaries ship to.

## 1. Framework and wiring

- **GoogleTest** (ITK itself uses it) or Catch2 — pick one per repo. Fetch a pinned version with `FetchContent` or the dependency manager, and register tests with CTest (`gtest_discover_tests(target)`).
- Test the **library target** directly; keep tool `main`s thin and cover them with contract tests (§5).
- Tests must be **fast by default** (seconds): small images (16³–64³). Mark slow tests with a CTest label (`LABELS slow`) and run them in a separate CI job.
- Generated test data lives in code or under `testdata/synthetic/`; **never real patient data** (see the `dicom-rt` plugin's `dicom-test-data` skill, if installed).

## 2. Unit tests

Cover the pure pieces exhaustively:

- Geometry helpers: index↔physical with non-identity direction, anisotropic spacing and non-zero origin; matrix composition and inversion; LPS conventions.
- Transform export: ITK transform → 4×4 row-major matrix (with a non-zero transform **center**, which catches `GetTranslation()` vs `GetOffset()` bugs); displacement-field sampling.
- Params parsing and validation (valid, missing, out of range, wrong types).
- Image validation (inconsistent orientation, irregular spacing, duplicate slices).

## 3. Regression tests with known transforms

Build fixed/moving pairs where you **choose** the true mapping:

```cpp
TEST(RigidRegistration, RecoversKnownTranslation) {
  const auto fixed  = synth::gaussianBlobs({64, 64, 32}, /*spacing*/ {1.0, 1.0, 2.5}, /*seed*/ 7);
  const auto truth  = makeTranslation({10.0, -4.0, 5.0});            // mm, fixed → moving
  const auto moving = synth::resample(fixed, truth->GetInverseTransform());

  const auto result = registerRigid(fixed, moving, testParams(/*threads*/ 1, /*seed*/ 42));

  EXPECT_NEAR(result.translation[0], 10.0, 0.5);
  EXPECT_NEAR(result.translation[1], -4.0, 0.5);
  EXPECT_NEAR(result.translation[2],  5.0, 0.5);
  EXPECT_LT(rotationAngleDeg(result.matrix), 0.5);
}
```

- **Inputs with structure** (blobs, gradients, a synthetic phantom with edges) — registration on uniform or pure-noise images is meaningless.
- **Cases:** pure translation; rotation about a non-origin center; anisotropic voxels; non-identity direction (e.g. a sagittal-oriented volume); affine with scaling; a smooth known deformation (sinusoidal or Gaussian bump displacement) for deformable registration; a case that should **fail** (no overlap) and must return the "computation failed" path, not a wrong answer.
- **Assert geometric outcomes with tolerances**: recovered parameters, **target registration error** at known landmarks, displacement field error (mean/max in mm inside a mask), inverse consistency. State the tolerance next to the assertion and why it's acceptable.
- **Determinism:** single thread and fixed seeds for these tests; pin ITK/elastix versions; update expected values only deliberately (and say why in the commit).

## 4. Direction tests for exported registrations

The most important test class for RT use: **does the exported object map the right way?**

- Using the known translation case: export the rigid result as the matrix that will go into a DICOM REG, and assert it maps a point in the **moving (source)** image to the corresponding point in the **fixed (registered)** image — i.e. the inverse of ITK's fixed→moving transform (PS3.3 C.20.2; see the `dicom-rt` plugin's `rt-objects` skill, if installed).
- Export the deformable result as pre-matrix + displacement grid + post-matrix and assert that applying them in DICOM order to a **fixed (registered)** point lands on the corresponding **moving (source)** point.
- Include a non-zero transform center and a non-identity direction so convention bugs can't hide.

## 5. Command-line contract tests

Run the built tools from CTest (`add_test(NAME ... COMMAND $<TARGET_FILE:register-rigid> ...)`) or a small driver script:

- `--version` prints valid JSON; `--self-check` exits 0.
- Bad usage → exit 2; invalid params → 4; invalid input → 3.
- A small synthetic run: stdout is only valid JSON Lines with monotonic progress; `result.json` exists, validates against its schema, and contains the expected recovered transform.
- Cancellation: send SIGTERM mid-run (POSIX; terminate on Windows) → expected exit code, no `result.json`.
- Paths containing spaces and non-ASCII characters.

## 6. CI

- Run `ctest --preset <platform>` on Linux, macOS (universal build; run on the native arch of the runner) and Windows.
- A **sanitizer job** (ASan + UBSan; TSan for threaded code) on Linux running the unit and fast regression tests.
- A **slow** job (larger images, deformable cases) on a schedule or on changes to registration code.
- Publish test reports (JUnit XML from CTest: `ctest --output-junit`) and keep failing inputs/outputs as artifacts for diagnosis.

## 7. Review checklist

- [ ] Library logic unit-tested; tools covered by contract tests.
- [ ] Regression tests use structured synthetic images with known transforms, including anisotropic and non-identity-direction cases.
- [ ] Assertions are geometric with explicit, justified tolerances; deterministic settings in tests.
- [ ] Exported REG/DSR direction verified with a known transform.
- [ ] Tests run on all three platforms and under sanitizers.
