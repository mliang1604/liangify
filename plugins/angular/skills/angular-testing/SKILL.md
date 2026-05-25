---
name: angular-testing
description: Angular component and service testing with Jasmine + Karma — prefer direct instantiation over TestBed when possible, spies, component harnesses, fakeAsync/tick, signal/observable testing, HTTP mocking, Cobertura coverage, and what not to test. Use when writing or reviewing `.spec.ts` files.
---

# Angular Testing

Test what *the user or caller observes*, not implementation. Refactor-resistant tests focus on inputs and rendered output; brittle tests assert on internal method calls.

## 1. Stack

- **Test framework: Jasmine** (Angular's default). Don't migrate to Jest or Vitest without an explicit project-wide decision — the Angular CLI, schematics, and most Angular Material harness docs assume Jasmine + Karma.
- **Runner: Karma**, driven by `ng test`.
- **Coverage: Cobertura XML** as the canonical CI-consumable format. Configure in `karma.conf.js`:

  ```js
  coverageReporter: {
    dir: require('path').join(__dirname, './coverage'),
    subdir: '.',
    reporters: [
      { type: 'html' },         // local browsing
      { type: 'text-summary' }, // CLI summary
      { type: 'cobertura', file: 'cobertura-coverage.xml' },  // CI ingest
    ],
  }
  ```

  Most CI systems (Azure DevOps, GitLab, Jenkins, SonarQube) parse `cobertura-coverage.xml` to surface per-file coverage in PR views.

- Run with coverage: `ng test --code-coverage --watch=false --browsers=ChromeHeadless` in CI.

## 2. Prefer direct instantiation over TestBed

TestBed is slow and ceremonial. Skip it whenever you can — most service and pure-logic tests don't need it. Reach for it only when you genuinely need Angular's injector, change detection, or template rendering.

### When to skip TestBed entirely

- **Pure functions, pipes, validators, mappers, reducers** — just call them.
- **Services with constructor DI** — `new MyService(mockDep1, mockDep2)`. Fast and obvious.
- **Pure-logic classes** that don't touch the DOM, framework lifecycle, or `inject()`.

```ts
describe('PriceCalculator', () => {
  it('applies discount to subtotal', () => {
    const calc = new PriceCalculator();
    expect(calc.apply({ subtotal: 100, discountPct: 10 })).toBe(90);
  });
});

describe('UserService', () => {
  it('forwards the id to http', () => {
    const http = jasmine.createSpyObj<HttpClient>('HttpClient', ['get']);
    http.get.and.returnValue(of({ id: '1' }));

    const service = new UserService(http);  // constructor DI — no TestBed
    service.load('1').subscribe();

    expect(http.get).toHaveBeenCalledOnceWith('/api/users/1');
  });
});
```

### When you need an injection context but not full TestBed

Services using `inject()` in field initializers need an injection context — `new MyService()` won't work. Use `TestBed.runInInjectionContext`, which is lighter than `configureTestingModule`:

```ts
const service = TestBed.runInInjectionContext(() => new UserService());
```

You still need a minimal TestBed to register provider overrides for the things `inject()` resolves. This is the middle ground when you can't refactor away from `inject()`.

### When TestBed is unavoidable

- **Components** — template rendering, change detection, host bindings, output emissions.
- **Directives that manipulate the host element** — same reason.
- **Anything testing routing, change detection scheduling, or zone behavior.**
- **Code that uses `Renderer2`, `ElementRef`, `ViewContainerRef`** as injected dependencies.

Note: this creates tension with the [angular-patterns](../angular-patterns/SKILL.md) recommendation to use `inject()` everywhere. Honest trade-off — for **pure-logic services** with no Angular-API dependencies, constructor DI buys you trivially-testable code. Reserve `inject()` for places it actually pays off (`DestroyRef`, `PLATFORM_ID`, optional providers, components/directives).

## 3. TestBed minimal setup

When you do need TestBed:

```ts
beforeEach(async () => {
  await TestBed.configureTestingModule({
    imports: [UserCard],                  // standalone component goes in imports
    providers: [
      { provide: UserService, useValue: jasmine.createSpyObj('UserService', ['load']) },
      provideHttpClientTesting(),
      provideRouter([]),
    ],
  }).compileComponents();
});
```

- Standalone components go in `imports`, not `declarations`.
- Use `provideHttpClientTesting()` + `HttpTestingController` for HTTP — never hit the real network.
- Use `provideRouter([])` for components that inject `Router` or use router directives.

## 4. Spies

Jasmine has three spy patterns — pick the right one:

- **`jasmine.createSpy('name')`** — standalone spy function. Use as a callback or single-method stub.
- **`jasmine.createSpyObj('Name', ['method1', 'method2'])`** — fake object with multiple spied methods. Use to stub a whole service.
- **`spyOn(obj, 'method')`** — wrap an existing method on a real object. Use to assert on a method while keeping the rest of the class real. Chain `.and.returnValue(...)` / `.and.callFake(...)` / `.and.callThrough()` to control behavior.

```ts
const service = jasmine.createSpyObj<UserService>('UserService', ['load']);
service.load.and.returnValue(of({ id: '1', name: 'Ada' }));

// later
expect(service.load).toHaveBeenCalledOnceWith('1');
```

Use `jasmine.createSpyObj<T>(...)` with the generic to get type-checked spies.

## 5. Component harnesses

Prefer Angular Material's `ComponentHarness` API (or your own per-component harnesses) over direct DOM queries. They survive template refactors.

```ts
const harness = await TestbedHarnessEnvironment
  .loader(fixture)
  .getHarness(MatButtonHarness);
await harness.click();
```

For non-Material code, write a thin harness per component rather than scattering `By.css('.some-class')` across specs.

## 6. Async testing

- **`fakeAsync` + `tick()`** for deterministic time control — debounces, timers, animations.
- **`async`/`await fixture.whenStable()`** for promise-based async.
- **`flushMicrotasks()`** inside `fakeAsync` for microtask draining.

```ts
it('debounces search', fakeAsync(() => {
  component.search('a');
  component.search('ab');
  tick(300);
  expect(service.search).toHaveBeenCalledOnceWith('ab');
}));
```

## 7. Signals in tests

```ts
// Set input signals via the component ref
fixture.componentRef.setInput('user', { id: '1', name: 'Ada' });
fixture.detectChanges();

// Read computed signals directly
expect(component.displayName()).toBe('Ada');
```

## 8. Observables in tests

- For simple cases, `firstValueFrom(obs$)` + `await` is cleanest.
- For complex timing, use **marble tests** (`TestScheduler`).
- Avoid subscribe-and-expect-in-callback unless wrapped in `done` — failures swallow silently otherwise.

## 9. HTTP testing

```ts
const http = TestBed.inject(HttpTestingController);
service.load(1).subscribe(/* ... */);

const req = http.expectOne('/api/users/1');
expect(req.request.method).toBe('GET');
req.flush({ id: 1, name: 'Ada' });

http.verify();  // in afterEach
```

## 10. What NOT to test

- **Framework behavior** (Angular's CD, RxJS operators) — already tested upstream.
- **Trivial getters / one-line passthroughs** — change-detector noise.
- **Private methods directly** — exercise them through the public API.
- **Implementation details** — CSS class names that aren't part of the contract, exact call counts on internal services, the order of internal method calls.

## 11. Spec hygiene

- One `describe` per unit; one `it` per behavior.
- Test names: `<context>_<action>_<expectedOutcome>` — e.g. `whenLoggedOut_clickProfile_navigatesToLogin`.
- Arrange / Act / Assert visually separated by blank lines.
- Create spies fresh in `beforeEach` so each test starts clean. If you must share a spy across tests, reset with `(spy as jasmine.Spy).calls.reset()`.
- Avoid shared mutable state in `beforeAll` — use `beforeEach`.
- If a test needs many lines of setup, the unit under test is probably doing too much — fix the design, not the spec.
