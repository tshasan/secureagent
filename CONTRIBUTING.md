# Contributing

Thanks for your interest. This is a small research harness for comparing
prompt-injection defenses at the architecture level. The most useful
contributions are new defenses, new attacks, and better scoring oracles.

## Getting set up

Two supported environments (see the README for the full rundown).

Bun-native — install [Bun](https://bun.sh) and [Ollama](https://ollama.com):

```
bun install
bun run bench      # starts ollama if needed, then runs the default sweep
```

Nix flake:

```
nix develop        # starts ollama in the background, drops you in a shell
bun install
bun run run        # runs the benchmark against the default sweep
```

Before opening a PR:

```
bun run typecheck   # tsc --noEmit, must pass clean
nix flake check     # same check, hermetic (if you have Nix)
```

## Adding a defense

A defense is a `Transform` (see `src/pipeline.ts`): a set of optional hooks
that rewrite the system prompt, the tool schemas, the user input, or validate
tool calls before they execute. To add one:

1. Create a file under `src/defenses/` exporting a `Transform` (or a factory
   returning one, if it needs per-run state like `capabilityHandles`).
2. Register it as a preset in the `PRESETS` array in `src/main.ts`.
3. Document it in the README under "Defenses in this version".

Keep each defense self-contained and independently toggleable. The point of
the harness is to compare patterns in isolation and in combination, so a
defense should not assume any other defense is present.

## Adding attacks

Attacks live in `data/attacks.json`. Each one declares a `forbidden` pattern
that defines what "injection succeeded" means for that attack (see
`src/scoring.ts` and the `ForbiddenPattern` type in `src/types.ts`). Use
reserved example domains (`*.example`) for any attacker-controlled addresses
so the data never points at a real target.

## Determinism

Runs must stay reproducible: the same model on the same machine should produce
identical verdicts and tool-call values per `(config, attack)`. If you add
code that calls the model, use `deterministicSampling()` from `src/sampling.ts`
and avoid randomness (no `Math.random`, no time-based IDs, no unstable
ordering) in anything that feeds the model's context. The README's
"Determinism" section explains why.

## Commits

One logical change per commit. Keep unrelated changes in separate commits so
each one is easy to review, revert, and `git bisect`.

Write messages in the [Conventional Commits](https://www.conventionalcommits.org)
format:

```
<type>: <summary>
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`. For example:

```
feat: add URL-reference defense
fix: reject capability handles with trailing whitespace
docs: link research papers in the README
```

## Code style

- TypeScript, run on [Bun](https://bun.sh). `strict` mode is on with
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — keep it
  passing.
- Match the surrounding style: no default exports, explicit return types on
  exported functions, narrow types over `any`.
- Imports of local modules use the `.js` extension (TS `Bundler` resolution).

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license as the project. New source
files should carry the standard Apache header (copy it from any file in
`src/`).
