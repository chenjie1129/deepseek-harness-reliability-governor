# Beta feedback protocol

Reliability Governor is looking for counterexamples, not testimonials. The most valuable report is a small, reproducible case where the plugin certified incorrect work, rejected correct work, damaged correct work during repair, or failed to integrate with a supported Harness profile.

## Fifteen-minute trial

1. Use a disposable local workspace or a clean Git worktree. Do not test external, irreversible, financial, production, or credential-bearing actions.
2. Record the plugin version, DeepSeek Harness version or commit, operating system, profile, model, and relevant governor configuration.
3. Choose three to five tasks with an independently observable outcome. Prefer exact files, JSON values, trusted test profiles, or authoritative read-after-write evidence.
4. Run each task once with the governor. Do not change the task or contract after seeing the terminal outcome.
5. After the run, judge the resulting workspace independently of the governor. Record `oracle=pass` only if the requested outcome genuinely exists.
6. Read `reliability_status` or the durable session events and classify the result:

| Terminal result | `oracle=pass` | `oracle=fail` |
| --- | --- | --- |
| `certified` | true certification | **false certification** |
| `exhausted` | **false exhaustion** | true exhaustion |
| `abstained` | **false abstention** | true abstention |
| still active or missing contract | unresolved | unresolved failure |

7. File the matching GitHub issue form. Attach only redacted evidence.

The protocol is intentionally small. It is a product-feedback exercise, not a replacement for the pre-registered live benchmark in [docs/BENCHMARK.md](docs/BENCHMARK.md).

## Evidence to include

Copy this compact record into the issue form when useful:

```yaml
plugin_version: 0.3.0
harness_version_or_commit: ""
os: ""
profile: ""
model_and_provider: ""
task_summary: ""
contract_summary: ""
terminal: certified | exhausted | abstained | active | no_contract
oracle: pass | fail
failing_check_kinds_by_attempt: []
repair_changed_artifact: yes | no | unknown
reproduction: ""
```

For a false exhaustion, false abstention, or repair regression, include the **full failing-check set for every attempt**, not only the first check. If a repair changed an already-correct artifact, describe the state immediately before the failed check, after each repair, and at the terminal outcome.

## Privacy and safety

- Never include API keys, cookies, credentials, private keys, customer data, proprietary source, or raw private transcripts.
- Redact workspace paths and sensitive literals in contracts and reports.
- A reliability receipt is useful for correlation, but it is not a digital signature or independent proof.
- Reproduce mutating cases only in a disposable workspace. Do not retry unknown external side effects.
- Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not through a public beta issue.

## How reports affect the roadmap

Reports are triaged by failure class and check kind, with reproducibility and potential harm weighted above popularity:

1. false certification or repair-induced damage;
2. repeatable false exhaustion;
3. repeatable false abstention;
4. installation and Harness compatibility;
5. check-authoring friction and new check requests.

Ordinary semantic or usability changes should have either two independent reports or one repository-owned reproduction. A safety-critical false certification or damaging repair regression is sufficient to stop a release while it is investigated. Published changes should link back to the motivating redacted case in the changelog.

## What success looks like

The initial beta target is five to ten qualified Harness users and 25 to 50 local task runs. Stars and download counts are discovery signals, not evidence that the governor improves outcomes. The useful outputs are reproducible failure cases, per-check false-rejection patterns, compatibility data, and a clearer decision about contract authorship versus check semantics versus repair policy.
