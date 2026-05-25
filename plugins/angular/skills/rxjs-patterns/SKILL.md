---
name: rxjs-patterns
description: RxJS patterns for Angular — when to choose observables over signals, subscription lifecycle with `takeUntilDestroyed`, operator selection, common pitfalls, and signal/observable interop. Use when working with RxJS imports or async data flows.
---

# RxJS Patterns

In modern Angular (17+), prefer signals for state and RxJS for streams of events / async data sources. The two interop cleanly — pick the right tool, don't force everything into one.

## 1. When to use each

| Use **signals** for | Use **observables** for |
|---|---|
| Component state | HTTP responses |
| Computed/derived values | WebSockets, SSE |
| Form values (via `toSignal`) | User-input streams that need debounce/throttle |
| Anything driving the template | Long-lived event sources |

**Rule of thumb:** if you find yourself doing `.subscribe()` to push into a signal, you probably want `toSignal()` instead.

## 2. Bridge with `toSignal` / `toObservable`

```ts
// observable → signal (auto-unsubscribes in injection context)
user = toSignal(this.userService.user$, { initialValue: null });

// signal → observable (re-emits when the signal changes)
search$ = toObservable(this.query).pipe(
  debounceTime(300),
  switchMap(q => this.api.search(q)),
);
```

## 3. Subscription lifecycle

Never let a subscription outlive its consumer. Three correct patterns:

1. **`async` pipe in template** — Angular subscribes/unsubscribes for you.
2. **`takeUntilDestroyed()`** in injection context — modern, no `OnDestroy` boilerplate.
   ```ts
   private destroyRef = inject(DestroyRef);
   ngOnInit() {
     this.events$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(/* ... */);
   }
   ```
3. **`toSignal()`** — handles teardown automatically.

Reject in new code: manual `Subscription` arrays + `OnDestroy.unsubscribe()`.

## 4. Operator selection

Never default to `mergeMap` for inner observables. Pick the right semantic:

- **`switchMap`** — cancel previous, take latest. Right for search/autocomplete.
- **`concatMap`** — queue in order, no overlap. Right for save-on-change.
- **`exhaustMap`** — ignore while in-flight. Right for submit buttons.
- **`mergeMap`** — parallel, no ordering. Only when concurrency is the point.

## 5. Common operator pitfalls

- **`shareReplay({ bufferSize: 1, refCount: true })`** — share an expensive source. Without `refCount: true`, the source never unsubscribes.
- **`combineLatest`** doesn't emit until *every* source has emitted at least once — common bug. Use `startWith()` on optional sources.
- **`tap`** is for side effects only (logging, debugging) — never put business logic in it.
- **`distinctUntilChanged`** uses `===` by default — pass a comparator for objects.

## 6. Cold vs hot

- HTTP observables are **cold** — every `.subscribe()` triggers a new request. Use `shareReplay` to cache.
- `Subject` / `BehaviorSubject` are **hot** — late subscribers miss past emissions (except `BehaviorSubject`, which replays the last).

## 7. Error handling

- **`catchError`** must return an observable — `EMPTY`, `of(fallback)`, or `throwError(() => err)`.
- Catch close to the source; rethrowing up the chain loses context.
- Don't silently swallow with `catchError(() => EMPTY)` unless that's genuinely the right behavior — log at minimum.

## 8. Reject these patterns

- **Nested subscriptions** (`subscribe` inside `subscribe`) — flatten with `switchMap` / `mergeMap`.
- **`.toPromise()`** — removed in RxJS 8. Use `firstValueFrom()` / `lastValueFrom()`.
- **Storing the latest `BehaviorSubject` value in a parallel field** — that's what `.value` is for, but usually you should be using a signal instead.
- **Subjects as public API** — expose `asObservable()` so consumers can't `.next()` into your state.
