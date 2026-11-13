---
name: dicom-test-data
description: Rules and patterns for DICOM test data — generate synthetic datasets with known answers, never commit real patient data, why anonymization alone isn't enough to commit a file, where synthetic fixtures live, and what makes a good fixture for geometry, RT objects and networking tests. Use when writing tests that need DICOM files, adding fixtures, or reviewing a change that adds any DICOM or medical image file.
---

# DICOM Test Data

Medical images are personal health data. In a public repository, a single real study — even "anonymized" — can identify a patient and cannot be un-published once pushed. So the rule is simple and mechanical: **tests use synthetic data, generated with known answers.**

## 1. Hard rules

1. **Never commit real patient data.** That includes images, RT objects, screenshots of real images, DICOM headers pasted into issues or test code, and derived data (meshes, masks, dose grids) from real patients.
2. **Anonymization is not sufficient reason to commit a file.** De-identification can miss burned-in text in pixels, private tags, free-text fields, UIDs that link back to the source system, dates, and the face itself (CT/MR head data can be surface-rendered and recognised). Even a well de-identified dataset may not be **licensed for redistribution**. Commit a real or public dataset only when the right to share it is clear and documented (e.g. a public dataset whose license permits redistribution), with a `LICENSE`/`README` next to it naming the source and terms.
3. **Fixtures live in one designated place** — by convention `testdata/synthetic/` (or the project's equivalent, documented in its `CLAUDE.md`). Anything DICOM-like outside it should be treated as suspect. The `dicom-rt` plugin's `dicom-guard` hook enforces this mechanically: it blocks writing, staging or committing DICOM files outside the allowed folder (configurable; see the README).
4. **Prefer generating fixtures in test code** over committing binary files. Generated fixtures are reviewable, tiny in git, parameterisable, and obviously synthetic.
5. **If a bug only reproduces with a real dataset**, reduce it to a synthetic reproduction (same geometry, orientation, spacing, tag values that matter) rather than committing the original. Keep real data on local or access-controlled storage, outside the repo.

## 2. Make fixtures obviously synthetic

- Patient name like `SYNTHETIC^PHANTOM`, patient ID `SYN-0001`, no real-looking dates of birth (or use a clearly fake one), institution `SYNTHETIC`.
- Generate UIDs from a dedicated test root or `2.25.<random>`; never copy UIDs from real data.
- A comment or `ImageComments` / `SeriesDescription` saying the data is fabricated.

## 3. Known answers: what to generate

The point of synthetic data is that **you know the right answer exactly**. Design each fixture around one property under test:

**Geometry**

- A ramp or gradient volume (`value = i + 1000·j + 10⁶·k`, or HU = f(position)) so any voxel's index can be recovered from its value — catches transposes, flips and off-by-ones.
- Non-square pixels (`PixelSpacing = 0.5\0.8`) and anisotropic slices (3 mm) to catch row/column swaps and spacing errors.
- Shuffled files with `InstanceNumber` out of order or reversed — ordering must come from positions.
- Oblique orientation, gantry tilt (in-plane IPP shift per slice), irregular slice gaps, duplicate positions.
- Signed and unsigned pixel representations, non-trivial rescale slope/intercept that differ per slice, `MONOCHROME1`.
- Non-axial acquisitions (sagittal, coronal) and different patient positions.

**RT objects**

- Shapes with analytic answers: a sphere or cube ROI of known radius/size → known area per slice and known volume; a contour with a hole; two islands on one slice; a contour exactly on voxel boundaries.
- A dose grid that's a linear function of position (or a constant) → known value at any point, known DVH; non-uniform `GridFrameOffsetVector`; both relative and absolute offset forms; a `DoseGridScaling` that isn't 1.
- A plan with two fraction groups and different fraction counts.
- Registrations with known transforms: a pure translation, a 90° rotation, an affine with scale; a deformable grid with a constant or linear displacement field; pre/post matrices. Verify that a known point maps to its known image — in the direction the SOP class defines.

**Networking**

- A small set of instances across several SOP classes and transfer syntaxes, with distinct, searchable attribute values for C-FIND tests.

## 4. How to generate

- **In-language writers in test code**: a minimal Explicit VR Little Endian writer (preamble, `DICM`, file meta group, then elements) is a few dozen lines and covers most fixtures. Keep it in a shared test helper, used by unit and end-to-end tests.
- **Libraries**: use the project's DICOM library (or `pydicom`, `dcmjs`, `dcm4che`, DCMTK `dump2dcm`) to build datasets from code or from a readable text description checked into the repo.
- **Keep sizes small**: 32×32×12 is enough for most geometry tests. Larger volumes only where size itself matters (performance, texture limits), generated at test time, not committed.
- **Deterministic**: seeded randomness; stable UIDs within a fixture so snapshots don't churn.
- If a binary fixture must be committed, keep it **under `testdata/synthetic/`**, small, with the generator script or a README describing how it was produced.

## 5. Review checklist for changes that touch data

- [ ] No `.dcm` (or extensionless DICOM, or `.nii`, `.mha`, `.nrrd` from patients) outside the synthetic fixture folder.
- [ ] Every committed medical-image file is synthetic, or has documented right-to-share.
- [ ] No real names, IDs, dates or UIDs in fixtures, test code, logs, snapshots or issue text.
- [ ] Fixtures encode a known answer that the test asserts.
- [ ] Tests cover the awkward geometry cases above, not only axial isotropic data.
