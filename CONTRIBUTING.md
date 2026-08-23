# Contributing

Changes should preserve the plugin's central boundary: models and skills may propose work, but only deterministic evidence providers may authorize completion.

Before opening a pull request:

```sh
npm ci
npm run check
```

For changes to runtime behavior:

- add failure-path and adversarial tests;
- keep model-authored values out of executable command selection;
- use Harness capability seams instead of direct child-process or workspace filesystem access;
- avoid persisting raw command output, credentials, or sensitive file contents;
- update the benchmark manifest when adding a new reliability failure class;
- install and boot the exact tarball in a clean Harness profile following [docs/SMOKE_TEST.md](docs/SMOKE_TEST.md).

Do not run the provider-backed live benchmark in CI. It requires an explicit cost decision and must never receive repository secrets from an untrusted pull request.
