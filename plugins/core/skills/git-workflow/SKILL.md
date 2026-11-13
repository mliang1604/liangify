---
name: git-workflow
description: Git workflow conventions — branch naming, commit message style, commit granularity, PR size and description, keeping history clean, and safe handling of shared branches. Use when creating branches, writing commits, preparing or splitting pull requests, or cleaning up history.
---

# Git Workflow

Conventions for work that ends in a pull request. When a repo documents its own conventions (`CONTRIBUTING.md`, `CLAUDE.md`, a commitlint config, existing history), **follow the repo** — these are the defaults when it says nothing.

## 1. Branches

- **Branch from the latest default branch** (`git fetch` first). Never commit directly to `main`/`master` or a release branch.
- **One branch per change.** A branch exists to become one PR; unrelated work gets its own branch.
- **Name: `<type>/<short-kebab-description>`**, optionally with an issue number:
  - `feat/rtstruct-import`, `fix/142-slice-ordering`, `docs/readme-install`, `refactor/extract-dose-grid`, `chore/bump-electron`, `test/registration-fixtures`.
  - Types match the commit types below. Keep it under ~50 characters; no personal names or dates.
- **Short-lived.** Rebase or merge the default branch in regularly; a branch that lives for weeks becomes a merge problem.

## 2. Commit messages

```
<type>(<optional scope>): <imperative summary, ≤ 72 chars, no period>

<body: what changed and WHY, wrapped at ~72 columns.
Explain the problem and the reasoning, not a line-by-line
replay of the diff.>

<trailers: Closes #123, Co-Authored-By: ..., BREAKING CHANGE: ...>
```

- **Imperative mood:** "Add RTDOSE grid scaling", not "Added" / "Adds" / "Adding".
- **Types (Conventional Commits):** `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`. Use a scope when it helps (`fix(reslice): ...`, `feat(pacs): ...`). If the repo's history doesn't use type prefixes, match the history instead.
- **The summary says what the commit does for a reader of `git log --oneline`.** "Fix bug" and "Updates" say nothing.
- **The body explains why.** The diff shows what; the message preserves the reasoning that will otherwise be lost — the bug's cause, the alternative you rejected, the constraint you were working around.
- **Breaking changes** get a `!` after the type (`feat(api)!: ...`) and a `BREAKING CHANGE:` trailer that says what callers must do.
- **Reference issues in trailers** (`Closes #42`, `Refs #17`) rather than only in the summary.

## 3. Commit granularity

- **Each commit builds and passes tests.** That keeps `git bisect` and reverts usable.
- **One logical change per commit.** A rename, a refactor and a behavior change are three commits, even if made in one sitting — reviewers can then skim the mechanical ones.
- **Separate formatting from logic.** A reformat mixed into a behavior change hides the behavior change.
- **Don't commit:** secrets or credentials, generated build output, local editor/IDE files, large binaries without LFS, personal data or real patient data, debugging leftovers (`console.log`, commented-out code).
- Stage deliberately (`git add -p`, or name files explicitly). `git add -A` only after checking `git status`.

## 4. Pull requests

- **Small.** Aim for a diff a reviewer can read carefully in one sitting — roughly under 400 changed lines of hand-written code. Generated files, lockfiles and pure moves don't count the same, but say so in the description.
- **One purpose per PR.** If the description needs "and also", split it. Common splits: preparatory refactor first, then the feature; schema/migration first, then the code that uses it.
- **Stack dependent PRs** when a large change must land in pieces: each PR branches from the previous one, says "depends on #N" in its description, and is merged in order.
- **Description:** what changed and why, how it was tested, anything the reviewer should look at first, risks and rollout notes, screenshots for UI changes, and the issue it closes (`Closes #N`).
- **Open as draft** while CI is red or the change is incomplete. Mark ready only when you'd be comfortable merging it.
- **Self-review the diff before requesting review.** Most "please remove this debug line" comments are avoidable.
- **Respond to every review comment** — with a change, or a reason. Push follow-up commits during review (easier to re-review than a force-push); squash on merge if the repo uses squash merges.

## 5. History hygiene

- **Rewrite only your own unshared history.** `rebase -i`, `commit --amend` and `reset` are fine on a branch only you push to. Once others have pulled it, add commits instead.
- **Never force-push a shared branch** (`main`, release branches, a teammate's branch). On your own PR branch, use `git push --force-with-lease`, never plain `--force`.
- **Prefer the repo's merge strategy.** Squash-merge keeps `main` one-commit-per-PR, so the PR title becomes the commit summary — write it like one.
- **Revert, don't rewrite, to undo something on `main`:** `git revert <sha>` with a message explaining why.
- **Resolve conflicts by understanding both sides**, not by picking "ours" or "theirs" wholesale. Re-run tests after resolving.

## 6. Before you push — checklist

- [ ] Branch is up to date with the default branch.
- [ ] Each commit has an imperative summary and a body that explains why (where the why isn't obvious).
- [ ] Build, lint and tests pass locally.
- [ ] No secrets, generated files or unrelated changes in the diff.
- [ ] The PR is one purpose and reviewable in one sitting.
