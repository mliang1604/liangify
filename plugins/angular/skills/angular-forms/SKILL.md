---
name: angular-forms
description: Angular reactive forms — strictly-typed FormGroups, validators, FormBuilder, async validators, dynamic forms with FormArray, and form-state signals. Use when implementing or reviewing form code. Always prefer reactive forms over template-driven.
---

# Angular Forms

**Always reactive, never template-driven** for new code. Reactive forms have explicit types, testable validation, and predictable change detection. Template-driven forms exist for legacy and trivial demos only.

## 1. Typed reactive forms (Angular 14+)

Declare the form's shape and Angular enforces it everywhere.

```ts
private fb = inject(NonNullableFormBuilder);

form = this.fb.group({
  email:    this.fb.control('', { validators: [Validators.required, Validators.email] }),
  password: this.fb.control('', { validators: [Validators.required, Validators.minLength(8)] }),
  remember: this.fb.control(false),
});

// form.value is { email: string; password: string; remember: boolean }
```

- Use **`NonNullableFormBuilder`** — eliminates the `string | null` nuisance for most fields.
- Prefer `fb.group(...)` to `new FormGroup({ ... })` — less ceremony, better defaults.

## 2. Validators

- **Built-ins first**: `Validators.required`, `email`, `min`, `max`, `minLength`, `maxLength`, `pattern`.
- **Custom synchronous validator**: `(c: AbstractControl): ValidationErrors | null => ...`
- **Cross-field validation** goes on the parent `FormGroup`, not on individual controls.
- **Async validators** for server-side checks (username availability, etc.); they run only after sync validators pass.

```ts
const matchPasswords: ValidatorFn = (g) => {
  const pw = g.get('password')?.value;
  const c  = g.get('confirm')?.value;
  return pw === c ? null : { mismatch: true };
};
```

## 3. Template binding

```html
<form [formGroup]="form" (ngSubmit)="submit()">
  <input formControlName="email" />
  @if (form.controls.email.touched && form.controls.email.errors?.['email']) {
    <span class="err">Invalid email</span>
  }

  <button type="submit" [disabled]="form.invalid || submitting()">Sign in</button>
</form>
```

- Show errors on `touched` (or `dirty`), not before — pre-emptive errors are user-hostile.
- Disable submit on `form.invalid`, not by tracking individual fields.

## 4. Dynamic forms

- **`FormArray`** for variable-length lists (add/remove rows). Type it: `FormArray<FormGroup<{ /* ... */ }>>`.
- For wizards, prefer **one form per step** with a parent state object — avoids monster nested groups and per-step validation gets simpler.

## 5. State signals

Expose form state as signals so the template stays signal-driven:

```ts
formValue  = toSignal(this.form.valueChanges,  { initialValue: this.form.getRawValue() });
formStatus = toSignal(this.form.statusChanges, { initialValue: this.form.status });
```

## 6. Reset and patch

- **`patchValue`** — partial update, ignores missing fields. Use for "load from API" flows.
- **`setValue`** — full update, throws on shape mismatch. Use to catch drift between API and form.
- **`reset(initialValues)`** clears validation state — important after a successful submit so the form doesn't show stale errors.

## 7. Common pitfalls

- `formControlName` is a string — typos compile fine. Mitigate by using the typed `form.controls.fieldName` for code-side access.
- Validating in the component class via `valueChanges.subscribe` — that's what validators are for.
- `disabled` on a typed control changes its emitted value (it disappears from `.value`). Use `getRawValue()` to include disabled fields.
- Mixing `[(ngModel)]` with reactive form controls — pick one paradigm per form.
- Calling `markAsDirty()` / `markAsTouched()` manually to force errors — usually a sign you should disable the submit button instead.
