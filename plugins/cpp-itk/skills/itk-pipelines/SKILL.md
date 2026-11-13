---
name: itk-pipelines
description: Working correctly with ITK — the pipeline model (Update, regions, streaming) and SmartPointer lifetime, image geometry (origin, spacing, direction matrix) in LPS physical space, reading and writing DICOM series with GDCM, transform conventions (fixed-to-moving mapping) and how they map to DICOM spatial and deformable registration objects, elastix via ElastixRegistrationMethod/TransformixFilter, threading control, and deterministic results for tests. Use when writing or reviewing ITK/elastix code.
---

# ITK Pipelines

ITK does a great deal right by default — physical-space geometry, LPS coordinates, direction matrices — but it is easy to throw that away (copying pixel buffers without geometry, treating index space as physical, applying a transform in the wrong direction). Keep images as `itk::Image` with full geometry from read to write, and be explicit about transform direction at every boundary.

Verify API details against the ITK documentation for your version (5.4 is the current stable series; ITK 6 removes APIs deprecated in 5) and the elastix documentation.

## 1. Pipeline model and lifetime

- ITK filters form a **lazy pipeline**: setting inputs connects filters; **`Update()`** (on the last filter, or `UpdateLargestPossibleRegion()` after changing inputs) executes. Reading `GetOutput()` before `Update()` gives an empty image.
- **Exceptions:** `Update()` throws `itk::ExceptionObject` on failure. Wrap pipeline execution at the boundary and translate to your error model (see [cli-worker-contract](../cli-worker-contract/SKILL.md)).
- **SmartPointer lifetime:** objects created with `::New()` are reference counted. Keep a `Pointer` to anything you still need — in particular, an output image stays valid while referenced, but a filter may reuse its output buffer on the next `Update()`. Call `DisconnectPipeline()` on an output you want to keep independently of the filter.
- **Regions:** `LargestPossibleRegion` (whole image), `BufferedRegion` (in memory), `RequestedRegion` (what's being computed). For whole-volume tools, use `LargestPossibleRegion` and don't fight streaming unless memory requires it.
- **Iterate with ITK iterators or ranges** (`itk::ImageRegionIterator`, `itk::ImageBufferRange`), not raw pointer arithmetic over `GetBufferPointer()`.

## 2. Image geometry: origin, spacing, direction

An `itk::Image` maps index → physical point (mm) by:

```
P = Origin + Direction · diag(Spacing) · Index
```

- **Physical space is LPS** — the same as DICOM patient coordinates — so DICOM geometry carries over directly (other tools, e.g. RAS-based ones, need explicit conversion).
- **Direction matrix columns are the axis cosines** (for DICOM: row direction, column direction, slice normal). It is often not identity (oblique MR, sagittal series, flipped orders). **Never assume identity** and never drop it when creating images.
- Use **`TransformIndexToPhysicalPoint` / `TransformPhysicalPointToIndex` / `TransformPhysicalPointToContinuousIndex`** — not your own arithmetic — and do all geometric reasoning in physical space.
- When creating an output image from another, copy geometry with `CopyInformation(reference)` or set origin/spacing/direction explicitly. **Resampling** (`itk::ResampleImageFilter`) takes the output geometry from a reference image (`UseReferenceImageOn()`), plus a transform and an interpolator (`LinearInterpolateImageFunction`, `NearestNeighborInterpolateImageFunction` for label maps).
- Pixel types: read CT as `short`/`int16` or `float` after rescale; process in `float`; label maps as unsigned integers with nearest-neighbor resampling.

## 3. Reading and writing DICOM series

```cpp
using ImageType = itk::Image<float, 3>;
auto names = itk::GDCMSeriesFileNames::New();
names->SetUseSeriesDetails(true);           // split by series-identifying tags, not just Series UID
names->SetDirectory(inputDir);
const auto& seriesUids = names->GetSeriesUIDs();
// choose the requested series explicitly — never "the first one" silently
auto files = names->GetFileNames(requestedSeriesUid);   // sorted by position along the normal

auto io = itk::GDCMImageIO::New();
auto reader = itk::ImageSeriesReader<ImageType>::New();
reader->SetImageIO(io);
reader->SetFileNames(files);
reader->Update();                           // applies rescale slope/intercept for the output pixel type
```

- **Select the series explicitly** by Series Instance UID; error if it's missing or ambiguous.
- `GDCMSeriesFileNames` orders slices by position; still **validate the result** for your use: consistent orientation, uniform spacing (warn or resample on irregular spacing), no duplicates, no gantry-tilt surprises (see the `dicom-rt` plugin's `dicom-fundamentals` skill, if installed).
- Reading as `float` gives modality values (HU) after rescale slope/intercept. Check how `GDCMImageIO` handled the series if values matter exactly.
- **Metadata:** `io->GetMetaDataDictionary()` gives tags as strings (`"0020|000e"`). Use it to verify UIDs and Frame of Reference.
- **Writing DICOM** from ITK is fine for simple derived images, but RT objects (REG/DSR, RTDOSE, RTSTRUCT) need correct IODs: write them with a DICOM library that supports those IODs (in the tool, or by returning raw results — matrices, vector fields, dose grids with geometry — to the Node service, which creates the DICOM objects). Prefer the latter: keep the native tool focused on computation.
- For intermediate files between Node and the tool, use **NRRD or MetaImage (`.mha`)** — they preserve origin, spacing and direction exactly.

## 4. Transform conventions — and DICOM registration objects

**ITK registration transforms map points from the fixed image's physical space to the moving image's physical space.** That's what resampling needs: for each output (fixed-grid) point, find where to sample the moving image. elastix follows the same convention for its transform parameters and deformation fields.

Mapping to DICOM (PS3.3 C.20, PS3.17 Annex O):

| Result | DICOM object | Direction in DICOM | From ITK transform `T` (fixed→moving) |
|---|---|---|---|
| Rigid/affine | **Spatial Registration (REG)** | Source (referenced, i.e. moving) → Registered (fixed) | Matrix for the moving series item = **`T⁻¹`** as a 4×4, written **row-major**; the fixed series item gets identity |
| Deformable | **Deformable Spatial Registration (DSR)** | Registered (fixed) → Source (moving) | **Same direction as `T`**: pre-deformation matrix, displacement grid (mm, at grid voxel centers) and post-deformation matrix such that `post(pre(x) + d(pre(x)))` = `T(x)` |

- Extract a 4×4 from ITK affine-family transforms: `GetMatrix()` (3×3) and `GetOffset()` (translation applied after the matrix, including center handling) — **use `GetOffset()`, not `GetTranslation()`**, when the transform has a non-zero center.
- For a B-spline or composite deformable result, **sample the full mapping into a displacement field** on a chosen grid (e.g. `itk::TransformToDisplacementFieldFilter`), so the DSR is self-contained; put any separate rigid part in the pre-matrix or bake it into the field — document which.
- **Test the direction**, don't reason about it: register two synthetic images related by a known translation (e.g. moving shifted +10 mm in x) and assert the exported REG/DSR maps a known point the way the DICOM direction requires.

## 5. elastix from C++

elastix provides ITK-style classes (`itk::ElastixRegistrationMethod<Fixed, Moving>`, `itk::TransformixFilter<Image>`, `elastix::ParameterObject`):

```cpp
auto params = elastix::ParameterObject::New();
params->AddParameterMap(elastix::ParameterObject::GetDefaultParameterMap("rigid"));
params->AddParameterMap(elastix::ParameterObject::GetDefaultParameterMap("bspline"));
// or ReadParameterFile(...) — commit parameter files and record them with results

auto reg = itk::ElastixRegistrationMethod<ImageType, ImageType>::New();
reg->SetFixedImage(fixed);
reg->SetMovingImage(moving);
reg->SetParameterObject(params);
reg->SetLogToConsole(false);       // route logs to a file / your logger, keep stdout for progress JSON
reg->SetNumberOfThreads(nThreads);
reg->Update();
auto transformParams = reg->GetTransformParameterObject();
```

- Pin elastix and parameter files; store the effective parameter maps with each result.
- Use **masks** (`SetFixedMask`) to restrict the metric to relevant anatomy; use an initial transform (center-of-geometry, or an external ITK transform) for large offsets.
- Convert results to ITK transforms where needed (`ConvertToItkTransform`, available in recent versions) or apply with `TransformixFilter` (also for deformation fields and point sets).
- Keep elastix's own console output **off stdout** — stdout belongs to the worker's progress protocol.

## 6. Threading

- ITK parallelizes filters with a global thread pool. Control it explicitly from the tool's `--threads` argument: `itk::MultiThreaderBase::SetGlobalDefaultNumberOfThreads(n)` (and the elastix `SetNumberOfThreads`), so the job runner can bound CPU use when several jobs run.
- Default to a sensible number (e.g. hardware threads minus one), never unbounded.
- Your own parallel code: prefer ITK's `MultiThreaderBase::ParallelizeImageRegion` or standard threads with per-thread state; no shared mutable state without synchronization.

## 7. Deterministic results for tests

Registration involves randomness (random sampling of voxels for the metric) and parallel floating-point reductions:

- **Fix random seeds** (elastix image sampler seed parameters; ITK metric sampling seeds) in test configurations and record them with results.
- Use **a single thread** for golden-value tests, or compare with tolerances that account for reduction order; multi-threaded results are typically close but not bit-identical.
- Prefer assertions on **geometric outcomes** (recovered translation within 0.5 mm, target registration error at landmarks) over bit-exact image comparisons.
- Pin ITK/elastix versions — optimizer and metric changes between versions change results.

## 8. Review checklist

- [ ] Pipelines `Update()`d before use; exceptions caught at the boundary; kept outputs disconnected.
- [ ] Geometry (origin, spacing, direction) preserved end to end; no identity-direction assumptions; physical-space math via ITK methods.
- [ ] Series selected explicitly by UID and validated; intermediate files in NRRD/MHA.
- [ ] Transform direction explicit at every boundary; REG uses `T⁻¹`, DSR uses `T`; verified by a known-transform test.
- [ ] `GetOffset()` (not `GetTranslation()`) used for 4×4 export.
- [ ] Threads bounded from the command line; seeds fixed in tests; versions pinned.
