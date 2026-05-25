---
name: typescript-style
description: TypeScript language best practices — strict typing, avoiding `any`, type narrowing, discriminated unions, `readonly`/`as const`, exhaustiveness checks, branded types, and when to reach for generics vs overloads. Use when writing or reviewing `.ts`/`.tsx` files.
---

# TypeScript Style

Assumes `strict: true` in `tsconfig.json` (and ideally `noUncheckedIndexedAccess: true` if the codebase can handle it). Everything below assumes strict mode is on — if it isn't, fixing that comes first.

## 1. Avoid `any`; prefer `unknown`

`any` opts out of type checking silently. `unknown` keeps the value typed but forces narrowing at the use site.

```ts
// Bad
function parse(input: any) { return input.name; }

// Good
function parse(input: unknown): string {
  if (typeof input === "object" && input !== null && "name" in input) {
    return String((input as { name: unknown }).name);
  }
  throw new Error("invalid input");
}
```

If you must use `any`, leave a comment explaining why (third-party untyped library, escape hatch for a known compiler bug).

## 2. Discriminated unions for multi-shape state

When a value has multiple valid shapes, model it as a tagged union — not optional fields that callers have to cross-check.

```ts
// Bad — every consumer re-derives which fields are valid
type Result = { loading: boolean; data?: User; error?: Error };

// Good — exactly one shape is valid at any time
type Result =
  | { kind: "loading" }
  | { kind: "success"; data: User }
  | { kind: "error"; error: Error };
```

## 3. Exhaustiveness with `never`

In switches over discriminated unions, use a `never` assignment so adding a new variant becomes a compile error.

```ts
function render(r: Result): string {
  switch (r.kind) {
    case "loading": return "...";
    case "success": return r.data.name;
    case "error":   return r.error.message;
    default: {
      const _exhaustive: never = r;
      return _exhaustive;
    }
  }
}
```

## 4. `readonly` and `as const`

- `readonly` on properties prevents mutation through that reference — default to it for DTOs and data classes.
- `as const` freezes literal types — ideal for constants, action types, config maps.

```ts
const ROLES = ["admin", "editor", "viewer"] as const;
type Role = typeof ROLES[number];  // "admin" | "editor" | "viewer"
```

## 5. Branded types for IDs

Prevent passing a `UserId` where an `OrderId` is expected. Costs nothing at runtime.

```ts
type Brand<T, B> = T & { readonly __brand: B };
type UserId  = Brand<string, "UserId">;
type OrderId = Brand<string, "OrderId">;
```

## 6. Type narrowing > type assertion

`as` is a lie to the compiler. Reach for it only when narrowing genuinely can't work.

```ts
// Prefer
if (x instanceof Error)        { /* x: Error */ }
if (typeof x === "string")     { /* x: string */ }
if ("id" in x)                 { /* x has id */ }

// Last resort
const el = document.getElementById("x") as HTMLInputElement;

// Better
const el = document.getElementById("x");
if (!(el instanceof HTMLInputElement)) throw new Error("missing input");
```

## 7. Generics vs overloads

- **Generics** when the input/output type relationship is uniform.
- **Overloads** when distinct input shapes have distinct output shapes.

```ts
// Generic
function identity<T>(x: T): T { return x; }

// Overload
function get(key: "name"): string;
function get(key: "age"):  number;
function get(key: string): string | number { /* ... */ }
```

## 8. Miscellaneous

- **`interface` for object shapes** that may be extended; **`type` for unions, primitives, mapped types.** Both work — consistency in a codebase matters more than the choice.
- **`Record<K, V>`** beats `{ [k: string]: V }` for readability.
- **Don't `export default`** in app code — named exports refactor better and have one canonical name.
- **Don't suppress with `// @ts-ignore`** — use `// @ts-expect-error` so the suppression itself errors when the underlying issue is fixed.
- **Type-only imports** (`import type { ... }`) keep build output cleaner and avoid runtime circular-dep issues.
- **`satisfies` over annotation** when you want literal types preserved but checked against a wider type:
  ```ts
  const config = { host: "localhost", port: 8080 } satisfies ServerConfig;
  // config.host is "localhost", not string
  ```
