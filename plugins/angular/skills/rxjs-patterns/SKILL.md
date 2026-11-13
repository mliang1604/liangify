---
name: rxjs-patterns
description: RxJS and async-data patterns for Angular 22 — choosing between signals, resources (`resource`/`httpResource`/`rxResource`) and observables, signal/observable interop, subscription lifecycle with `takeUntilDestroyed`, operator selection, and common pitfalls. Use when working with RxJS imports, async data loading, or streams.
---

# RxJS Patterns

Baseline: **Angular 22.** Signals hold state; **resources** turn async loads into signals; **RxJS** is for genuine streams of events. The three interoperate cleanly — pick the right tool, don't force everything into one.

## 1. Which tool

| Use | For |
|---|---|
| **`signal` / `computed` / `linkedSignal`** | Component and service state, derived values, anything driving the template |
| **`httpResource()`** | Loading data over HTTP that depends on signals (an id, a query, a page) |
| **`resource()`** | The same for any promise-based loader (`fetch`, IndexedDB, a Worker, a WASM call) |
| **`rxResource()`** | The same when the loader is already an observable (an existing service, a stream that emits more than once) |
| **Observables** | Event streams that need time-based or combinatorial operators: WebSockets/SSE, debounce/throttle of raw events, retries with backoff, merging several event sources, cancellation-sensitive pipelines |

**Rules of thumb:**

- Subscribing just to push a value into a signal → use `toSignal()` or a resource instead.
- A `switchMap` from a signal-derived observable to an HTTP call, wrapped back in `toSignal` → that's what `httpResource` / `rxResource` does, with loading and error state included.
- Keep RxJS where its operators earn their keep. Converting a rich pipeline to signals just to avoid RxJS is a regression.

## 2. Resources

`resource`, `rxResource` and `httpResource` are stable in Angular 22. They re-run when their `params` signal changes, cancel stale requests, and expose state as signals: `value()`, `hasValue()`, `status()` (`'idle' | 'loading' | 'reloading' | 'resolved' | 'error' | 'local'`), `isLoading()`, `error()`, plus `reload()`.

```ts
export class UserPage {
  id = input.required<string>();

  // HTTP: the request is re-issued when id() changes
  user = httpResource<User>(() => `/api/users/${this.id()}`);

  // Promise-based loader
  stats = resource({
    params: () => ({ id: this.id() }),
    loader: ({ params, abortSignal }) =>
      fetch(`/api/stats/${params.id}`, { signal: abortSignal }).then(r => r.json()),
  });

  // Observable-based loader
  history = rxResource({
    params: () => this.id(),
    stream: ({ params: id }) => this.historyService.watch(id),
  });
}
```

```html
@if (user.hasValue()) {
  <app-user-card [user]="user.value()" />
} @else if (user.error()) {
  <app-error [error]="user.error()" />
} @else {
  <app-spinner />
}
```

- Return `undefined` from `params` to put the resource in `idle` (e.g. no id yet) — it won't load.
- Guard on `hasValue()` before reading `value()`; reading `value()` in an error state throws.
- Pass `abortSignal` through to `fetch` so superseded requests are actually cancelled.
- `chain(otherResource)` inside `params` makes one resource depend on another's value and propagates loading/error states instead of firing with incomplete inputs.
- `httpResource` goes through `HttpClient`, so interceptors and `HttpTestingController` apply. Use it for **reads**. Mutations (POST/PUT/DELETE) are imperative actions — call `HttpClient` (or `firstValueFrom(...)`) from an event handler.
- `debounced(signal, ms)` (experimental in 22) returns a resource that settles after the delay — handy for search boxes without dropping into RxJS. Being experimental, prefer `toObservable(...).pipe(debounceTime(...))` in code that must stay stable.

## 3. Bridge with `toSignal` / `toObservable`

```ts
// observable → signal (auto-unsubscribes when the injection context is destroyed)
user = toSignal(this.userService.user$, { initialValue: null });

// signal → observable (emits when the signal changes, after change detection)
results$ = toObservable(this.query).pipe(
  debounceTime(300),
  distinctUntilChanged(),
  switchMap(q => this.api.search(q)),
);
```

- `toSignal` needs an injection context (or an explicit `injector`). Use `initialValue` or `requireSync: true` (for sources that emit synchronously, like a `BehaviorSubject`) so the signal's type isn't `T | undefined`.
- `toObservable` emits asynchronously and coalesces — it is not a way to observe every intermediate write.
- `outputFromObservable(obs$)` exposes a stream as a component output; `outputToObservable(cmp.someOutput)` goes the other way.
- `pendingUntilEvent()` keeps SSR from serializing until an observable emits (zoneless apps can't otherwise tell when async work is done).

## 4. Subscription lifecycle

Never let a subscription outlive its consumer. Correct patterns, in order of preference:

1. **Don't subscribe** — `toSignal()`, a resource, or the `async` pipe.
2. **`takeUntilDestroyed()`** — in an injection context it needs no argument; elsewhere pass a `DestroyRef`.
   ```ts
   constructor() {
     this.events$.pipe(takeUntilDestroyed()).subscribe(e => this.log.set(e));
   }
   ```
3. **`DestroyRef.onDestroy(...)`** for non-RxJS teardown (event listeners, GPU resources, workers).

Reject in new code: manual `Subscription` arrays + `ngOnDestroy` unsubscribes.

Under zoneless change detection, a `subscribe` callback that sets a plain field won't re-render. Write to a signal.

## 5. Operator selection

Never default to `mergeMap` for inner observables. Pick the semantic you need:

- **`switchMap`** — cancel previous, take latest. Search/autocomplete, "load for current selection".
- **`concatMap`** — queue in order, no overlap. Save-on-change, ordered writes.
- **`exhaustMap`** — ignore while in flight. Submit buttons, refresh triggers.
- **`mergeMap`** — parallel, unordered. Only when concurrency is the point; consider its `concurrent` argument.

## 6. Common operator pitfalls

- **`shareReplay({ bufferSize: 1, refCount: true })`** to share an expensive source. Without `refCount: true`, the source never unsubscribes.
- **`combineLatest`** doesn't emit until *every* source has emitted at least once. Use `startWith()` on optional sources — or use `computed()` over signals, which has no such gap.
- **`tap`** is for side effects only (logging, debugging) — never business logic.
- **`distinctUntilChanged`** uses `===` — pass a comparator for objects.

## 7. Cold vs hot

- HTTP observables are **cold** — every `.subscribe()` issues a new request. Share with `shareReplay`, or use a resource, which loads once per params change.
- `Subject` / `BehaviorSubject` are **hot** — late subscribers miss past emissions (`BehaviorSubject` replays the last). For state, a signal is usually the better primitive.

## 8. Error handling

- **`catchError`** must return an observable — `EMPTY`, `of(fallback)`, or `throwError(() => err)`.
- Catch close to the source; rethrowing up the chain loses context.
- Don't swallow with `catchError(() => EMPTY)` unless that's genuinely the behavior you want — log at minimum.
- Resources capture errors in `error()` / `status()`; render that state rather than wrapping the loader in try/catch.

## 9. Reject these patterns

- **Nested subscriptions** — flatten with the right higher-order operator.
- **`.toPromise()`** — use `firstValueFrom()` / `lastValueFrom()`.
- **`subscribe` → `signal.set` → `computed`** chains that rebuild what a resource gives you (loading/error/cancellation) by hand.
- **`effect()` that calls `HttpClient` and writes the result to a signal** — use a resource.
- **Subjects as public API** — expose a signal (`.asReadonly()`) or `asObservable()` so consumers can't push into your state.
