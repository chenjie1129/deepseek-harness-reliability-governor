# Reliability Governor v0.6.1

v0.6.1 restores durable Governor-session resume on DeepSeek Harness `0.1.2-alpha.1`.

## Why this patch is required

Harness `0.1.2-alpha.1` refuses to load persisted sessions containing event types outside its built-in catalog. Reliability Governor owns six required `reliability/*` event types, and the release does not yet expose a downstream registration service. v0.6.0 could therefore install and boot successfully while a later resume rejected the persisted session.

v0.6.1 registers the installed plugin's six required event types in Harness's exported process-wide catalog before it registers tools or lifecycle hooks. Older Harness builds expose no catalog and continue through the existing path. A future catalog that is present but cannot accept the vocabulary fails plugin load rather than allowing an unreadable session to be written.

The compatibility bridge should be replaced when Harness publishes an official out-of-tree event-registration API. Keep the Governor bundle installed whenever resuming sessions containing its events.

## Verification scope

- The complete keyless package check passes at the supported `0.1.1-rc.2` dependency floor.
- The unit/composition suite and strict build pass against the `0.1.2-alpha.1` source packages.
- The exact v0.6.1 tarball installs, composes, and boots in a clean `0.1.2-alpha.1` Web profile; the authenticated page declares the Governor client module and reports no browser-console module or renderer error.
- The persistence-catalog regression tests cover old-runtime no-op, current-runtime registration, incompatible-catalog failure, and silent-registration refusal.

These checks establish compatibility and mechanism behavior. They do not establish provider-backed improvement in natural-language task outcomes.
