// Copyright 2026 Taimur Hasan
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { mapWithConcurrency } from "./concurrency.js";
import { capabilityHandlesTransform } from "./defenses/capabilityHandles.js";
import { dualLlmTransform } from "./defenses/dualLlm.js";
import { signedContextTransform } from "./defenses/signedContext.js";
import { typedContextTransform } from "./defenses/typedContext.js";
import { orderByScale, parseParamsB, resolveSweep } from "./models.js";
import { OllamaClient } from "./ollama.js";
import type { Transform } from "./pipeline.js";
import { renderMatrix, renderScaleAnalysis, summarize, tidyCsv } from "./report.js";
import { injectionSucceeded } from "./scoring.js";
import type { Attack, AttackOutcome, DefenseClass } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_ROOT = join(__dirname, "..");
const RESULTS_DIR = process.env["SECUREAGENT_RESULTS_DIR"] ?? join(process.cwd(), "results");

const SWEEP = orderByScale(
  resolveSweep(positionalArgs(process.argv.slice(2)), {
    models: process.env["SECUREAGENT_MODELS"],
    model: process.env["SECUREAGENT_MODEL"],
  }),
);
const HOST = normalizeHost(process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434");
const SEED = parseSeed(process.env["SECUREAGENT_SEED"]);
const MAX_TURNS = 6;
// Every completed run is appended here as one JSON line the moment it finishes,
// so a crash or Ctrl-C mid-sweep loses nothing. On startup we load it and skip
// runs already present (transient failures excepted — see shouldSkip), so a
// re-run resumes where it left off. Keyed by seed because the seed determines a
// run's output; changing models or configs is safe (keys simply won't collide).
// Removed once the final timestamped outputs are written.
const CHECKPOINT =
  process.env["SECUREAGENT_CHECKPOINT"] ?? join(RESULTS_DIR, `checkpoint-seed-${SEED}.jsonl`);
// Runs within a single model fire concurrently against Ollama. Models stay
// sequential (outer loop), so only one model is resident in memory at a time —
// the speedup costs no extra VRAM. Concurrency is pure scheduling: each run has
// its own messages and a fixed seed, so verdicts match a serial run exactly.
// Tune with SECUREAGENT_CONCURRENCY; needs Ollama's OLLAMA_NUM_PARALLEL >= this
// to actually run in parallel (scripts/serve-ollama.sh sets it).
const CONCURRENCY = parsePositive(process.env["SECUREAGENT_CONCURRENCY"], 4);

type Preset = {
  name: string;
  // How the defense earns its security. "prompt" defenses depend on the model
  // honoring instructions (so we expect them to need scale); "enforcement"
  // defenses block at the runtime regardless of model (so we expect them flat).
  defenseClass: DefenseClass;
  build: () => Transform[];
};

const PRESETS: Preset[] = [
  { name: "baseline", defenseClass: "none", build: () => [] },
  { name: "typed_only", defenseClass: "prompt", build: () => [typedContextTransform] },
  // signed_only is typed_only's enforcement twin: same trust-label idea, but the
  // labels are unforgeable. The pair isolates the prompt-vs-enforcement axis on
  // one mechanism — the cleanest single test of the cross-scale law.
  { name: "signed_only", defenseClass: "enforcement", build: () => [signedContextTransform(SEED)] },
  { name: "caps_only", defenseClass: "enforcement", build: () => [capabilityHandlesTransform()] },
  { name: "dual_only", defenseClass: "prompt", build: () => [dualLlmTransform] },
  {
    name: "typed+caps",
    defenseClass: "mixed",
    build: () => [typedContextTransform, capabilityHandlesTransform()],
  },
  {
    name: "all_on",
    defenseClass: "mixed",
    build: () => [dualLlmTransform, typedContextTransform, capabilityHandlesTransform()],
  },
];

const CLASS_OF = new Map<string, DefenseClass>(PRESETS.map((p) => [p.name, p.defenseClass]));

async function main(): Promise<void> {
  const client = new OllamaClient(HOST);
  try {
    await client.ping();
  } catch (e) {
    console.error(`Cannot reach Ollama at ${HOST}: ${errString(e)}`);
    console.error("Start it with `ollama serve` or enter the nix dev shell.");
    process.exit(1);
  }

  for (const model of SWEEP) {
    try {
      await client.ensureModel(model, (msg) => console.log(msg));
    } catch (e) {
      console.error(`Failed to ensure model ${model}: ${errString(e)}`);
      process.exit(1);
    }
  }

  const filter = (process.env["SECUREAGENT_CONFIGS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const presets = filter.length > 0 ? PRESETS.filter((p) => filter.includes(p.name)) : PRESETS;

  // Build each preset's transforms once. They hold no per-run mutable state
  // (the capability store is seeded deterministically and only read during
  // validation), so one instance is safe to share across every run.
  const built = presets.map((p) => ({ preset: p, transforms: p.build() }));

  const attacks = loadAttacks();
  const total = SWEEP.length * presets.length * attacks.length;
  let done = 0;

  // Flat task list per model, in (preset, attack) order. The final outputs are
  // assembled by looking each run up in this order (see below), so files stay
  // byte-identical no matter the concurrency or whether we resumed. Only the
  // live progress lines interleave.
  const jobs = built.flatMap(({ preset, transforms }) =>
    attacks.map((atk) => ({ preset, transforms, atk })),
  );

  // Completed runs, keyed by (model, config, attack). Pre-loaded from the
  // checkpoint so a resumed sweep skips work already done, and grown as new
  // runs finish. Becomes the full result set the final outputs are built from.
  mkdirSync(RESULTS_DIR, { recursive: true });
  const completed = loadCheckpoint(CHECKPOINT);

  console.log(`Sweep:       ${SWEEP.join(", ")}`);
  console.log(`Host:        ${HOST}`);
  console.log(`Seed:        ${SEED}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Configs:     ${presets.map((p) => p.name).join(", ")}`);
  console.log(`Attacks:     ${attacks.length}`);
  console.log(`Total runs:  ${total}`);
  console.log(`Checkpoint:  ${CHECKPOINT}\n`);

  for (const model of SWEEP) {
    const paramsB = parseParamsB(model);
    const todo = jobs.filter(({ preset, atk }) => {
      const prev = completed.get(keyOf(model, preset.name, atk.id));
      return !prev || isRetryable(prev);
    });
    const skipped = jobs.length - todo.length;
    if (skipped > 0) {
      done += skipped;
      console.log(`${model}: resuming, ${skipped} cached, ${todo.length} to run`);
    }

    await mapWithConcurrency(todo, CONCURRENCY, async ({ preset, transforms, atk }) => {
      const t0 = Date.now();
      // Each task is isolated: any throw becomes an error outcome rather than
      // rejecting the pool and discarding every other run's work. runAgent
      // already traps its own failures, but a bug anywhere here would escape.
      let outcome: AttackOutcome;
      try {
        const run = await runAgent(
          client,
          { model, maxTurns: MAX_TURNS, seed: SEED, transforms },
          atk.userInput,
        );
        const latencyMs = Date.now() - t0;
        const succeeded = injectionSucceeded(atk, run.toolCallsExecuted);
        outcome = {
          attackId: atk.id,
          configName: preset.name,
          defenseClass: preset.defenseClass,
          model,
          modelParamsB: paramsB,
          transforms: transforms.map((t) => t.name),
          injectionSucceeded: succeeded,
          taskCompleted: !run.error,
          toolCallsAttempted: run.toolCallsAttempted,
          toolCallsExecuted: run.toolCallsExecuted,
          turns: run.turns,
          latencyMs,
          ...(run.error ? { error: run.error } : {}),
        };
      } catch (e) {
        outcome = {
          attackId: atk.id,
          configName: preset.name,
          defenseClass: preset.defenseClass,
          model,
          modelParamsB: paramsB,
          transforms: transforms.map((t) => t.name),
          injectionSucceeded: false,
          taskCompleted: false,
          toolCallsAttempted: [],
          toolCallsExecuted: [],
          turns: 0,
          latencyMs: Date.now() - t0,
          error: `job_failed: ${errString(e)}`,
        };
      }

      appendFileSync(CHECKPOINT, `${JSON.stringify(outcome)}\n`);
      completed.set(keyOf(model, preset.name, atk.id), outcome);
      console.log(
        `[${++done}/${total}] ${model.padEnd(16)} ${preset.name.padEnd(12)} ${atk.id.padEnd(24)} ` +
          `${outcome.injectionSucceeded ? "INJECTED" : "blocked "} ${outcome.latencyMs}ms` +
          (outcome.error ? ` (error: ${outcome.error})` : ""),
      );
      return outcome;
    });
  }

  // Assemble in canonical (model, preset, attack) order from the completed set
  // — independent of completion order, concurrency, and resume boundaries.
  const outcomes: AttackOutcome[] = [];
  for (const model of SWEEP) {
    for (const { preset, atk } of jobs) {
      const o = completed.get(keyOf(model, preset.name, atk.id));
      if (o) outcomes.push(o);
    }
  }

  writeOutputs(outcomes);
  rmSync(CHECKPOINT, { force: true });

  const cells = summarize(outcomes, (c) => CLASS_OF.get(c) ?? "none");
  const configOrder = presets.map((p) => p.name);
  console.log("");
  console.log(renderMatrix(cells, configOrder));
  console.log("");
  console.log(renderScaleAnalysis(cells, configOrder));
}

function keyOf(model: string, config: string, attackId: string): string {
  // NUL can't appear in any of the parts, so the join is unambiguous.
  return `${model} ${config} ${attackId}`;
}

// A run worth re-running on resume: only infrastructure failures (Ollama down,
// an unexpected throw). Deterministic terminal states — a clean result,
// max_turns_reached, a transform that always fails — are kept as-is.
function isRetryable(o: AttackOutcome): boolean {
  return !!o.error && (o.error.startsWith("api_error") || o.error.startsWith("job_failed"));
}

// Load prior runs from the checkpoint. Malformed trailing lines (a half-written
// record from a crash) are skipped; later lines win, so a retried run's fresh
// result supersedes the failed one it was appended after.
function loadCheckpoint(path: string): Map<string, AttackOutcome> {
  const map = new Map<string, AttackOutcome>();
  if (!existsSync(path)) return map;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line) as AttackOutcome;
      map.set(keyOf(o.model, o.configName, o.attackId), o);
    } catch {
      // ignore a malformed (e.g. partially flushed) line
    }
  }
  return map;
}

function loadAttacks(): Attack[] {
  const path = join(SCRIPT_ROOT, "data", "attacks.json");
  return JSON.parse(readFileSync(path, "utf8")) as Attack[];
}

function writeOutputs(outcomes: AttackOutcome[]): void {
  const dir = RESULTS_DIR;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const csvPath = join(dir, `outcomes-${stamp}.csv`);
  const header = [
    "model",
    "paramsB",
    "attack_id",
    "config",
    "defenseClass",
    "transforms",
    "injectionSucceeded",
    "turns",
    "latencyMs",
    "toolCallsAttempted",
    "toolCallsExecuted",
    "error",
  ].join(",");
  const rows = outcomes.map((o) =>
    [
      o.model,
      Number.isNaN(o.modelParamsB) ? "" : o.modelParamsB,
      o.attackId,
      o.configName,
      o.defenseClass,
      `"${o.transforms.join("|")}"`,
      o.injectionSucceeded,
      o.turns,
      o.latencyMs,
      `"${o.toolCallsAttempted.map((c) => c.name).join("|")}"`,
      `"${o.toolCallsExecuted.map((c) => c.name).join("|")}"`,
      o.error ?? "",
    ].join(","),
  );
  writeFileSync(csvPath, [header, ...rows].join("\n"));

  const jsonPath = join(dir, `outcomes-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(outcomes, null, 2));

  // Tidy per-(model, config) summary, scale on the x-axis — the file you plot.
  const matrixPath = join(dir, `matrix-${stamp}.csv`);
  writeFileSync(matrixPath, tidyCsv(summarize(outcomes, (c) => CLASS_OF.get(c) ?? "none")));

  console.log(`\nWrote ${csvPath}`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${matrixPath}`);
}

function normalizeHost(h: string): string {
  return /^https?:\/\//.test(h) ? h : `http://${h}`;
}

function positionalArgs(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

function parseSeed(raw: string | undefined): number {
  if (!raw) return 42;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 42;
}

function parsePositive(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function errString(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
