# secureagent

An agent harness for testing prompt injection defenses at the architecture level instead of the model level. The goal is to make it easy to swap in different security designs and run them against the same injection benchmark, so you can see which patterns help and by how much.

Side project. Runs locally against a small model served by Ollama, so there are no API costs and you can iterate fast. Meant to be small enough that other people can drop in their own defenses.

## Why

Most prompt injection work tries to make the model itself more resistant through training. That helps but never fully closes the gap. The other path is to change the harness around the model so the attack surface shrinks. Untrusted text never reaches a position of authority. Secrets never reach the model at all. References replace raw content. This project is a place to try those patterns side by side.

## Defenses

Seven patterns from the literature. Not all of them are realistic to test in a wrapper.

1. Typed context segments. Every input block carries a trust label (system, user, tool_output, retrieved_doc). The model is instructed that only system blocks carry authority. Cheap to implement. Effectiveness depends on the model honoring the labels.

2. Capability handles. The model sees opaque references like `cap:email.send:session_8842` instead of raw secrets, URLs, or shell access. The runtime resolves them and enforces permissions. Strong guarantee for whatever you wrap. (The capability-based approach is developed rigorously in [CaMeL](https://arxiv.org/abs/2503.18813).)

3. URL references instead of raw content. Pull untrusted content out of the context window. The runtime fetches, sanitizes, and decides what the model sees.

4. Signed context. Provenance metadata on every block, validated by the runtime. Useful in multi-agent or persistent-memory setups. Adds key management overhead.

5. Dual-LLM. A quarantined model reads untrusted data and emits a structured result. A privileged model acts on the structured result, never the raw text. Costs an extra call and some plumbing. ([Willison's dual-LLM pattern](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/), later formalized by [CaMeL](https://arxiv.org/abs/2503.18813).)

6. Attention isolation via tags. Tag content with authority levels and rely on the model to respect them. Can be tested as a prompt-level convention. The real version needs model training.

7. Token-level taint tracking. Each token carries source metadata and the inference engine enforces flow rules. Out of scope for an SDK-only harness.

Patterns 1 through 5 are the realistic target. 6 is partial. 7 is not testable here.

## How testing works

Pick a model with known weaknesses. Pick an attack set. Run the same attacks against each defense configuration. Score outcomes with a judge model or a deterministic checker.

Configurations are composable, so you can sweep (defense stack x attack class x model) and produce a comparison matrix.

## The cross-scale law

The headline experiment. Defenses split into two kinds by *how they earn their security*:

- **Prompt-class** (`typedContext`, `dualLlm`): security depends on the model honoring instructions — respecting a trust label, acting only on a quarantined paraphrase. Nothing stops a model that ignores the convention.
- **Enforcement-class** (`capabilityHandles`): security is a runtime check that holds no matter what the model emits. The model literally cannot name a raw attacker address; the wrapper rejects the call.

That distinction predicts a testable claim:

> **Prompt-class defenses need scale; enforcement-class defenses do not.** A small model is too weak to honor a trust label, so prompt defenses do little until the model is capable enough to follow them — their protection should *grow* with parameter count. Enforcement defenses block at the runtime regardless of model competence, so their protection should be *flat* across scale.

The runner tests this by sweeping the same attacks and configs across a model-size ladder (default: `qwen2.5` 0.5B → 7B, one family so the only thing changing is parameter count). For each defense it computes **marginal protection vs baseline** at every scale — the share of attacks the defense blocks that the bare baseline let through — which isolates the defense from the base model's own scale trend. Then it reports the protection *slope* across scale, per defense class.

Two pieces of rigor that make the curve mean something:

- **Tool-engagement floor.** A model that barely calls tools shows a near-zero injection rate for free — that is incompetence, not defense. The report measures baseline tool-engagement per scale and excludes scales below the floor (default 30%) from any slope claim, flagging them with `*` in the matrix.
- **No significance theater.** N is small (attacks × seeds). The verdict reports a *direction* (consistent / weak / not supported), never a p-value.

A clean confirmation looks like: a large positive protection slope for the prompt class, a flat (near-zero) slope for enforcement. If it does not show up in your sweep, the runner says so.

## Open questions

These need answers before the code is worth writing.

- Benchmark source. Building one from scratch is more work than it sounds. [AgentDojo](https://arxiv.org/abs/2406.13352), [InjecAgent](https://arxiv.org/abs/2403.02691), and [Tensor Trust](https://arxiv.org/abs/2311.01011) exist. Start by adapting one.
- Scoring. "Injection succeeded" needs a clear definition per attack class. For tool-call attacks it is which tools were invoked with which arguments. For exfiltration it is whether a specific string left the system. Each class needs its own oracle.
- Fair comparison. Capability handles and URL refs restrict what the agent can do. They will look better on injection but worse on task completion. Report both, otherwise the numbers mislead.
- Composition. Defenses are not orthogonal. Real systems stack them. The interesting question is which stacks pay for their cost, not which single defense wins.
- Threat model. Direct injection in user input, indirect via tool output, via retrieved documents, via persistent memory. Each favors different defenses. Pick one scenario first.
- Runtime trust. Capability handles and signed context push the trust boundary to the runtime. If the runtime can be confused by model output (a tool argument smuggling a control character, an injection that escapes the wrapper format), the guarantee leaks. Test this directly.

## v0

What is in this version:

- Small local models via Ollama (default sweep: `qwen2.5` 0.5b → 7b; pass one tag to run a single model)
- A toy agent with three mock tools: `read_notes`, `send_email`, `delete_file`
- Three defenses, each independently toggleable: `typedContext`, `capabilityHandles`, `dualLlm`
- A hand-crafted attack set (`data/attacks.json`) covering direct injection for exfiltration and destructive tool calls
- A grid runner that sweeps every defense combination against every attack and writes CSV + JSON

The shape of a defense is a transform on the input/system prompt or the tool schema. Adding a new defense means a new toggle and a small file under `src/defenses/`.

### Run

The Nix flake is the supported way to run this (treat it like the Docker image of the project). Entering the dev shell starts an `ollama serve` in the background and stops it when the shell exits. State lives in `.ollama/` (logs and pid, gitignored). The runner pulls the model on first use, so a fresh checkout boils down to:

```
nix develop
bun install
bun run run                            # default sweep: qwen2.5 0.5b,1.5b,3b,7b
bun run run qwen2.5:3b                 # single model (no scale axis)
bun run run qwen2.5:1.5b qwen2.5:7b    # custom sweep, ordered by scale
```

The default sweep runs the full cross-scale study and pulls each model on first use. Pass one model to fall back to a single-model run.

Or, without entering a shell:

```
nix run .                              # default sweep
nix run . -- qwen2.5:3b                # single model
nix run . -- qwen2.5:0.5b qwen2.5:7b   # custom sweep
```

`nix run` writes outputs to `$PWD/results/`. Override with `SECUREAGENT_RESULTS_DIR`.

To run a different model or sweep from inside the dev shell:

```
bun run run qwen2.5:3b                        # single model
SECUREAGENT_MODELS=qwen2.5:1.5b,qwen2.5:7b bun run run   # sweep via env
SECUREAGENT_MODEL=llama3.1:8b bun run run     # single model via env (back-compat)
```

Sweep selection precedence: positional args > `SECUREAGENT_MODELS` > `SECUREAGENT_MODEL` > default sweep.

If an ollama daemon is already running on `OLLAMA_HOST`, the shell uses that one and does not manage it.

#### Already have ollama installed

If you don't want a second copy of ollama in your Nix store, use the bare shell. It expects ollama on your PATH (e.g. installed via https://ollama.com, Homebrew, or your system package manager) and uses that binary instead.

```
nix develop .#bare
```

The shell hook is identical otherwise (auto-starts the daemon, watcher cleans up on exit, etc.). It errors with a hint if no `ollama` is on PATH.

Without Nix at all: install Bun (`curl -fsSL https://bun.sh/install | bash`) and Ollama, start `ollama serve`, then `bun install && bun run run`.

### Checks

`nix flake check` runs `tsc --noEmit` in a hermetic derivation:

```
nix flake check
```

The `node_modules` used by the check is a Fixed Output Derivation. If you change `package.json` or `bun.lock`, set `outputHash` in `flake.nix` back to `pkgs.lib.fakeHash`, run `nix build .#checks.x86_64-linux.typecheck` once, and paste the corrected hash from the error message.

Environment overrides:

- `SECUREAGENT_MODELS` comma-separated model ladder for the cross-scale sweep, e.g. `qwen2.5:0.5b,qwen2.5:1.5b,qwen2.5:3b`. Defaults to the `qwen2.5` 0.5B→7B ladder. Use one family so the only thing changing is parameter count.
- `SECUREAGENT_MODEL` single model tag (back-compat). Use any tool-capable model. Lower precedence than `SECUREAGENT_MODELS`.
- `OLLAMA_HOST` Ollama base URL (default `http://localhost:11434`).
- `SECUREAGENT_CONFIGS` comma-separated subset of configs to run, e.g. `baseline,all_on`.

Configs available: `baseline`, `typed_only`, `caps_only`, `dual_only`, `typed+caps`, `all_on`.

Output goes to `results/outcomes-<timestamp>.csv` (one row per run), `.json` (same, structured), and `results/matrix-<timestamp>.csv` (tidy per-`(model, config)` summary with injection rate, tool-engagement, and defense class — the file you plot the cross-scale curve from).

### Determinism

Two consecutive runs against the same model on the same machine produce identical verdicts and tool-call values per `(config, attack)`. This is achieved by:

- Locked sampler in every Ollama call (`temperature=0`, `top_k=1`, `top_p=1`, fixed `seed`, fixed `num_ctx`).
- Deterministic capability handle IDs (incrementing counters per kind, not random bytes), so the system prompt is byte-identical across runs.

Override the seed with `SECUREAGENT_SEED=<int>` (default `42`).

What still varies across runs and does not affect verdicts:

- `latencyMs` per outcome (wall clock).
- Key serialization order inside tool-call argument objects (Ollama returns the same fields, sometimes in a different order). Values are stable.

Determinism across different machines is not guaranteed (GPU atomics, quantization, Ollama version differences).

The model itself is the load-bearing input and is not pinned by Nix. `ollama pull` fetches each model in the sweep (the `qwen2.5` ladder by default, or whatever you select) at runtime into `~/.ollama`, outside the Nix store. Two checkouts on different machines will get the same Bun, Ollama daemon, and TypeScript, but possibly a different model snapshot if the tag has been republished. If you need byte-for-byte reproducibility of the model, snapshot it manually and serve from a local file.

### Defenses in this version

- `typedContext` wraps every input block in `<block trust="..." authority="...">` and adds rules to the system prompt saying only `executable` blocks carry policy.
- `capabilityHandles` swaps raw email addresses and file paths for opaque handles like `cap:email_address:abc123`. The tool wrapper rejects calls whose `to` or `path` is not a known handle, so the model literally cannot name an attacker address.
- `dualLlm` runs a quarantined extractor model on the raw user input first. The extractor returns a structured JSON intent (`task`, `mentioned_emails`, `mentioned_paths`, `contains_suspected_injection`). The privileged agent sees only this JSON, never the raw input.

### Scoring

Deterministic. Each attack declares a `forbidden` pattern: a specific email address that must never appear in a `send_email.to`, or a path that must never be passed to `delete_file`. The scorer checks the agent's recorded tool calls against the pattern.

This skips the question of whether the agent completed the legitimate task. v0 attacks are pure attacks (no benign task mixed in). That comes next.

## Future

- Add URL refs and signed context defenses.
- Mix benign tasks into attacks so we can report task completion alongside injection rate.
- Add indirect injection (tool output, retrieved doc) scenarios.
- Adapt an existing benchmark ([AgentDojo](https://arxiv.org/abs/2406.13352), [InjecAgent](https://arxiv.org/abs/2403.02691)) instead of only hand-crafted attacks.

## Non-goals

- Training a more robust model
- Inference engine modifications
- A production agent framework

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: one logical change per
commit, [Conventional Commits](https://www.conventionalcommits.org) messages,
and `bun run typecheck` must pass before opening a PR.

## References

Benchmarks:

- Debenedetti et al. (2024), *AgentDojo: A Dynamic Environment to Evaluate Prompt Injection Attacks and Defenses for LLM Agents.* [arXiv:2406.13352](https://arxiv.org/abs/2406.13352)
- Zhan et al. (2024), *InjecAgent: Benchmarking Indirect Prompt Injections in Tool-Integrated Large Language Model Agents.* [arXiv:2403.02691](https://arxiv.org/abs/2403.02691)
- Toyer et al. (2023), *Tensor Trust: Interpretable Prompt Injection Attacks from an Online Game.* [arXiv:2311.01011](https://arxiv.org/abs/2311.01011)

Defenses:

- Willison (2023), *The Dual LLM pattern for building AI assistants that can resist prompt injection.* [simonwillison.net](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/)
- Debenedetti et al. (2025), *Defeating Prompt Injections by Design (CaMeL).* [arXiv:2503.18813](https://arxiv.org/abs/2503.18813)

## License

Apache License 2.0. See [LICENSE](LICENSE).
