## Commits

Commit your own work. Pushing is the user's: keep every commit local.

- **When:** commit at hand-back, when the part you were asked to do is finished and you are waiting for the user's next instruction. Until then, leave your changes uncommitted.
- **Split:** make one commit per role or feature, for example the data model, the UI that uses it, and the config change. A small adjustment folds into the commit it belongs to (see below). Only a hotfix gets a small commit of its own.

### Pending and closed commits

A commit is **pending** when you made it in this session and it is not pushed. Every other commit is **closed**: pushed commits, and every commit the user made. The user commits under the same author name, between your commits, and pushes whenever they want the work to stop changing, often mid-session.

When the user's next instruction fixes or tweaks work you committed, **fold** the fix into that commit, so the history shows the finished feature rather than each attempt. The scope test: would the fix fit under that commit's message? New work gets its own commit on top.

A fold rewrites the target commit and every commit after it (`git commit --amend`, `git commit --fixup` with `git rebase --autosquash`, any `git rebase`, `git reset` across commits). Before each one:

1. Run `git fetch`, then `git log --oneline @{u}..HEAD`. If the branch has no upstream, use `git log --oneline origin/<branch>..HEAD`; if `git remote -v` prints nothing, nothing is pushed.
2. Fold when the target and every commit after it are pending: listed by step 1 and made by you in this session. Otherwise commit the fix on top.

The check counts only when its list comes from step 1 run for this fold. An earlier check, a memory or a note is stale as soon as the user pushes.
