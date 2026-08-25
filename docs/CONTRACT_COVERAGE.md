# Contract coverage and evidence sufficiency

Reliability Governor separates two decisions that are easy to confuse:

1. `reliability_assess` asks whether the **proposed contract** has enough evidence to judge every declared success claim.
2. `reliability_verify` later asks whether the **actual task output** passes those checks.

Neither decision uses an LLM judge.

## The plain-language rule

Use the smallest set of independent evidence sources that covers every success claim. One authoritative source is enough when it directly decides the claim. Ask for two or more only when the sources can fail in meaningfully different ways and corroboration is worth the extra rejection risk.

More checks are not automatically stronger evidence. For example, `file_exists` and `file_contains` against the same path are two checks but one source: that workspace file. Likewise, two assertions over one tool result are not independent.

“Independent” here is a conservative structural proxy, not a statistical guarantee. Lexically normalized paths and configured profile IDs are the identities available before execution. Symlink aliases, two profiles wrapping the same weak command, or correlated upstream systems can still make apparently distinct sources fail together; deployment review must catch those cases.

## What a claim declares

Each claim has:

- `statement`: what must be true;
- `importance`: `critical`, `important`, or `minor`;
- `verification`: `deterministic`, `human-required`, or `unsupported`;
- `check_ids`: which checks support it;
- optional `minimum_independent_sources`: the required number of distinct authorities, defaulting to `1`.

The report groups checks into these source classes:

| Check target | Evidence source identity |
| --- | --- |
| Workspace file checks | One source per path |
| Ordinary tool and trajectory checks | One conservative source for the Harness tool-event trajectory |
| Trusted code verification | One source per deployment profile |
| `no_tool_errors` | The post-contract tool trajectory |

## Ready versus review required

An assessment is `ready` only when at least one claim is critical and every declared claim is deterministic and reaches its required independent-source count. It becomes `review-required` when:

- no claim is marked critical;
- needs human judgment;
- has no supported oracle; or
- cites fewer independent sources than it requires.

Warnings do not block activation, but make likely false-rejection risks visible:

- exact-literal checks may reject equivalent output;
- `file_exists` proves presence, not correctness;
- `tool_succeeded` proves a reported tool outcome, not necessarily external state;
- `no_tool_errors` judges the trajectory and rejects recovered errors;
- an orphan check has no mapped claim;
- a shared check may be doing too much logical work.

The report includes critical and weighted coverage, used and orphan checks, distinct evidence-source counts, all findings, and a content receipt. The score is diagnostic; `status`, not a favorable percentage, controls activation.

## Example

```json
{
  "objective": "Create a configured application entry point",
  "claims": [
    {
      "id": "entry-configured",
      "statement": "src/index.ts exists and exports apply",
      "importance": "critical",
      "verification": "deterministic",
      "check_ids": ["entry", "export"],
      "minimum_independent_sources": 1
    },
    {
      "id": "trusted-tests-pass",
      "statement": "The deployment-approved unit test profile passes on the final workspace state",
      "importance": "critical",
      "verification": "deterministic",
      "check_ids": ["tests"]
    }
  ],
  "checks": [
    { "id": "entry", "kind": "file_exists", "path": "src/index.ts" },
    { "id": "export", "kind": "file_contains", "path": "src/index.ts", "text": "export function apply" },
    { "id": "tests", "kind": "code_verification_succeeded", "profile": "unit-tests" }
  ]
}
```

This has three checks but two independent sources: `src/index.ts` and the immutable `unit-tests` profile. The first claim intentionally needs only the file authority; the second has a separate test authority.

## The boundary the report cannot cross

Coverage applies only to **declared** claims. A model can omit a requirement or phrase a claim that does not faithfully represent the user's intent. Deterministic structure cannot solve that semantic problem.

For higher-impact work, use an independently authored claim set, compare it with the request before activation, and keep a human approval step when no reliable oracle exists. The live benchmark keeps separate model-authored and independently authored contract arms so this authorship cost is measured rather than assumed away.
