---
name: rt-dose-math
description: Radiotherapy dose arithmetic — physical dose summation across registered timepoints, BED and EQDx (e.g. EQD2) conversion per voxel with per-structure alpha/beta values applied per timepoint before summation, handling overlapping structures and tissue outside any structure, and the assumptions and limits of the linear-quadratic model. Use when implementing or reviewing dose summation, re-irradiation assessment, BED/EQD2 maps or DVH comparisons across courses.
---

# RT Dose Math

Dose summation and biological conversion produce numbers clinicians act on. The arithmetic is short; the errors come from applying it in the wrong order, on the wrong grid, with the wrong fraction count, or with an α/β nobody chose deliberately. **Every summed or converted dose must say how it was made.**

Notation follows Bentzen et al., *Bioeffect modeling and equieffective dose concepts in radiation oncology* (Radiother Oncol 2012): **EQDx** is the dose in x-Gy fractions that gives the same effect (EQD2 for x = 2), **BED** is the biologically effective dose.

## 1. Physical dose summation

Physical doses (Gy) add **voxel by voxel in a common coordinate system**:

1. **Pick a reference image set** (usually the most recent planning CT) and a **reference grid** on it (its resolution and extent are a deliberate choice; usually the finer of the dose grids, covering all of them).
2. For each timepoint/course, **map its dose onto the reference grid**:
   - same Frame of Reference → resample in patient coordinates (trilinear);
   - different FoR → through an explicit **registration** (rigid or deformable), applied in the correct direction (see [rt-objects](../rt-objects/SKILL.md) §4). For each reference voxel, find the corresponding point in the timepoint's space and sample its dose there (pull-back).
3. **Sum** the mapped grids.

Rules:

- **Scale first:** every grid multiplied by its `DoseGridScaling`, units checked (`GY` only), `DoseType` `PHYSICAL`.
- **Know what each grid represents** (`DoseSummationType`): a whole-plan dose vs a single fraction vs a beam. Normalize everything to "total delivered for this course" before summing, and state it.
- **Outside a source grid the dose is unknown.** Decide explicitly (treat as 0 and flag the region, or mask it out of statistics); don't let interpolation clamp edge values across the whole reference grid.
- **Deformable mapping of dose is approximate.** It warps a field; it doesn't conserve energy in regions of large volume change, and DIR uncertainty is largest exactly where anatomy changed most. Report the registration used and treat accumulated dose as an estimate (see AAPM TG-132 on registration QA).
- Summing **planned** doses estimates what was intended; summing **delivered/reconstructed** doses is different. Label which.

## 2. BED and EQDx (linear-quadratic model)

For a course of *n* fractions with dose per fraction *d* (total *D = n·d*) and tissue parameter α/β (Gy):

```
BED  = D · (1 + d / (α/β))
EQDx = BED / (1 + x / (α/β))  =  D · (d + α/β) / (x + α/β)
EQD2 = D · (d + α/β) / (2 + α/β)
```

**Per voxel, per timepoint:** the conversion is non-linear in *d*, so it must be applied to each voxel's own dose per fraction, for each course separately:

```
for each course c (mapped to the reference grid):
    for each voxel v:
        D_cv = physical dose in v from course c          (Gy, whole course)
        d_cv = D_cv / n_c                                (dose per fraction in this voxel)
        ab_v = α/β assigned to voxel v                   (from structures; §3)
        EQDx_cv = D_cv · (d_cv + ab_v) / (x + ab_v)
EQDx_total_v = Σ_c EQDx_cv
```

Critical rules:

- **Convert per course, then sum.** Never sum physical doses across courses with different fractionation and then convert — the result is wrong whenever *d* differs between courses (which is the point of re-irradiation assessment).
- **Use the voxel's dose per fraction, not the prescription's.** A voxel at 50% isodose received half the prescription dose per fraction; using the prescription *d* overstates its BED.
- **Use the right fraction count per course**, from the plan's fraction groups (`NumberOfFractionsPlanned`) — or the delivered count if summing delivered dose. Plans with several fraction groups (e.g. a sequential boost) need each group handled as its own course, since *d* differs.
- **Map physical dose to the reference first, then convert** using the reference structures' α/β. (Converting on the native grid and then interpolating EQD gives slightly different values; pick one order, document it, and use it consistently.)
- **Don't convert twice:** if a grid's `DoseType` is `EFFECTIVE` or it is already EQD2, it must not go through the formula again.
- **EQDx is not additive with physical dose.** Keep physical and biological maps separate and labelled; never add an EQD2 grid to a physical grid.

## 3. Assigning α/β per voxel

- α/β is a **per-structure clinical parameter**, typically ≈ 10 Gy for early-responding tissue and many tumours and ≈ 2–3 Gy for late-responding normal tissue (spinal cord, brainstem, etc.), with tumour-specific exceptions (prostate ≈ 1.5 Gy, for example). **These values are inputs chosen by the user or a protocol** — never hard-code them silently or pick them from structure names without confirmation. Store the chosen value with each structure and show it in the result.
- **Rasterize structures on the reference grid** (with the same rule used elsewhere; see rt-objects), producing a per-voxel structure membership.
- **Overlapping structures** (a PTV overlapping the rectum, nested OARs): a voxel can belong to several structures with different α/β. Choose an explicit, documented rule:
  - a **priority order** (user-defined list; first match wins), or
  - **most conservative for the question being asked** — for normal-tissue toxicity, the *lowest* α/β (which gives the highest EQD2 for d > 2 Gy and the lowest for d < 2 Gy; "conservative" depends on the dose per fraction, so prefer an explicit priority list);
  - and, when reporting a structure's DVH, use *that structure's* α/β for all its voxels regardless of the map-wide rule.
- **Tissue outside any structure** needs a default α/β (commonly 3 Gy for unspecified normal tissue). Make the default a visible setting, and mark these voxels in the output.
- Structures from different timepoints must be mapped to the reference too, or the reference structures used throughout — say which.

## 4. Limits of the model (state them in the UI/report)

- The LQ model is least reliable at **high dose per fraction** (SBRT/SRS, roughly above 8–10 Gy per fraction) and very low doses per fraction.
- These formulas ignore **overall treatment time** (repopulation), **incomplete repair** between fractions given less than ~6–8 h apart, and **dose rate** (brachytherapy, LDR need other forms).
- **Recovery between courses** for re-irradiation (tissue-specific, time-dependent "discount" factors) is a clinical judgment, not part of this arithmetic. If the tool applies one, it is an explicit, user-entered parameter.
- Uncertainty from **registration**, especially deformable, propagates into accumulated dose.

## 5. Implementation and testing

- Pure functions: `toEqdx(physical: Float32Array, fractions: number, alphaBeta: Float32Array, x: number): Float32Array` — no hidden globals. Keep α/β, x, fraction counts and the overlap rule in a parameters object that is saved with the result.
- Use `Float32Array`/`Float64Array` grids; check for division by zero (`x + α/β > 0` always holds for positive inputs, but validate inputs).
- **Known-answer tests:**
  - EQD2 of 2 Gy × n equals the physical dose for any α/β.
  - 60 Gy in 30 fractions, α/β = 10 → BED 72 Gy, EQD2 60 Gy; 5 × 8 Gy, α/β = 3 → BED ≈ 146.7 Gy, EQD2 88 Gy.
  - Two courses with different fractionation: per-course conversion then sum ≠ sum then convert (test asserts the former).
  - A voxel at 50% of prescription uses its own d.
  - Overlap rule: a voxel in two structures gets the α/β the rule specifies; a voxel in none gets the default.
  - Constant and linear synthetic dose grids mapped through a known translation give the expected summed values (see [dicom-test-data](../dicom-test-data/SKILL.md)).
- **Provenance in the output:** list source dose objects (SOP Instance UIDs), registrations used and their direction, reference grid, fraction counts, α/β per structure and the default, overlap rule, x, and the model caveats. If the output is saved as RTDOSE, set `DoseType` to `EFFECTIVE` for biological maps and describe the method in `DoseComment`.
