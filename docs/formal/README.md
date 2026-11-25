# INF-18 acceptance model

`Inf18.tla` models the changed admission, idle-stop and provider-error retry decisions. Invariants:

- An input uses steering at the next run boundary.
- An idle draft stop produces no reply.
- A retry requires an enabled policy, a supported error and no context overflow.
- Authentication rotation has three retries at 10/20/40 seconds; ordinary transient errors have five at 5/10/20/40/60 seconds.
- A restart preserves the attempt and deadline (the model's stuttering crash).

Run `tlc -workers 1 -config docs/formal/Inf18.cfg docs/formal/Inf18.tla` from the repository root with Java and
tla2tools available. The green configuration has 160 distinct states. For negative checks, replace `Mutant = "none"`
in a copy of the configuration with each of `disabled`, `overflow`, `budget`, `delay`, `followUp`, `idle_reply`;
each must violate an invariant. The model abstracts provider classification and durable storage internals.

Code correspondence: `test/integration/delivery.test.ts` exercises steering during a tool round;
`test/integration/rich.test.ts` covers idle/active draft stop; `test/property/settings.test.ts` checks the upstream
delay calculation; `test/integration/auth-retry.test.ts` checks real generation checkpoints and budgets across
SQLite reopens, successful rotation and stopping a sleeping retry. `test/example/install.test.ts` packs and installs
the package in a clean npm project, checks all four fixes, idempotence and rejection of an unexpected upstream file.

## Background helpers

`BackgroundHelpers.tla` models two launches, independent completion, parent stop and replay after restart. A parent
can finish with helpers still working. Stopping that parent preserves the helpers. A launch receipt prevents a
duplicate start. Each terminal outcome commits with one report admission.

Run `tlc -workers 1 -config docs/formal/BackgroundHelpers.cfg docs/formal/BackgroundHelpers.tla`. With each of `wait`,
`cascade`, `duplicate` and `lost-report` in place of `none`, TLC should report an invariant violation.
`test/integration/helpers.test.ts` checks the launch and wake path against SQLite and exercises stop, restart, abort and
provider failure using a fake model and Telegram port. The model treats the database commits as atomic and abstracts
the transport from input admission to answer delivery.
