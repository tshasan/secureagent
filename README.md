# secureagent

A harness for testing prompt-injection defenses at the **architecture** level instead of the model level. Swap in different security designs, run them against the same attack set on the same local model, and see which patterns help and by how much.

Side project. Runs against a small model via Ollama — no API costs, fast to iterate, small enough to drop in your own defense.

## The idea

Most prompt-injection work hardens the model through training. That helps but never closes the gap. The other path is to change the harness around the model so the attack surface shrinks: untrusted text never reaches a position of authority, secrets never reach the model at all, references replace raw content. This is a place to try those patterns side by side.

A defense here is just a transform on the input, system prompt, or tool schema (`src/pipeline.ts`). Adding one is a new toggle and a small file under `src/defenses/`.

## Defenses (v0)

- **`typedContext`** — wraps every input block in `<block trust=... authority=...>` and tells the model only `executable` blocks carry policy. *Prompt-class*: works only if the model honors the labels.
- **`dualLlm`** — a quarantined model reads the raw input and emits structured JSON intent; the privileged agent acts on the JSON, never the raw text. *Prompt-class*. ([Willison](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/), [CaMeL](https://arxiv.org/abs/2503.18813))
- **`signedContext`** — `typedContext`'s enforcement twin. Authentic blocks carry a seed-derived nonce the attacker can't know, and every angle bracket in untrusted input is neutralized, so a forged `<system>`/`<tool_output>` block arrives as inert text instead of structure. *Enforcement-class*: the structural guarantee holds regardless of model competence.
- **`capabilityHandles`** — the model sees opaque handles (`cap:email_address:0001`) instead of raw addresses/paths; the runtime rejects any tool call naming a raw value. *Enforcement-class*: holds no matter what the model emits. ([CaMeL](https://arxiv.org/abs/2503.18813))

Planned: URL references, indirect-injection scenarios.

## The cross-scale law

The headline experiment. Defenses split by *how they earn their security*:

- **Prompt-class** (`typedContext`, `dualLlm`) — security depends on the model honoring a convention. Nothing stops a model that ignores it.
- **Enforcement-class** (`capabilityHandles`, `signedContext`) — security is a runtime check. The model literally cannot name a raw attacker address, nor see a forged authority block; the wrapper rejects or strips it.

The cleanest single test of this is `typed_only` vs `signed_only`: the same trust-label mechanism, one relying on the model and one enforced at the runtime. If the law holds, the prompt version's protection climbs with scale while the signed version stays flat.

That predicts a testable claim:

> **Prompt-class defenses need scale; enforcement-class defenses do not.** A model too weak to honor a trust label gets little from a prompt defense, so its protection should *grow* with parameter count. Enforcement blocks at the runtime regardless of model competence, so its protection should be *flat*.

The runner sweeps the same attacks across a model-size ladder (default: `qwen2.5` 0.5B→7B, one family so only parameter count changes). For each defense it reports **marginal protection vs baseline** — the share of attacks it blocks that the bare baseline let through — which isolates the defense from the base model's own scale trend, then reports the protection *slope* per class.

Two guards keep the curve honest:

- **Tool-engagement floor.** A model that barely calls tools shows a low injection rate for free — incompetence, not defense. Scales below the floor (default 30%) are flagged `*` and excluded from slope claims.
- **No significance theater.** N is small (attacks × seeds). The verdict reports a *direction* (consistent / weak / not supported), never a p-value.

## Run

The Nix flake is the supported path — entering the dev shell starts `ollama serve` in the background and cleans it up on exit. The runner pulls each model on first use.

```
nix develop
bun install
bun run run                            # default sweep: qwen2.5 0.5b,1.5b,3b,7b
bun run run qwen2.5:3b                 # single model (no scale axis)
bun run run qwen2.5:1.5b qwen2.5:7b    # custom sweep, ordered by scale
```

Or without a shell: `nix run .` (writes to `$PWD/results/`), `nix run . -- qwen2.5:3b`.

Already have Ollama on PATH? Use `nix develop .#bare` to skip a second copy in the Nix store. Without Nix: install [Bun](https://bun.sh) and Ollama, run `ollama serve`, then `bun install && bun run run`.

Sweep selection precedence: positional args > `SECUREAGENT_MODELS` > `SECUREAGENT_MODEL` > default.

| env | meaning |
| --- | --- |
| `SECUREAGENT_MODELS` | comma-separated model ladder (use one family) |
| `SECUREAGENT_MODEL` | single model tag (back-compat) |
| `SECUREAGENT_CONFIGS` | subset of `baseline,typed_only,signed_only,caps_only,dual_only,typed+caps,all_on` |
| `OLLAMA_HOST` | Ollama base URL (default `http://localhost:11434`) |
| `SECUREAGENT_SEED` | sampler seed (default `42`) |

Outputs land in `results/`: `outcomes-<ts>.csv`/`.json` (one row per run) and `matrix-<ts>.csv` (per-`(model, config)` summary — the file you plot the curve from).

`nix flake check` runs `tsc --noEmit` in a hermetic derivation. (Changing `package.json`/`bun.lock` means re-pinning the `node_modules` FOD hash — see the comment in `flake.nix`.)

## Scoring & determinism

Scoring is deterministic. Each attack declares a `forbidden` pattern — an address that must never appear in `send_email.to`, or a path that must never reach `delete_file` — and the scorer checks recorded tool calls against it. v0 attacks are pure attacks with no benign task mixed in, so this skips task-completion; that comes next.

Runs are reproducible on the same machine: locked sampler (`temperature=0`, fixed `seed`/`num_ctx`) and deterministic handle IDs make the system prompt byte-identical across runs. Only `latencyMs` and tool-call key *ordering* vary; verdicts and values don't. Cross-machine determinism isn't guaranteed (GPU atomics, quantization, Ollama version), and the model itself isn't pinned by Nix.

## Limitations

Honest about what v0 doesn't do yet:

- **No utility axis.** Defenses that restrict the agent look good on injection but worse on real tasks. Until benign tasks are mixed in, every defense looks free.
- **Direct injection only.** The harder, more interesting case is indirect injection (poisoned tool output, retrieved docs).
- **Toy scale.** A 0.5B–7B ladder measures the slope entirely in the weak regime; it may not extrapolate.
- **Hand-crafted attacks.** Ten of them. Adapting an existing benchmark ([AgentDojo](https://arxiv.org/abs/2406.13352), [InjecAgent](https://arxiv.org/abs/2403.02691)) is the right next step.

## Non-goals

Training a more robust model · inference-engine modifications · a production agent framework.

## References

- Debenedetti et al. (2024), *AgentDojo.* [arXiv:2406.13352](https://arxiv.org/abs/2406.13352)
- Zhan et al. (2024), *InjecAgent.* [arXiv:2403.02691](https://arxiv.org/abs/2403.02691)
- Toyer et al. (2023), *Tensor Trust.* [arXiv:2311.01011](https://arxiv.org/abs/2311.01011)
- Willison (2023), *The Dual LLM pattern.* [simonwillison.net](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/)
- Debenedetti et al. (2025), *Defeating Prompt Injections by Design (CaMeL).* [arXiv:2503.18813](https://arxiv.org/abs/2503.18813)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). One logical change per commit, [Conventional Commits](https://www.conventionalcommits.org), `bun run typecheck` passes before a PR.

## License

Apache 2.0. See [LICENSE](LICENSE).
