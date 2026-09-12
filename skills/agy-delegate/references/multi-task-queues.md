# Multi-task queues

The single-task loop scales to a queue, and that is where delegation pays off most - a removal split
across layers, a migration touching many files, a refactor sweep. The discipline that makes a queue
trustworthy is sequencing and bookkeeping, not parallelism.

## Run sequentially, one commit per task

Run tasks **one at a time, in dependency order**, landing each (review + gates + commit) before
dispatching the next. Three reasons:

- **Later tasks assume earlier ones landed.** Task 3's brief can say "the X added in the previous step
  exists" only if the previous step actually committed.
- **One commit per task** keeps the history reviewable and any single step revertible.
- **Each review is honest.** A clean working tree before each dispatch means the next task's
  `git status` shows only _its_ changes.

Parallelism is occasionally worth it for genuinely independent tasks on separate files, but it
sacrifices the clean-tree-per-task property and makes review harder. Default to sequential.

## `delegate_many` is for research, not for a write queue

`delegate_many(tasks: [...])` fans several prompts out at once, queued behind `AGY_MAX_CONCURRENCY`
(default 2). That is the right tool for independent **read-only** work - surveying several modules,
gathering facts for a plan, or `prompt` + `models` for a council with a disagreement report on one
design question.

It is the wrong tool for an implementation queue. It exposes no `write` flag, and concurrent writers
in one tree destroy the clean-tree-per-task property that makes each review honest. Land write tasks
one `delegate(write: true)` at a time.

## Carry decided constraints forward

Implementation surfaces facts the original plan did not have: a helper got named, a fixture lives in a
specific place, an interface was chosen. When a later task depends on one of those, fold it into that
task's brief as an explicit line. A fresh Antigravity conversation has no memory of the earlier run, so
a constraint that emerged in task 2 must be restated in task 5's brief or it will not hold. The one
exception is a `follow_up` on the same `session_id`, which keeps that run's context - but that is a
rework of one task, not the next task in the queue.

Check `agy_status` before a long queue. It shows quota cooldowns and tokens spent, which is how you
find out a chain is about to fail over before the queue is halfway through.

## Keep a progress file

For anything longer than two or three tasks - especially a run the human steps away from - maintain a
single progress file alongside the work:

- **Status table** - each task: queued / at-implementer / reviewed+committed (with the commit hash
  and the agy `session_id`, so a late rework can still resume the right conversation).
- **Per-task review notes** - what landed, what you verified, the gate outcome.
- **Needs your eyes** - design decisions Antigravity made, non-blocking nitpicks, anything you want the
  human to overrule or confirm.
- **End-of-run checklist** - what happens after the last task.

Update it as each task lands, not in a batch at the end.

## Close with a coherence check

Per-task review proves each step in isolation; it does not prove the steps cohere. After the last task,
verify the whole:

- Run the full test/build once more on the final tree.
- Do a repo-wide check for the thing the queue was about.
- For schema work, replay all the new migrations from a clean state and check for drift.
- Then push and open or update the PR, with a description that reflects what actually shipped.

## When to stop and ask

Proceed without asking on anything that follows from the agreed plan. Stop and surface when:

- A task cannot be completed correctly within its brief's scope.
- A review finds something that calls the _plan_ into question, not just the implementation.
- The gates reveal a problem that affects tasks already done.

Then report where you are, what is committed, and what the open question is - and wait.
