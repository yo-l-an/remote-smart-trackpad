## Commits

Commit your own work. The user does the pushing.

- **When:** commit at hand-back, when the part you were asked to do is finished and you are waiting for the user's next instruction. Until then, leave your changes uncommitted.
- **Split:** make one commit per role or feature, for example the data model, the UI that uses it, and the config change. A small adjustment goes into the commit it belongs to. Only a hotfix gets a small commit of its own.
- **Push:** keep every commit local. Never run `git push`.

### Pending commits

A commit is _pending_ until it has been pushed (`git log @{u}..` lists them). You may rewrite pending commits.

When the user's next instruction fixes or tweaks the work you just committed, fold the fix into those pending commits instead of adding one on top. Verify with `git fetch` and `git log @{u}..`, then use `git commit --amend`, or `git reset --soft` and recommit. The history should show the finished feature, not each attempt it took to get there.

The test for same scope: would the fix fit under the original commit's message? If yes, rewrite. If the instruction moves to new work, leave the pending commits as they are and commit on top.
