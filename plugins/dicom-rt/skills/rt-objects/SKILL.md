---
name: rt-objects
description: DICOM radiotherapy objects — RTSTRUCT (ROIs, contour sequences, referenced frame of reference and images, ROI naming per AAPM TG-263), RTDOSE (dose grid scaling, grid frame offsets, units, dose type and summation type), the RTPLAN essentials for dose work (fraction groups and fraction counts), and spatial registration objects, rigid (REG) and deformable (DSR), including transform direction, pre/post-deformation matrices and vendor differences. Use when reading, writing or reviewing code that handles RT DICOM objects.
---

# RT Objects

RT objects are where small misreadings become clinical errors: a dose grid offset applied twice, a contour attached to the wrong image set, a registration matrix applied in the wrong direction. **Read the relevant PS3.3 section** (C.8.8 for RT modules, C.20 for spatial registration) when implementing; this skill is a map of the traps, not a substitute.

Everything here builds on [dicom-fundamentals](../dicom-fundamentals/SKILL.md) (LPS coordinates, Frame of Reference, slice geometry).

## 1. RTSTRUCT (RT Structure Set)

Key modules and sequences (PS3.3 C.8.8.5–C.8.8.8):

- **`ReferencedFrameOfReferenceSequence (3006,0010)`** — the FoR the contours are defined in, and (via RT Referenced Study/Series sequences) the image series they were drawn on.
- **`StructureSetROISequence (3006,0020)`** — one item per ROI: `ROINumber (3006,0022)`, `ROIName (3006,0026)`, `ReferencedFrameOfReferenceUID (3006,0024)`, generation algorithm.
- **`ROIContourSequence (3006,0039)`** — per ROI (matched by `ReferencedROINumber`, **not by item order**): display color and a `ContourSequence (3006,0040)`.
  - Each contour: `ContourGeometricType (3006,0042)` (`CLOSED_PLANAR`, `OPEN_PLANAR`, `OPEN_NONPLANAR`, `POINT`), `NumberOfContourPoints`, and **`ContourData (3006,0050)` — x,y,z triplets in patient coordinates (mm)**, not pixel indices.
  - Optional `ContourImageSequence` links a contour to the image slice it lies on. Don't depend on it being present; match contours to slices by geometry (z along the slice normal, within tolerance).
- **`RTROIObservationsSequence (3006,0080)`** — clinical meaning: `RTROIInterpretedType (3006,00A4)` (`EXTERNAL`, `PTV`, `CTV`, `GTV`, `ORGAN`, `AVOIDANCE`, …). Use this, not the name, to decide what an ROI *is*.

Pitfalls:

- **Holes and multiple islands:** an ROI on one slice can have several closed contours. Whether an inner contour is a hole is not encoded explicitly in the basic object; most systems use even-odd (XOR) filling of all contours on a plane. Rasterize with a defined, tested rule and be consistent with how you write.
- **Contours on non-axial images** lie on the planes of the referenced images; don't assume constant z.
- **Point spacing and closure:** closed contours do not repeat the first point at the end.
- **Rasterization** must use the image's full index↔patient affine (orientation and spacing), and should treat pixel centers consistently (a pixel is inside if its center is inside).
- **Writing RTSTRUCT:** new SOP Instance UID; reference the exact image series and FoR you drew on; unique `ROINumber`s; colors in `ROIDisplayColor`; interpreted type set. A structure set that doesn't reference its images will not load in many TPSs.

**ROI naming:** follow **AAPM TG-263** (*Standardizing Nomenclatures in Radiation Oncology*, 2018) where the project wants standard names: ≤ 16 characters, no spaces, `_` separating categories, first character of each category capitalized, laterality as a suffix (`Parotid_L`, `Femur_Head_R`, `SpinalCord`), target conventions (`PTV_7000`, `CTV_High`…). Map institution names to TG-263 names with an explicit table; don't guess from free text, and preserve the original name.

## 2. RTDOSE

Key attributes (RT Dose module, PS3.3 C.8.8.3):

- **Dose grid = an image.** The General/Image Plane/Image Pixel/Multi-frame modules give geometry and pixels: `ImagePositionPatient`, `ImageOrientationPatient`, `PixelSpacing`, `Rows`, `Columns`, `NumberOfFrames`.
- **`DoseGridScaling (3004,000E)`** — multiply stored pixel values by this to get dose in `DoseUnits`. Pixel data are typically 16 or 32-bit unsigned integers; scale before any use.
- **`DoseUnits (3004,0002)`** — `GY` or `RELATIVE`. Refuse to sum or compare `RELATIVE` doses as if they were Gy.
- **`DoseType (3004,0004)`** — `PHYSICAL`, `EFFECTIVE` (biologically corrected by a user-defined model), or `ERROR`. Don't apply EQD2 conversion to a dose that is already `EFFECTIVE`.
- **`DoseSummationType (3004,000A)`** — what the grid represents: `PLAN` (whole plan, all fractions), `FRACTION` (one fraction of a fraction group), `BEAM`, `BRACHY`, `MULTI_PLAN`, `CONTROL_POINT`, `RECORD`, session variants and more. **Whether a grid is per-fraction or total drives every summation and BED calculation** — read it, and the referenced plan's fraction count, explicitly.
- **`GridFrameOffsetVector (3004,000C)`** — the position of each frame along the normal (`rowCosine × columnCosine`), in mm. Two interpretations exist in the standard (C.8.8.3.2):
  - **relative**: first element is 0 and offsets are relative to `ImagePositionPatient` — the form to write and the common case;
  - **absolute**: offsets are patient z coordinates, only permitted for transverse grids (orientation `1\0\0\0\1\0`) where the first element equals the z of `ImagePositionPatient`.
  
  Detect which one you have (first element 0 → relative; else check it equals IPP z for a transverse grid) and handle both. Offsets need not be uniform.
- **Frame of Reference:** dose shares the FoR of the planning CT. Different FoR means it can't be overlaid on that CT without a registration.
- **Resampling:** dose grids are coarser than CT (2–3 mm) and usually cover a sub-region. Interpolate trilinearly in patient space; outside the grid the dose is *unknown*, not zero — be explicit about which you assume.

## 3. RTPLAN essentials for dose work

You don't need the full plan model to work with dose, but you need:

- **`FractionGroupSequence (300A,0070)`** — one item per fraction group; each has `NumberOfFractionsPlanned (300A,0078)` and references the beams (or brachy setups) in that group.
- An RTDOSE references its plan via `ReferencedRTPlanSequence (300C,0002)` and, for per-fraction-group doses, the fraction group number.
- **Dose per fraction** for a `PLAN` dose of one fraction group is `D_plan / n_fractions`. With several fraction groups (e.g. a boost), each has its own fraction count — dose per fraction is per group, not per plan.
- Prescription information (`DoseReferenceSequence (300A,0010)`) is useful context but is not a substitute for the computed dose grid.

## 4. Spatial registration: REG (rigid/affine) and DSR (deformable)

Registration objects (PS3.3 C.20) relate two Frames of Reference. Two concepts: the **Source RCS** is the coordinate system of the *referenced* images; the **Registered RCS** is the one established by the registration object itself (its own `FrameOfReferenceUID`, often equal to the "fixed"/primary image set's FoR).

**The two SOP classes map in opposite directions** (PS3.17 Annex O):

| SOP class | Maps |
|---|---|
| **Spatial Registration** (REG, rigid/affine) | **Source → Registered** |
| **Deformable Spatial Registration** (DSR) | **Registered → Source** |

### Rigid / affine (Spatial Registration)

- `RegistrationSequence (0070,0308)` → per item: the source FoR / referenced images and a `MatrixRegistrationSequence (0070,0309)` → `MatrixSequence (0070,030A)` → `FrameOfReferenceTransformationMatrix (3006,00C6)`.
- The matrix is **4×4 homogeneous, 16 values in row-major order**. `ᴬM_B` maps a point in RCS_B to RCS_A: `[Ax Ay Az 1]ᵀ = ᴬM_B · [Bx By Bz 1]ᵀ`. Most code is column-major internally — transpose when loading.
- Multiple items in `MatrixSequence` are composed in sequence order (check the multiplication order in C.20.2.1.1 before implementing).
- `FrameOfReferenceTransformationMatrixType (0070,030C)`: `RIGID` (orthonormal, 6 DOF), `RIGID_SCALE`, `AFFINE`. Validate that a `RIGID` matrix really is orthonormal; reject or flag otherwise.
- An item whose referenced FoR equals the registration's own FoR carries an identity matrix — that's how the "fixed" side is expressed.
- To map image C into image B when both are registered to a common RCS A: `ᴮM_C = (ᴬM_B)⁻¹ · ᴬM_C`.

### Deformable (Deformable Spatial Registration)

- `DeformableRegistrationSequence (0064,0002)`, each item with optional `PreDeformationMatrixRegistrationSequence (0064,000F)`, a `DeformableRegistrationGridSequence (0064,0005)`, and optional `PostDeformationMatrixRegistrationSequence (0064,0010)`.
- **Application order** (C.20.3.1.1): starting from a point in the **Registered RCS**, apply the **pre-deformation matrix**, then **add the deformation vector** (interpolated at that point), then apply the **post-deformation matrix**. The result is the corresponding point in the **Source RCS**. This is a *pull-back* mapping: for each voxel of the registered (fixed) image, it tells you where to sample the source (moving) image.
- The grid has its own geometry: `ImagePositionPatient`, `ImageOrientationPatient`, `GridDimensions (0064,0007)`, `GridResolution (0064,0008)` (mm), independent of either image's grid.
- **`VectorGridData (0064,0009)`** — 32-bit float triplets per grid voxel, x fastest, then rows, then planes; values are **displacements in mm** (CP-2314 clarified this), given at **voxel centers**; interpolate between them. `(NaN, NaN, NaN)` marks undefined points.
- **To deform contours or points from source to registered** you need the *inverse* of this mapping. A DVF is not trivially invertible: invert numerically (fixed-point iteration) and check residuals, or require a DSR in the other direction.
- **To map dose from source to registered** (e.g. a prior treatment onto today's CT), the pull-back is what you want: sample source dose at the mapped point for each registered voxel. Note that this warps dose as a field and does not conserve energy/mass under large deformations.

### Vendor differences and validation

- Vendors differ in which side they put in the Registered RCS, whether they emit pre/post matrices or bake the rigid part into the grid, which direction they think "the" registration goes, and how they fill the "fixed" item. **Test with each vendor's actual objects** and with synthetic objects whose answer you know.
- Follow **AAPM TG-132** (*Use of image registration and fusion algorithms and techniques in radiotherapy*, 2017) for commissioning and QA: validate with known transforms and digital phantoms, check landmark residuals, and report registration uncertainty rather than treating a registration as exact.
- Always show the user *which* registration (and direction) is applied, and never chain registrations implicitly through a third FoR without saying so.

## 5. Review checklist

- [ ] ROIs matched across sequences by ROI number, not by item order; clinical meaning from `RTROIInterpretedType`.
- [ ] Contour data treated as patient mm; rasterization uses the full image affine and a defined hole rule.
- [ ] Dose multiplied by `DoseGridScaling`; `DoseUnits`, `DoseType` and `DoseSummationType` checked.
- [ ] `GridFrameOffsetVector` relative vs absolute form detected; non-uniform offsets supported.
- [ ] Per-fraction vs total dose decided from summation type and the plan's fraction groups.
- [ ] Registration matrices read as row-major, applied in the correct direction for their SOP class; DSR applied pre → vector → post.
- [ ] Objects in different Frames of Reference only combined through an explicit registration.
