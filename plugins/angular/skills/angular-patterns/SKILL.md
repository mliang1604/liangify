---
name: angular-patterns
description: Modern Angular 22 conventions — standalone components, `inject()` and `@Service()` DI, signals for state, `@if`/`@for`/`@switch` control flow, OnPush (the default), zoneless change detection, signal inputs/outputs. Use when writing or reviewing Angular components, services, directives, or templates.
---

# Angular Patterns (Angular 22)

Baseline: **Angular 22** — standalone, signals, OnPush by default, zoneless. When working in an older codebase, match the existing style and surface migration opportunities as separate work; don't mix paradigms in one file. Legacy notes below are only there to help you recognise older code.

## 1. Standalone is the default

Components, directives and pipes are standalone unless declared otherwise, so **don't write `standalone: true`** — it's redundant. `NgModule` is legacy; don't add new ones.

```ts
@Component({
  selector: 'app-user-card',
  imports: [RouterLink],
  templateUrl: './user-card.html',
})
export class UserCard {}
```

## 2. `inject()` and `@Service()`

`inject()` works in field initializers, composes cleanly, and avoids constructor parameter noise.

```ts
import { Service, inject } from '@angular/core';

@Service()                       // = @Injectable({ providedIn: 'root' })
export class UserService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
}
```

- **`@Service()`** is the Angular 22 way to declare a root-provided service. It requires `inject()` (no constructor injection). `@Service({ autoProvided: false })` opts out of root provision when the service must be provided explicitly (per route or component).
- **`@Injectable()`** remains correct for services you provide yourself, and for classes that need constructor injection. `ng generate service --injectable` produces it.
- **`injectAsync(() => import('./heavy.service'))`** lazy-loads a rarely used, heavy service while still going through DI. It must run in an injection context, and the service must be auto-provided. Use it for genuinely heavy code paths, not as a default.
- Keep pure domain logic (math, parsing, geometry) in plain functions or classes outside DI — they're trivially testable — and let services be thin shells around them.

## 3. Signals for state

Prefer signals over `BehaviorSubject` or plain fields when the value drives the template. With OnPush and zoneless, **a plain field mutation won't re-render** — that's by design.

```ts
export class Counter {
  count = signal(0);
  doubled = computed(() => this.count() * 2);

  increment() { this.count.update(n => n + 1); }
}
```

- `computed()` for derived state — never duplicate.
- `linkedSignal()` for writable state that resets when a source changes (e.g. the selected item when the list changes).
- `effect()` sparingly, only for true side effects that leave Angular (DOM APIs, storage, logging, canvas/GPU calls). Don't use effects to copy one signal into another — that's `computed` or `linkedSignal`. For DOM work after render, use `afterRenderEffect()` / `afterNextRender()`.
- Async data: `resource()` / `httpResource()` (stable in v22). See [rxjs-patterns](../rxjs-patterns/SKILL.md) for when to choose them over observables.

## 4. Signal inputs, outputs and models

```ts
export class UserCard {
  user = input.required<User>();
  compact = input(false);
  selected = output<UserId>();
  expanded = model(false);   // two-way: [(expanded)]
}
```

- `input.required<T>()` makes the binding mandatory at compile time.
- `output()` replaces `EventEmitter`.
- `model()` replaces the `@Input() x` + `@Output() xChange` pair.
- Inputs, outputs and models on one class must have distinct names (including aliases) — v22 rejects collisions at compile time.

## 5. Control flow in templates

Use `@if` / `@for` / `@switch` — built in, type-narrowing, no `CommonModule`.

```html
@if (user(); as u) {
  <h1>{{ u.name }}</h1>
} @else {
  <p>Loading…</p>
}

@for (item of items(); track item.id) {
  <li>{{ item.label }}</li>
} @empty {
  <li>No items</li>
}

@let s = shape();
@switch (s.kind) {
  @case ('circle') { <app-circle [shape]="s" /> }
  @case ('square') { <app-square [shape]="s" /> }
  @default never;   <!-- compile error if a new kind is added and not handled -->
}
```

- **`track` is mandatory in `@for`.** Pick the stable identity. Don't `track $index` unless the list is truly positional.
- Use `@default never;` on `@switch` over unions to get exhaustiveness checking. Narrowing only works on a variable, not a function or signal call, so read the signal into `@let` first (as above).
- `@defer` for heavy, below-the-fold or interaction-gated UI (`on viewport`, `on interaction`, `on idle`).
- Templates are strict by default (`strictTemplates`), and `?.` yields `undefined` (not `null`), matching TypeScript.

## 6. Change detection: OnPush is the default

In Angular 22, a component with no `changeDetection` set **is OnPush**. Don't add `changeDetection: ChangeDetectionStrategy.OnPush` to new components — it's noise.

- The old `Default` strategy is now called **`ChangeDetectionStrategy.Eager`**. If you see `Eager` in a migrated codebase, it was added by `ng update` to preserve old behavior — treat each one as a candidate for conversion to signals, not as a pattern to copy.
- `ChangeDetectorRef.detectChanges()` / `markForCheck()` in app code is usually a sign of state that should be a signal.

## 7. Zoneless change detection

Zoneless has been the default since Angular 21: there is no `zone.js`, and Angular doesn't run change detection after every async callback. Change detection is scheduled only by:

- updating a **signal** read in a template,
- `ComponentRef.setInput()` (which is how inputs are set),
- a **bound template or host listener** firing (`(click)`, `host: { '(keydown)': ... }`),
- `ChangeDetectorRef.markForCheck()` (which the `async` pipe calls for you),
- attaching a view that one of the above marked dirty.

Setup and checks:

- New apps need nothing. `provideZonelessChangeDetection()` is how you enabled it in v20; on v21+ it's implicit. If an app still calls **`provideZoneChangeDetection()`**, it has opted back into zones — remove it once the app is compatible.
- Remove `zone.js` and `zone.js/testing` from the `polyfills` of the build **and** test targets, then uninstall the package.

Pitfalls:

- **`setTimeout`, `Promise.then`, `fetch`, `addEventListener` (not bound in a template), WebSocket and Web Worker callbacks no longer trigger rendering.** Write the result into a signal.
- **Reactive forms don't schedule change detection.** `setValue`, `patchValue` and `FormArray.push` called from code need their state exposed as signals (or a `markForCheck()`). Signal Forms avoid this entirely.
- **`NgZone.onStable`, `onMicrotaskEmpty` and `onUnstable` never emit, and `isStable` is always true.** Code waiting on them (often in older third-party libraries, e.g. "wait until stable then measure") silently stops working. Replace with `afterNextRender` (one render) or `afterEveryRender`, or with a DOM API such as `ResizeObserver` / `MutationObserver`.
- **Third-party code that mutates component state from its own callbacks** (charting, map, editor and canvas libraries) won't update the view. Wrap the callback to write into a signal. `NgZone.run` / `runOutsideAngular` calls are harmless in zoneless and can stay in shared libraries.
- **SSR stability:** without zones, the server can't tell when the app is done. Async work that must finish before serialization goes through `PendingTasks.run(...)`, or `pendingUntilEvent()` for observables. Router navigations and `HttpClient` requests are already tracked.
- **Tests** are zoneless too: `ExpressionChangedAfterItHasBeenCheckedError` in a test means a value changed without notifying Angular — fix the component, not the test. See [angular-testing](../angular-testing/SKILL.md).

## 8. Services and DI

- `@Service()` (or `providedIn: 'root'`) for app-wide singletons — tree-shakeable, no module needed.
- Route-level `providers` for state scoped to a feature; component `providers` for per-instance state.
- **`InjectionToken<T>`** for non-class dependencies (config objects, primitives, factory functions).

## 9. Routing

- Lazy-load routes: `loadComponent: () => import('./page').then(m => m.Page)` (or `() => import('./page')` with a default export).
- `provideRouter(routes, withComponentInputBinding())` binds route params, data and query params straight to signal inputs.
- Functional guards and resolvers (`CanActivateFn`, `CanMatchFn`, `ResolveFn`) — no class-based guards. `CanMatchFn` receives a third `currentSnapshot` argument in v22.
- `paramsInheritanceStrategy` defaults to `'always'` in v22: child routes see parent params.

## 10. HTTP

- `provideHttpClient()` uses the Fetch backend by default in v22; `withFetch()` is redundant. Use `withXhr()` only when you need upload progress, which Fetch doesn't report.
- `reportProgress` is deprecated; use `reportUploadProgress` / `reportDownloadProgress`.

## 11. Common smells to flag in review

- `standalone: true` or `changeDetection: ChangeDetectionStrategy.OnPush` on new components — both are defaults now.
- `*ngIf` / `*ngFor` / `[ngSwitch]` in new code → `@if` / `@for` / `@switch`.
- `@Injectable({ providedIn: 'root' })` on a new service → `@Service()`.
- Constructor injection where `inject()` would be cleaner (especially 5+ params).
- `BehaviorSubject` or a plain field driving template state → signal.
- An `effect()` that writes to another signal → `computed` / `linkedSignal`.
- State updated from `setTimeout`, a third-party callback or a manual `subscribe` without going through a signal — won't render under zoneless.
- `NgZone.onStable` / `isStable` used as a "rendering finished" signal → `afterNextRender`.
- Missing `track` in `@for`.
- `ChangeDetectorRef.detectChanges()` calls — fighting change detection.
- Subscriptions without `takeUntilDestroyed()`, `toSignal()` or the `async` pipe.
- `EventEmitter` / `@Input()` / `@Output()` for new bindings → `output()` / `input()` / `model()`.
- `provideZoneChangeDetection()` or `zone.js` in polyfills of a project that's meant to be zoneless.
