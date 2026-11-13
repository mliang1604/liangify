---
name: angular-testing
description: Angular 22 component and service testing with Vitest (via `ng test` / `@angular/build:unit-test`) in zoneless apps — prefer direct instantiation over TestBed, `vi.fn()`/`vi.spyOn()` mocks, `whenStable()` instead of `fakeAsync`, Vitest fake timers, testing signals and effects, component harnesses, HTTP mocking, coverage, and what not to test. Use when writing or reviewing `.spec.ts` files.
---

# Angular Testing

Test what *the user or caller observes*, not implementation. Refactor-resistant tests focus on inputs and rendered output; brittle tests assert on internal method calls.

Baseline: **Angular 22, zoneless, Vitest.** If a project still runs Karma + Jasmine, see §12 for the migration path rather than writing new Jasmine-style specs.

## 1. Stack

- **Runner: Vitest**, driven by `ng test` through the `@angular/build:unit-test` builder. This is the CLI default for new projects; don't wire up Vitest by hand or through a third-party builder.
- **DOM: jsdom** (default; `happy-dom` is the other supported option). Tests run in Node, not a browser. Use the `browsers` option (with a Playwright or WebdriverIO provider) only for tests that genuinely need real layout or browser APIs.
- **Zoneless:** no `zone.js` in the test polyfills. Change detection in tests is driven by signals, `setInput`, events and `fixture.whenStable()` — the same notifications that drive it in the app.
- **Globals:** the CLI provides `describe` / `it` / `expect` / `vi`. Import types (`Mock`, `Mocked`) from `vitest` when you need them.

```json
// angular.json
"test": {
  "builder": "@angular/build:unit-test",
  "options": {
    "providersFile": "src/test-providers.ts",   // global providers, e.g. provideHttpClientTesting()
    "coverageReporters": ["html", "text-summary", "cobertura"]
  }
}
```

- **Configuration lives in `angular.json`** (`include`, `exclude`, `setupFiles`, `providersFile`, `coverage*`, `reporters`). Reach for `runnerConfig` (a custom `vitest.config.ts`) only for things the builder doesn't expose; the CLI overrides `test.include` and `test.projects` regardless.
- **CI:** `ng test --no-watch --coverage`. Most CI servers set `CI=true`, which already implies single-run mode.

### Coverage

Requires `@vitest/coverage-v8` as a dev dependency. **Cobertura XML** stays the canonical CI-consumable format — most CI systems (Azure DevOps, GitLab, Jenkins, SonarQube) parse it for per-file PR coverage. Set it with `coverageReporters` (above); enforce floors with `coverageThresholds`:

```json
"coverage": true,
"coverageThresholds": { "statements": 80, "branches": 75, "functions": 80, "lines": 80 }
```

For a JUnit test report alongside it: `"reporters": ["default", ["junit", { "outputFile": "test-results/junit.xml" }]]`.

## 2. Prefer direct instantiation over TestBed

TestBed is slower and more ceremonial. Skip it whenever you can — most service and pure-logic tests don't need it. Reach for it only when you genuinely need Angular's injector, change detection, or template rendering.

### When to skip TestBed entirely

- **Pure functions, pipes, validators, mappers, reducers** — just call them.
- **Plain classes with constructor parameters** — `new PriceCalculator(rates)`. Fast and obvious.
- **Pure-logic classes** that don't touch the DOM, framework lifecycle, or `inject()`.

```ts
describe('PriceCalculator', () => {
  it('applies discount to subtotal', () => {
    const calc = new PriceCalculator();
    expect(calc.apply({ subtotal: 100, discountPct: 10 })).toBe(90);
  });
});
```

### When you need an injection context but not a component

Services that use `inject()` (including every `@Service()` class — it requires `inject()`) need an injection context. Register only the overrides the service resolves, then construct it:

```ts
describe('UserService', () => {
  it('forwards the id to the repository', async () => {
    const repo = { load: vi.fn().mockResolvedValue({ id: '1' }) };
    TestBed.configureTestingModule({ providers: [{ provide: UserRepository, useValue: repo }] });

    const service = TestBed.inject(UserService);
    await service.load('1');

    expect(repo.load).toHaveBeenCalledExactlyOnceWith('1');
  });
});
```

`TestBed.runInInjectionContext(() => ...)` is the tool for exercising a standalone function that calls `inject()` (guards, resolvers, `inject*` helper functions).

### When TestBed rendering is unavoidable

- **Components** — template rendering, change detection, host bindings, output emissions.
- **Directives that manipulate the host element** — same reason.
- **Routing**, and anything that depends on Angular's change-detection scheduling.
- **Code that injects `Renderer2`, `ElementRef`, `ViewContainerRef`.**

Trade-off with [angular-patterns](../angular-patterns/SKILL.md), which prefers `inject()`: pure-logic code with no Angular-API dependencies is easiest to test as a plain class or function, outside DI entirely. Keep the domain math there and let the `inject()`-based service be a thin shell around it.

## 3. TestBed minimal setup

```ts
beforeEach(async () => {
  await TestBed.configureTestingModule({
    imports: [UserCard],                  // standalone components go in imports
    providers: [
      { provide: UserService, useValue: { load: vi.fn() } },
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
    ],
  }).compileComponents();
});
```

- Standalone components go in `imports`, not `declarations`.
- `provideHttpClient()` + `provideHttpClientTesting()` + `HttpTestingController` for HTTP — never hit the real network. Put providers every spec needs into the `providersFile` rather than repeating them.
- `provideRouter([])` for components that inject `Router` or use router directives; use `RouterTestingHarness` to test navigation.

## 4. Mocks and spies

- **`vi.fn()`** — standalone mock function. Use as a callback or single-method stub. Control it with `.mockReturnValue()`, `.mockResolvedValue()`, `.mockImplementation()`.
- **Plain object of `vi.fn()`s** — a fake service. Type it so missing or misnamed methods fail to compile:

  ```ts
  import type { Mocked } from 'vitest';

  const users: Mocked<Pick<UserService, 'load'>> = { load: vi.fn() };
  users.load.mockReturnValue(of({ id: '1', name: 'Ada' }));
  // later
  expect(users.load).toHaveBeenCalledExactlyOnceWith('1');
  ```

- **`vi.spyOn(obj, 'method')`** — wrap a method on a real object while keeping the rest real. It calls through by default; chain `.mockReturnValue(...)` to stub.
- Reset between tests: create mocks fresh in `beforeEach`, or call `vi.restoreAllMocks()` in `afterEach` when you used `vi.spyOn` on shared objects.
- Prefer `vi.fn()` fakes passed through DI over `vi.mock('module')`. Module mocking is hoisted, global to the file, and couples the test to import paths.

## 5. Component harnesses

Prefer Angular CDK `ComponentHarness` APIs (Material's or your own) over direct DOM queries. They survive template refactors and work the same under Vitest.

```ts
const loader = TestbedHarnessEnvironment.loader(fixture);
const button = await loader.getHarness(MatButtonHarness.with({ text: 'Save' }));
await button.click();
```

Harness methods are async and wait for the fixture to stabilize, which also suits zoneless change detection. For non-Material code, write a thin harness per component rather than scattering `By.css('.some-class')` across specs.

## 6. Async and change detection without zones

`fakeAsync`, `tick`, `flush` and `waitForAsync` depend on Zone.js. Angular no longer recommends them, and they don't work in a zoneless test setup. Use native async plus Vitest fake timers.

- **`await fixture.whenStable()`** — the primary "let Angular catch up" call. It waits for pending change detection and pending tasks (including `resource` / `httpResource` loads that Angular tracks). `TestBed.createComponent` does **not** render synchronously, so await it before the first DOM assertion.
- **`fixture.detectChanges()`** still works for a synchronous render, but prefer `whenStable()`: it exercises the same scheduling path as the app and catches code that only works because a test forced change detection.
- **Never mutate a plain (non-signal) field and expect a re-render.** With OnPush and zoneless that won't update in the app either; the test failing is the correct signal to make the field a signal.

### Timers

```ts
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('debounces search', async () => {
  component.search('a');
  component.search('ab');

  await vi.advanceTimersByTimeAsync(300);
  await fixture.whenStable();

  expect(service.search).toHaveBeenCalledExactlyOnceWith('ab');
});
```

- Use the **`...Async` variants** (`advanceTimersByTimeAsync`, `runAllTimersAsync`, `runOnlyPendingTimersAsync`) so promise callbacks queued by the timers also run.
- Enable fake timers **before** creating the code under test, so its timers are captured. Restore real timers in `afterEach`.
- RxJS time operators (`debounceTime`, `delay`, `timer`) use the async scheduler, which Vitest fake timers control. Marble tests (`TestScheduler`) remain an option for complex stream timing.

## 7. Signals, effects and resources

```ts
// Inputs: set through the component ref, then let change detection run
fixture.componentRef.setInput('user', { id: '1', name: 'Ada' });
await fixture.whenStable();
expect(fixture.nativeElement.textContent).toContain('Ada');

// Computed signals: read directly
expect(component.displayName()).toBe('Ada');
```

- **Signals in services** are plain values — set the source, read the derived signal. No TestBed needed for a `computed` inside a plain class.
- **Effects run asynchronously** as part of change detection. After changing a signal an effect depends on, call `TestBed.tick()` (outside a component) or `await fixture.whenStable()` (with a component) before asserting on its side effect.
- **Resources:** trigger a param change, then `await fixture.whenStable()` (or `await TestBed.inject(ApplicationRef).whenStable()` without a fixture) and assert on `value()`, `status()` or `error()`. For `httpResource`, flush the request with `HttpTestingController` first.
- **Signal bindings at creation:** `TestBed.createComponent(Cmp, { bindings: [inputBinding('value', valueSignal), outputBinding('changed', spy)] })` binds a live signal to an input — useful for testing how a component reacts to a parent changing it over time.

## 8. Observables in tests

- For simple cases, `await firstValueFrom(obs$)` (or `lastValueFrom` for completing streams) is cleanest.
- For complex timing, use Vitest fake timers (§6) or marble tests (`TestScheduler`).
- Never assert inside a `subscribe` callback without awaiting completion — if the callback never runs, the test passes silently. Vitest has no `done` callback; convert to a promise instead.

## 9. HTTP testing

```ts
const http = TestBed.inject(HttpTestingController);
const result = firstValueFrom(service.load(1));

const req = http.expectOne('/api/users/1');
expect(req.request.method).toBe('GET');
req.flush({ id: 1, name: 'Ada' });

expect(await result).toEqual({ id: 1, name: 'Ada' });
http.verify(); // in afterEach
```

Fetch is the default `HttpClient` backend in Angular 22; `provideHttpClientTesting()` replaces whichever backend is configured, so tests don't change.

## 10. What NOT to test

- **Framework behavior** (Angular's change detection, RxJS operators) — already tested upstream.
- **Trivial getters / one-line passthroughs** — change-detector noise.
- **Private methods directly** — exercise them through the public API.
- **Implementation details** — CSS class names that aren't part of the contract, exact call counts on internal services, the order of internal method calls.

## 11. Spec hygiene

- One `describe` per unit; one `it` per behavior.
- Test names describe behavior: `it('navigates to login when a logged-out user clicks Profile')`, or `<context>_<action>_<expectedOutcome>` if the project already uses that style. Be consistent within a repo.
- Arrange / Act / Assert visually separated by blank lines.
- Fresh mocks in `beforeEach`; no shared mutable state in `beforeAll`.
- Use `toHaveBeenCalledExactlyOnceWith` when both "once" and "with these arguments" matter; `toHaveBeenCalledWith` alone passes on any matching call.
- If a test needs many lines of setup, the unit under test is probably doing too much — fix the design, not the spec.

## 12. Migrating legacy Karma / Jasmine specs

When you meet an older project:

- `ng g @schematics/angular:migrate-karma-to-vitest` migrates the test target; `ng g @schematics/angular:refactor-jasmine-vitest` rewrites specs (`--fake-async` converts `fakeAsync`/`tick` to Vitest fake timers). Review the diff — conversions are mechanical.
- Rough mapping: `jasmine.createSpy` → `vi.fn()`; `jasmine.createSpyObj('X', ['a'])` → `{ a: vi.fn() }`; `spyOn(o, 'm').and.returnValue(v)` → `vi.spyOn(o, 'm').mockReturnValue(v)`; `.and.callFake(f)` → `.mockImplementation(f)`; `toHaveBeenCalledOnceWith` → `toHaveBeenCalledExactlyOnceWith`; `spy.calls.reset()` → `spy.mockClear()`.
- `fakeAsync`/`tick` → `vi.useFakeTimers()` + `await vi.advanceTimersByTimeAsync(ms)` + `await fixture.whenStable()`.
- If a project must keep `fakeAsync` temporarily, it can run under Vitest with Zone.js by adding `zone.js/plugins/vitest-patch` to the test polyfills. Treat that as a bridge, not a target — it doesn't reflect how a zoneless app behaves.
- Don't hand-port many specs one at a time when the schematic can do it; do hand-review async tests, which are where the conversion most often changes meaning.
