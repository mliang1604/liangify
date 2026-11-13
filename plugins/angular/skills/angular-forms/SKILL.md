---
name: angular-forms
description: Angular 22 forms — Signal Forms (`@angular/forms/signals`, stable in v22) as the default for new forms, with schema validation, `[formField]`, `submit()` and custom controls; plus strictly-typed reactive forms for existing reactive-forms code and zoneless pitfalls. Use when implementing or reviewing form code.
---

# Angular Forms

Baseline: **Angular 22.** Which API to use:

| Situation | Use |
|---|---|
| New form in a signals/zoneless app | **Signal Forms** (`@angular/forms/signals`) |
| Existing form or feature built on reactive forms | **Reactive forms** — extend them; migrate as separate work |
| Template-driven (`ngModel`) | Only to maintain existing code. Don't start new forms with it |

Don't mix paradigms within one form. Signal Forms became stable in v22; if a project pins an older Angular, check its version before using them.

## 1. Signal Forms

The **model is a signal you own**; `form()` derives a field tree from it, and the **schema** declares validation and logic once.

```ts
import { Component, inject, signal } from '@angular/core';
import { form, FormField, FormRoot, required, email, minLength, validate } from '@angular/forms/signals';

interface SignUp { email: string; password: string; confirm: string; newsletter: boolean }

@Component({
  selector: 'app-sign-up',
  imports: [FormField, FormRoot],
  templateUrl: './sign-up.html',
})
export class SignUpForm {
  private api = inject(AccountApi);
  model = signal<SignUp>({ email: '', password: '', confirm: '', newsletter: false });

  signUp = form(this.model, (p) => {
    required(p.email, { message: 'Email is required' });
    email(p.email, { message: 'Enter a valid email' });
    required(p.password);
    minLength(p.password, 12, { message: 'At least 12 characters' });
    validate(p.confirm, ({ value, valueOf }) =>
      value() === valueOf(p.password) ? null : { kind: 'mismatch', message: 'Passwords differ' });
  }, {
    submission: {
      action: async (f) => {
        const result = await this.api.signUp(f().value());
        return result.ok ? undefined : { kind: 'server', message: result.message, fieldTree: f.email };
      },
    },
  });
}
```

```html
<form [formRoot]="signUp">
  <input type="email" [formField]="signUp.email" />
  @if (signUp.email().touched() && signUp.email().invalid()) {
    @for (e of signUp.email().errors(); track e.kind) { <span class="err">{{ e.message }}</span> }
  }

  <input type="password" [formField]="signUp.password" />
  <input type="password" [formField]="signUp.confirm" />
  <label><input type="checkbox" [formField]="signUp.newsletter" /> Newsletter</label>

  <button type="submit" [disabled]="signUp().submitting()">Create account</button>
</form>
```

Key points:

- **Field state is signals:** `field().value()`, `valid()`, `invalid()`, `errors()`, `pending()`, `touched()`, `dirty()`, `disabled()`, `hidden()`, `readonly()`. The whole form is `signUp()`. Everything is reactive, so it works with OnPush and zoneless with no extra wiring.
- **Types come from the model.** `signUp.email` exists because `SignUp.email` does; typos fail to compile (unlike `formControlName="..."`).
- **The model signal is the source of truth.** Load data with `model.set(...)` / `model.update(...)`; read the current value from the model or `form().value()`.
- **Built-in rules:** `required`, `email`, `min`, `max`, `minLength`, `maxLength`, `pattern`, `minDate`, `maxDate`, each taking `{ message }`. `min`/`max` accept a function for dynamic bounds. `required` treats `0` and `[]` as present — use `minLength` for "at least one item".
- **Custom rules:** `validate(path, ctx => error | null)`; return `{ kind, message }`. Put reusable rules in plain functions that call `validate`.
- **Cross-field:** `validate` with `valueOf(otherPath)` for one field that depends on another; `validateTree` when the error should land on a different field (`fieldTree: ctx.fieldTree.x`).
- **Conditional logic:** pass `{ when: ({ valueOf }) => ... }` to rules, and use `disabled(...)`, `hidden(...)`, `readonly(...)` in the schema instead of toggling state from component code. The older positional-function form of these is deprecated.
- **Async validation:** `validateHttp(path, { request, onSuccess, onError, debounce })` or `validateAsync(...)`. Runs only after sync rules pass; `pending()` is true meanwhile. `debounce(path, ms | 'blur')` delays value propagation for chatty inputs.
- **Arrays:** model them as arrays in the signal; apply per-item rules with `applyEach(p.items, item => { ... })`. Add/remove rows by updating the model.
- **Reuse:** extract schema fragments with `schema<T>(p => ...)` and `apply(p.address, addressSchema)`.
- **Submission:** `[formRoot]` sets `novalidate`, prevents the native submit, marks interactive fields touched, validates, and runs the `submission.action` only if valid. Without `FormRoot`, call `await submit(this.signUp, action)` from a click handler. Return server errors (optionally with `fieldTree` to target a field, or an array for several); returning nothing means success. Server errors clear when the user edits the field.
- **No native validation:** Signal Forms don't use the browser's constraint validation, so don't style on `:invalid` or read `validity`.

### Custom controls

Implement `FormValueControl<T>` (a `value` model, plus optional inputs like `disabled`, `errors`, `touched`) so a component can be bound with `[formField]`. That replaces `ControlValueAccessor` for new controls, and the same component also works with `formControlName` and `ngModel`. Existing `ControlValueAccessor` components keep working with `[formField]`.

In v22, `touched` on a custom control is an input plus a `touch()` output (not a model). `markAsTouched()` also marks descendants unless you pass `{ skipDescendants: true }`.

## 2. Reactive forms (existing code)

When a feature already uses reactive forms, keep it consistent and keep it strictly typed.

```ts
private fb = inject(NonNullableFormBuilder);

form = this.fb.group({
  email:    this.fb.control('', { validators: [Validators.required, Validators.email] }),
  password: this.fb.control('', { validators: [Validators.required, Validators.minLength(12)] }),
  remember: this.fb.control(false),
});
// form.value: Partial<{ email: string; password: string; remember: boolean }>
// form.getRawValue(): { email: string; password: string; remember: boolean }
```

- **`NonNullableFormBuilder`** avoids `string | null` on every field.
- **Cross-field validators** go on the parent `FormGroup`. Async validators run only after sync validators pass.
- **`FormArray<FormGroup<...>>`** for variable-length lists; for wizards, one form per step.
- **`patchValue`** for partial loads, **`setValue`** to catch shape drift, **`reset(initial)`** after a successful submit.
- **`disabled` controls drop out of `.value`** — use `getRawValue()`.
- Use typed `form.controls.email` in code; `formControlName` strings aren't checked.

### Reactive forms under zoneless

Reactive forms are observable-based and **don't notify change detection** when code calls `setValue`, `patchValue`, `reset`, `enable`/`disable` or `FormArray.push`. In a zoneless OnPush component, the view can go stale.

- Expose what the template reads as signals: `status = toSignal(this.form.statusChanges, { initialValue: this.form.status })`, likewise `valueChanges` with `getRawValue()` as the initial value.
- Or call `markForCheck()` after programmatic updates — but repeated need for it is a sign the form should move to Signal Forms.
- User typing is fine: bound DOM events notify Angular.

## 3. UX rules (both APIs)

- Show errors on `touched` (or after a submit attempt), not before.
- Disable submit while submitting (`submitting()` / your own flag), not merely while invalid — clicking submit on an invalid form is how users discover what's missing, and `submit()` marks fields touched for exactly that reason.
- Map server-side validation errors onto the specific field, not a generic banner.

## 4. Common pitfalls

- Validating in component code via `valueChanges.subscribe` or an `effect()` — put rules in validators or the schema.
- Toggling disabled/hidden state imperatively instead of `disabled()` / `hidden()` rules in the schema.
- Keeping a parallel copy of the form value in another signal. The Signal Forms model *is* the value; for reactive forms, derive it with `toSignal`.
- Mixing `[(ngModel)]`, `formControlName` and `[formField]` within one form.
- Starting a new form with reactive forms in a signals-first app "because it's familiar" — that reintroduces the zoneless change-detection gap above.
