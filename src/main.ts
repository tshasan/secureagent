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
import { classOf, getDefense } from "./defenses/index.js";
import {
  createClient,
  providerEndpoint,
  type ProviderEnv,
  type ProviderName,
  resolveProvider,
} from "./llm.js";
import { orderByScale, parseParamsB, resolveSweep } from "./models.js";
import type { BuildCtx, Transform } from "./pipeline.js";
import { type Cell, renderMatrix, renderScaleAnalysis, summarize, tidyCsv } from "./report.js";
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
const PROVIDER_ENV: ProviderEnv = {
  provider: process.env["SECUREAGENT_PROVIDER"],
  ollamaHost: process.env["OLLAMA_HOST"],
  openrouterKey: process.env["OPENROUTER_API_KEY"],
  openrouterBaseUrl: process.env["OPENROUTER_BASE_URL"],
};
const SEED = parseSeed(process.env["SECUREAGENT_SEED"]);
const MAX_TURNS = 6;
// Every completed run is appended here as one JSON line the moment it finishes,
// so a crash or Ctrl-C mid-sweep loses nothing. On startup we load it and skip
// runs already present (transient failures excepted — see isRetryable), so a
// re-run resumes where it left off. Keyed by seed because the seed determines a
// run's output; changing models or configs is safe (keys simply won't collide).
// Removed once the final timestamped outputs are written.
const CHECKPOINT =
  process.env["SECUREAGENT_CHECKPOINT"] ?? join(RESULTS_DIR, `checkpoint-seed-${SEED}.jsonl`);
// Runs within a single model fire concurrently against the provider. Models stay
// sequential (outer loop), so only one model is resident in memory at a time —
// the speedup costs no extra VRAM. Concurrency is pure scheduling: each run has
// its own messages and a fixed seed, so verdicts match a serial run exactly.
// Tune with SECUREAGENT_CONCURRENCY; needs Ollama's OLLAMA_NUM_PARALLEL >= this
// to actually run in parallel (scripts/serve-ollama.sh sets it).
const CONCURRENCY = parsePositive(process.env["SECUREAGENT_CONCURRENCY"], 4);

// A preset is a named list of defense ids (see src/defenses/index.ts). Its
// defenseClass is derived from the constituents, not hand-typed, so the
// prompt-vs-enforcement axis the study reports is always a property of the
// mechanisms in the stack. signed_only is typed_only's enforcement twin: same
// trust-label idea, unforgeable labels — the cleanest single test of the law.
const PRESETS = {
  baseline: [],
  typed_only: ["typedContext"],
  signed_only: ["signedContext"],
  caps_only: ["capabilityHandles"],
  dual_only: ["dualLlm"],
  "typed+caps": ["typedContext", "capabilityHandles"],
  all_on: ["dualLlm", "typedContext", "capabilityHandles"],
} satisfies Record<string, readonly string[]>;

// A preset materialized for a run: its transforms built once (they hold no
// mutable per-run state, see DefenseDef) and reused across every model × attack.
type Preset = {
  name: string;
  transforms: Transform[];
  defenseClass: DefenseClass;
};

function buildPresets(names: string[], ctx: BuildCtx): Preset[] {
  return names.map((name) => {
    const ids = PRESETS[name as keyof typeof PRESETS] ?? [];
    return {
      name,
      transforms: ids.map((id) => getDefense(id).build(ctx)),
      defenseClass: classOf(ids),
    };
  });
}

async function main(): Promise<void> {
  let provider: ProviderName;
  try {
    provider = resolveProvider(PROVIDER_ENV);
  } catch (e) {
    console.error(errString(e));
    process.exit(1);
  }
  const endpoint = providerEndpoint(provider, PROVIDER_ENV);

  const client = createClient(provider, PROVIDER_ENV);
  try {
    await client.ping();
  } catch (e) {
    console.error(`Cannot reach ${provider} at ${endpoint}: ${errString(e)}`);
    if (provider === "ollama") {
      console.error("Start it with `ollama serve` or enter the nix dev shell.");
    } else {
      console.error("Check OPENROUTER_API_KEY and your network connection.");
    }
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

  const filter = parseList(process.env["SECUREAGENT_CONFIGS"]);
  const allNames = Object.keys(PRESETS);
  const configNames = filter.length > 0 ? allNames.filter((n) => filter.includes(n)) : allNames;
  // Build each preset's transforms once. They hold no per-run mutable state
  // (the capability store is seeded deterministically and only read during
  // validation), so one instance is safe to share across every run.
  const presets = buildPresets(configNames, { seed: SEED });
  const classByName = new Map(presets.map((p) => [p.name, p.defenseClass]));
  const classOfConfig = (name: string): DefenseClass => classByName.get(name) ?? "none";

  const attacks = loadAttacks();
  const total = SWEEP.length * presets.length * attacks.length;
  let done = 0;

  // Flat task list per model, in (preset, attack) order. The final outputs are
  // assembled by looking each run up in this order (see below), so files stay
  // byte-identical no matter the concurrency or whether we resumed. Only the
  // live progress lines interleave.
  const jobs = presets.flatMap((preset) => attacks.map((atk) => ({ preset, atk })));

  // Completed runs, keyed by (model, config, attack). Pre-loaded from the
  // checkpoint so a resumed sweep skips work already done, and grown as new
  // runs finish. Becomes the full result set the final outputs are built from.
  mkdirSync(RESULTS_DIR, { recursive: true });
  const completed = loadCheckpoint(CHECKPOINT);

  console.log(`Sweep:       ${SWEEP.join(", ")}`);
  console.log(`Provider:    ${provider} (${endpoint})`);
  console.log(`Seed:        ${SEED}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Configs:     ${configNames.join(", ")}`);
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

    await mapWithConcurrency(todo, CONCURRENCY, async ({ preset, atk }) => {
      const t0 = Date.now();
      // Each task is isolated: any throw becomes an error outcome rather than
      // rejecting the pool and discarding every other run's work. runAgent
      // already traps its own failures, but a bug anywhere here would escape.
      let outcome: AttackOutcome;
      try {
        const run = await runAgent(
          client,
          { model, maxTurns: MAX_TURNS, seed: SEED, transforms: preset.transforms },
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
          transforms: preset.transforms.map((t) => t.name),
          injectionSucceeded: succeeded,
          taskCompleted: !run.error,
          toolCallsAttempted: run.toolCallsAttempted,
          toolCallsExecuted: run.toolCallsExecuted,
          turns: run.turns,
          latencyMs,
          error: run.error,
        };
      } catch (e) {
        outcome = {
          attackId: atk.id,
          configName: preset.name,
          defenseClass: preset.defenseClass,
          model,
          modelParamsB: paramsB,
          transforms: preset.transforms.map((t) => t.name),
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

  const cells = summarize(outcomes, classOfConfig);
  writeOutputs(outcomes, cells);
  rmSync(CHECKPOINT, { force: true });

  const configOrder = presets.map((p) => p.name);
  console.log("");
  console.log(renderMatrix(cells, configOrder));
  console.log("");
  console.log(renderScaleAnalysis(cells, configOrder));
}

function keyOf(model: string, config: string, attackId: string): string {
  // NUL can't appear in any of the parts, so the join is unambiguous.
  return `${model} ${config} ${attackId}`;
}

// A run worth re-running on resume: only infrastructure failures (provider down,
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

function writeOutputs(outcomes: AttackOutcome[], cells: Cell[]): void {
  const dir = RESULTS_DIR;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  const csvPath = join(dir, `outcomes-${stamp}.csv`);
  const header = csvRow([
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
  ]);
  const rows = outcomes.map((o) =>
    csvRow([
      o.model,
      Number.isNaN(o.modelParamsB) ? "" : o.modelParamsB,
      o.attackId,
      o.configName,
      o.defenseClass,
      o.transforms.join("|"),
      o.injectionSucceeded,
      o.turns,
      o.latencyMs,
      o.toolCallsAttempted.map((c) => c.name).join("|"),
      o.toolCallsExecuted.map((c) => c.name).join("|"),
      o.error ?? "",
    ]),
  );
  writeFileSync(csvPath, [header, ...rows].join("\n"));

  const jsonPath = join(dir, `outcomes-${stamp}.json`);
  writeFileSync(jsonPath, JSON.stringify(outcomes, null, 2));

  // Tidy per-(model, config) summary, scale on the x-axis — the file you plot.
  const matrixPath = join(dir, `matrix-${stamp}.csv`);
  writeFileSync(matrixPath, tidyCsv(cells));

  console.log(`\nWrote ${csvPath}`);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${matrixPath}`);
}

function csvRow(fields: Array<string | number | boolean>): string {
  return fields.map(csvCell).join(",");
}

function csvCell(field: string | number | boolean): string {
  const s = String(field);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function positionalArgs(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
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
  return e instanceof Error ? e.message : String(e);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
