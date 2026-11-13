---
name: code-review
description: How to review code — what to check in priority order (correctness, security, data safety, design, tests, readability), how to phrase comments with clear severity, review scope, and when to approve. Use when reviewing a pull request, a diff, or someone's code, or when self-reviewing before requesting review.
---

# Code Review

A review exists to catch problems that would cost more to fix later, and to spread knowledge of the code. It is not a style contest. Spend attention in proportion to risk.

## 1. Before reading the diff

- **Read the PR description and linked issue.** Know what the change is *supposed* to do; you can't judge correctness otherwise. If the purpose isn't stated, ask for it before reviewing.
- **Check the size.** If it's too big to review carefully, say so and suggest a split — a skimmed approval is worse than none.
- **Check CI.** Don't spend human attention on what a failing build already reports.

## 2. Review priorities (highest first)

Work down this list. A PR with a correctness problem doesn't need naming feedback yet.

1. **Correctness.** Does it do what it claims, for all inputs? Look at edge cases: empty, null/undefined, zero, negative, very large, unicode, concurrent calls, partial failure, retries, time zones, off-by-one, ordering assumptions. Does it handle the error paths, not just the happy path?
2. **Security and data safety.** Untrusted input validated at the boundary; no injection (SQL, shell, path traversal, HTML); authorization checked, not just authentication; no secrets in code or logs; **no personal or patient data in logs, errors, fixtures or commits**; safe defaults.
3. **Data integrity and irreversible effects.** Migrations reversible or explicitly one-way; no silent data loss; destructive operations guarded; idempotency where retries can happen.
4. **Design.** Does the change fit the existing architecture, or fight it? Is the responsibility in the right place? Is there a simpler approach? Does it add a dependency, a public API or a config option that will be hard to remove? Apply [clean-code](../clean-code/SKILL.md) here — at the level of structure, not nitpicks.
5. **Tests.** Is the new behavior tested, including the edge cases from (1)? Would the tests fail if the code were broken? Are they testing behavior rather than implementation details? A bug fix should come with a test that reproduces the bug.
6. **Performance** — only where it matters: hot paths, unbounded loops or allocations, N+1 queries, loading whole files into memory, work on the UI thread.
7. **Readability and maintainability.** Names, structure, comments that explain *why*. Would the next person understand this without the PR open?
8. **Style.** Only what the formatter and linter don't already enforce. If you're commenting on style a tool could catch, the fix is a lint rule, not a comment.

## 3. Writing comments

- **Label severity** so the author knows what blocks merge:
  - **blocking:** must change before merge (bugs, security, data loss, broken contracts).
  - **suggestion:** would improve it; author decides.
  - **nit:** trivial, non-blocking. Use sparingly; batch them.
  - **question:** you don't understand something — may or may not need a change.
  - **praise:** call out what's done well. It tells the author what to keep doing.
- **Be specific and actionable.** Point at the line, say what's wrong, and why, and suggest a direction: "blocking: this runs before `load()` resolves, so `user` can be undefined here — await it or guard the access." Not "this looks off".
- **Critique the code, not the author.** "This function does three things" — not "you made this too complicated".
- **Ask when unsure** instead of asserting: "Can this be called concurrently? If so the cache write races."
- **Explain the principle once**, not on every occurrence: "nit (applies throughout): ..."
- **Offer code for small fixes** (a suggestion block); for larger ones, describe the approach and let the author write it.
- **Don't expand scope.** Issues that predate the PR or belong to other work: note them as a follow-up issue, don't block on them.

## 4. Deciding

- **Approve** when the change is correct, safe, and better than what was there — not when it's how you'd have written it. Approval with non-blocking suggestions is normal.
- **Request changes** only for blocking issues, and say which comments those are.
- **Re-review promptly.** Review latency is one of the biggest drags on a team; aim to respond within a working day.
- If a thread goes back and forth more than twice, move to a call and record the outcome in the PR.

## 5. Self-review (author side)

Before requesting review, read your own diff as a reviewer would:

- Walk the priority list above against your change.
- Remove debug output, commented-out code, unrelated reformatting and stray files.
- Make sure the description says what, why and how it was tested.
- Leave comments on your own PR where a reviewer will likely ask "why?" — or better, put that explanation in a code comment or the commit message.

## 6. Reviewing AI-generated changes

Apply the same bar, with extra attention to:

- **Plausible-but-wrong APIs** — functions, options or flags that don't exist in the version the project uses. Check them.
- **Over-broad changes** — edits outside the stated scope, reformatted files, "while I was here" refactors.
- **Tests that test the mock** rather than the behavior, or that were adjusted to pass.
- **Confident comments** that describe what the code was meant to do rather than what it does.
