---
name: dicom-fundamentals
description: Core DICOM concepts needed to handle images correctly — the patient/study/series/instance model and UIDs, transfer syntaxes, the patient coordinate system (LPS), Image Position/Orientation (Patient), ordering slices by position rather than Instance Number, rescale slope/intercept, pixel spacing and irregular or anisotropic spacing, and Frame of Reference. Use when parsing DICOM, building volumes from series, or doing any geometry on DICOM images.
---

# DICOM Fundamentals

DICOM bugs are rarely crashes. They are images that load fine but are mirrored, mis-scaled, out of order or shifted by a few millimetres. In a radiotherapy context those errors move contours and dose. **Verify against the standard** ([DICOM PS3](https://www.dicomstandard.org/current), especially PS3.3 Information Object Definitions, PS3.5 Data Structures and Encoding, PS3.6 Data Dictionary) rather than memory or a single vendor's files.

## 1. Information model and UIDs

- **Patient → Study → Series → Instance.** A *series* is one acquisition or one derived object set; a CT volume is usually one series of many single-frame instances (or one enhanced multi-frame instance).
- **Identify things by UID, never by description or number.** `StudyInstanceUID (0020,000D)`, `SeriesInstanceUID (0020,000E)`, `SOPInstanceUID (0008,0018)`, `SOPClassUID (0008,0016)`. Series Description, Series Number and Instance Number are for display only.
- **`SOPClassUID` says what an object is** (CT Image, RT Structure Set, RT Dose, Spatial Registration…). Dispatch on it, not on `Modality` alone.
- **UIDs are dotted-numeric strings ≤ 64 characters**, unique worldwide. Generate new ones from an organization root you control, or the `2.25.<uuid-as-integer>` form (PS3.5 B.2). Never reuse, increment or "edit" an existing UID to make a new object.
- **Derived objects get new UIDs** — a resampled, anonymized or edited image is a new instance (and normally a new series).

## 2. Encoding and transfer syntaxes

- The **Transfer Syntax UID (0002,0010)** in the file meta header says how the dataset is encoded: implicit vs explicit VR, byte order, and pixel compression.
  - `1.2.840.10008.1.2` Implicit VR Little Endian (the default)
  - `1.2.840.10008.1.2.1` Explicit VR Little Endian
  - Encapsulated (compressed) syntaxes: JPEG Baseline/Lossless, JPEG-LS, JPEG 2000, RLE, deflate, HTJ2K…
- **Check the transfer syntax before reading Pixel Data** and decode or reject explicitly; don't assume raw little-endian pixels.
- **Lossy compressed images** (`LossyImageCompression (0028,2110) = "01"`) must not be silently treated as diagnostic-quality originals, and must not be re-compressed lossily in a pipeline.
- Read `BitsAllocated`, `BitsStored`, `HighBit`, `PixelRepresentation` (0 unsigned, 1 two's complement signed), `SamplesPerPixel` and `PhotometricInterpretation` (`MONOCHROME1` is inverted relative to `MONOCHROME2`) — never assume 16-bit signed.

## 3. Patient coordinate system (LPS)

DICOM's patient-based coordinate system (PS3.3 C.7.6.2.1.1) is right-handed and in **millimetres**:

- **+x → patient's Left**, **+y → Posterior**, **+z → Superior (Head)**. Hence "LPS".
- Many other tools (ITK/3D Slicer world space, NIfTI's RAS) use different conventions. **Convert explicitly at the boundary** (LPS↔RAS flips x and y) and name variables by their space.
- Coordinates are relative to the patient, independent of how the patient lay on the table — but positions (head-first supine, feet-first prone…, `PatientPosition (0018,5100)`) affect how the scanner chose its axes, which is why you must use the orientation vectors rather than assume an axial stack.

## 4. Image Plane: position, orientation, spacing

For each frame:

- **`ImagePositionPatient (0020,0032)`** — x, y, z (mm) of the **center of the first transmitted pixel** (top-left).
- **`ImageOrientationPatient (0020,0037)`** — two unit vectors: the direction cosines of the **row** (direction of increasing column index) and the **column** (direction of increasing row index).
- **`PixelSpacing (0028,0030)`** — **row spacing first, then column spacing** (i.e. `[Δ between rows (y), Δ between columns (x)]`). Swapping them is a classic bug that only shows on non-square pixels.

The patient position of pixel (column *i*, row *j*):

```
P(i, j) = IPP + i · Δcol · rowCosine + j · Δrow · columnCosine
```

- The **slice normal** is `rowCosine × columnCosine`.
- Don't assume axial: sagittal, coronal and **oblique / gantry-tilted** series are common (and MR is often oblique). Always build geometry from IPP/IOP.
- `SliceThickness (0018,0050)` is the nominal reconstructed thickness, **not the spacing between slices**. `SpacingBetweenSlices (0018,0088)` is optional and unreliable; compute spacing from positions.

## 5. Building a volume from a series

1. **Group** instances by `SeriesInstanceUID`, then check they share `FrameOfReferenceUID`, `ImageOrientationPatient` (within tolerance), `Rows`/`Columns`, `PixelSpacing`. Split or reject otherwise (a series can contain localizers, multiple stacks or different echoes).
2. **Sort by position along the slice normal**: `d = normal · IPP`. **Never sort by `InstanceNumber`** — it's display order, may be reversed, duplicated or missing. Never sort by file name.
3. **Check spacing**: compute successive `Δd`. Handle:
   - **duplicates** (Δ ≈ 0) — usually multiple acquisitions or temporal positions mixed in one series;
   - **irregular spacing** — gaps or variable spacing; either resample to a regular grid (and say so) or keep per-slice positions; never silently assume uniform spacing;
   - **gantry tilt** — slices are parallel but IPP is offset in-plane between slices, so the volume is sheared, not a simple box.
4. The volume's **index→patient affine** comes from the first slice's IPP, the IOP cosines, the pixel spacing and the computed slice spacing/normal. Store it with the volume; every downstream mapping (rendering, contours, dose) derives from it.

**Anisotropic voxels are the norm** (e.g. 0.98 × 0.98 × 3 mm). Every computation in "voxel units" must multiply by spacing per axis before measuring distance, volume or angle.

## 6. Pixel values

- **Modality LUT:** stored value → modality units with `RescaleSlope (0028,1053)` and `RescaleIntercept (0028,1052)`: `value = stored × slope + intercept`. For CT this gives **Hounsfield units**. Apply it before any thresholding or physical interpretation. Slope/intercept can differ per slice — apply them per instance.
- Defaults when absent are slope 1, intercept 0 — but check `RescaleType (0028,1054)` and modality-specific rules.
- **Window/level** (`WindowCenter`/`WindowWidth`, VOI LUT) is display only. Never bake it into stored data.
- Use a floating-point type (or a wide enough integer) after rescaling; slope can be fractional (PET, some MR).

## 7. Frame of Reference

- **`FrameOfReferenceUID (0020,0052)`** identifies a spatial coordinate system. Images with the same FoR UID share patient coordinates and can be overlaid **without registration**.
- **Different FoR UIDs mean no known spatial relationship** — overlaying them requires a registration object (see [rt-objects](../rt-objects/SKILL.md)). Matching patient IDs or "they look aligned" is not a relationship.
- RT objects (structure sets, doses, plans) reference a FoR; check it matches the image you display them on.

## 8. Common bugs checklist

- [ ] Slices sorted by `InstanceNumber` or file name instead of position along the normal.
- [ ] Pixel Spacing row/column swapped.
- [ ] Orientation assumed axial; oblique/tilted series rendered as a box.
- [ ] `SliceThickness` used as slice spacing.
- [ ] Rescale slope/intercept ignored or applied once for the whole series.
- [ ] Signed vs unsigned pixel representation ignored; `MONOCHROME1` not inverted.
- [ ] LPS mixed with RAS without a conversion.
- [ ] Distances or volumes computed in voxel units on anisotropic data.
- [ ] Objects with different Frame of Reference UIDs overlaid without a registration.
- [ ] New/derived objects created with copied or edited UIDs.
