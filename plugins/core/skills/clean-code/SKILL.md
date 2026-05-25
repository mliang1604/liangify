---
name: clean-code
description: Apply Robert C. Martin's Clean Code principles when authoring, refactoring, or reviewing production code. Covers naming, function design, error handling, classes, tests, and SOLID. Use when writing non-trivial code, restructuring existing code, or performing code review.
---

# Clean Code (Robert C. Martin)

A working checklist for writing code that reads like well-written prose. These are heuristics, not laws — when the project's existing style or an explicit user instruction contradicts a rule here, follow the project.

## 1. Names

- **Reveal intent.** A name should answer *why it exists, what it does, how it's used*. `int d; // elapsed days` is wrong; `int elapsedDays` is right.
- **Avoid disinformation.** Don't call something `accountList` unless it's a `List`. Don't use names that vary in small ways (`XYZControllerForEfficientHandling` vs `XYZControllerForEfficientStorage`).
- **Make distinctions meaningful.** `a1, a2, a3` and `ProductInfo` vs `ProductData` carry no real distinction.
- **Use pronounceable, searchable names.** Single-letter names are fine only for short-lived locals (loop counter `i`).
- **Classes are nouns, methods are verbs.** `Customer`, `Account`, `AddressParser`; `save()`, `deletePage()`, `isPosted()`.
- **One word per concept.** Pick `fetch` or `get` or `retrieve` and stick with it across the codebase.

## 2. Functions

- **Small.** Aim for under ~20 lines. If a function doesn't fit on a screen, it's probably doing too much.
- **Do one thing.** One thing = one level of abstraction below the function's name. If you can extract a meaningfully-named helper, the original was doing more than one thing.
- **One level of abstraction per function.** Don't mix high-level policy with low-level string parsing in the same body.
- **Few arguments.** 0 is best, 1–2 fine, 3 needs justification, 4+ almost always wrong. Bundle related args into an object.
- **No flag arguments.** `render(true)` is opaque — split into `renderForSuite()` and `renderForSingleTest()`.
- **No side effects.** A function named `checkPassword` that also initializes the session is a lie. Either rename it or split it.
- **Command/Query Separation.** A function either *does* something or *answers* something — never both.
- **Prefer exceptions to error codes.** Error codes force the caller to handle the error immediately, polluting the call site.

## 3. Comments

Comments are a failure to express intent in code. Refactor before commenting. Acceptable comments:

- **Legal** (copyright, license headers).
- **Informative** that can't be expressed in code (e.g., regex intent, format spec reference).
- **Explanation of intent** — *why* a non-obvious choice was made.
- **Warning of consequences** (`// Don't run on Friday — batch job collides`).
- **TODO** with owner/ticket.
- **Public API docs.**

Reject: redundant comments restating the code, misleading or stale comments, commented-out code (delete it; git remembers), banner/section markers, attribution (git blame exists), closing-brace labels.

## 4. Formatting

- **Vertical openness** between concepts; **vertical density** within them.
- **Related functions close together** — a caller above its callee, top-down newspaper structure.
- **Declare variables near their use,** not at the top of a long function.
- **Short lines** (~100–120 chars). Don't horizontally align assignments — alignment masks structure when it drifts.

## 5. Objects and Data Structures

- **Hide internal structure.** Expose behavior, not fields. `account.getBalance()` is fine if `Account` *is* a behavior; if it's a DTO, expose the field directly.
- **Objects expose behavior, hide data; data structures expose data, have no significant behavior.** Don't make hybrids.
- **Law of Demeter.** A method should only call methods on: itself, its parameters, objects it creates, its direct fields. `a.getB().getC().doSomething()` is a "train wreck" — refactor.

## 6. Error Handling

- **Exceptions over return codes.**
- **Write the try/catch first** so the rest of the code runs in a defined post-condition.
- **Provide context** in the exception message — what was being attempted, what input.
- **Wrap third-party exceptions** at the boundary into your own type.
- **Don't return null.** Return empty collections, `Optional`, or throw. `null` callers forget to check.
- **Don't pass null** into methods unless the API explicitly takes it.

## 7. Boundaries (Third-Party Code)

- **Wrap external libraries** behind an interface you own — limits blast radius when the library changes or gets replaced.
- **Write learning tests** to pin down third-party behavior you depend on; they alert you when an upgrade changes semantics.

## 8. Tests

- **F.I.R.S.T.** — Fast, Independent (no shared state), Repeatable (any env), Self-validating (boolean pass/fail, no manual reading), Timely (written just before / with the production code).
- **One assert per test** when practical; certainly one concept per test.
- **AAA structure** — Arrange, Act, Assert — visually separated.
- **Test code is production code.** It rots if you neglect it, and it's your safety net for refactoring.
- **Test names describe the scenario and expected outcome** — `withdraw_overdraft_throwsInsufficientFunds`.

## 9. Classes

- **Small** — measured by responsibilities, not lines. A class name should describe its responsibility in a sentence without "and" or "or."
- **Single Responsibility Principle.** One reason to change.
- **High cohesion** — most methods use most fields. Low cohesion is a signal to split the class.
- **Organize for change.** Isolate the part that varies behind an abstraction so the rest doesn't change with it.

## 10. SOLID

| | Principle | One-liner |
|---|---|---|
| **S** | Single Responsibility | One reason to change. |
| **O** | Open/Closed | Open for extension, closed for modification — add new behavior without editing existing code. |
| **L** | Liskov Substitution | Subtypes must be usable wherever their base type is, without surprising the caller. |
| **I** | Interface Segregation | Many small, client-specific interfaces beat one fat one. |
| **D** | Dependency Inversion | Depend on abstractions, not concretions. High-level policy shouldn't import low-level detail. |

## 11. Smells & Heuristics

- **Duplication is the root of evil.** Every duplicate is a missed abstraction.
- **Boy Scout Rule.** Leave the code cleaner than you found it — even a small rename counts.
- **Dead code rots.** Delete unused functions, parameters, branches. Version control is the archive.
- **Feature envy** — a method that calls many methods on another object probably belongs *on* that object.
- **God classes / long parameter lists / long methods** are all the same smell: too much in one place.

## How to apply this in review

When reviewing or refactoring, walk the list top-down: names → functions → error handling → classes. Most real code wins are at the function level (size, single purpose, argument count). Resist the urge to introduce abstractions purely on principle — *demonstrate* the duplication or change-axis that justifies the abstraction. SOLID is a lens for *existing* pain, not a license to pre-engineer.
