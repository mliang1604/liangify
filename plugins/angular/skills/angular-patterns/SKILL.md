---
name: angular-patterns
description: Modern Angular (17+) conventions — standalone components, `inject()` DI, signals for state, `@if`/`@for`/`@switch` control flow, OnPush change detection, signal inputs/outputs. Use when writing or reviewing Angular components, services, directives, or templates.
---

# Angular Patterns (Angular 17+)

These reflect Angular's current direction: signals, standalone, new control flow. When working in an older codebase, match the existing style and surface migration opportunities as separate work — don't mix paradigms in one file.

## 1. Standalone by default

`NgModule` is legacy. New components, directives, and pipes are standalone.

```ts
@Component({
  selector: 'app-user-card',
  standalone: true,   // optional in v19+ (default), explicit for clarity in older
  imports: [RouterLink],
  templateUrl: './user-card.html',
})
export class UserCard { }
```

## 2. `inject()` over constructor injection

`inject()` works in field initializers, composes cleanly, and avoids constructor parameter noise.

```ts
// Prefer
export class UserService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
}

// Reserve the constructor for cases that genuinely need ordering or logic.
```

## 3. Signals for component state

Prefer signals over `BehaviorSubject` or plain fields when the value drives the template.

```ts
export class Counter {
  count = signal(0);
  doubled = computed(() => this.count() * 2);

  increment() { this.count.update(n => n + 1); }
}
```

- Use `computed()` for derived state — never duplicate.
- Use `effect()` sparingly, only for true side effects (DOM, localStorage, logging). Effects must not write to other signals.

## 4. Signal inputs/outputs (v17.1+)

```ts
export class UserCard {
  user = input.required<User>();
  compact = input(false);
  selected = output<UserId>();
}
```

- `input.required<T>()` makes the binding mandatory at compile time.
- `output()` replaces `EventEmitter` — simpler API, no subscription-leak risk.
- Use `model()` for two-way binding (replaces the `[(thing)]` + `thingChange` pair).

## 5. New control flow in templates

Use `@if` / `@for` / `@switch` — they're built-in, type-narrow correctly, and don't require `CommonModule`.

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
```

- **`track` is mandatory in `@for`.** Pick the stable identity. Don't `track $index` unless the list is truly positional.

## 6. Change Detection: OnPush by default

Default every new component to `OnPush`. Signals + OnPush is the intended combination — faster and forces explicit data flow.

```ts
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  // ...
})
```

## 7. Services and DI

- **`providedIn: 'root'`** for app-wide singletons — tree-shakeable, no module needed.
- **`providedIn: 'platform'`** only when sharing across multiple Angular apps on one page (rare).
- Use **`InjectionToken<T>`** for non-class dependencies (config objects, primitives, factory functions).

## 8. Routing

- Lazy-load routes by default: `loadComponent: () => import('./page').then(m => m.Page)`.
- Use `provideRouter()` with `withComponentInputBinding()` so route params bind directly to signal inputs.
- Prefer **functional guards** (`CanActivateFn`) over class-based — less boilerplate.

## 9. Common smells to flag in review

- `*ngIf` / `*ngFor` in new code → should be `@if` / `@for`.
- Constructor injection where `inject()` would be cleaner (especially 5+ params).
- `BehaviorSubject` driving template state → should be a signal.
- Missing `track` in `@for`.
- `ChangeDetectorRef.detectChanges()` calls — usually a sign of fighting CD; OnPush + signals fixes it.
- Subscriptions without `takeUntilDestroyed()` or `async` pipe.
- `EventEmitter` for new component outputs → use `output()`.
- `@Input()` decorator for new bindings → use `input()` signal input.
