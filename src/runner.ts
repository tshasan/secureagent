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

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./agent.js";
import { capabilityHandlesTransform } from "./defenses/capabilityHandles.js";
import { dualLlmTransform } from "./defenses/dualLlm.js";
import { typedContextTransform } from "./defenses/typedContext.js";
import { OllamaClient } from "./ollama.js";
import type { Transform } from "./pipeline.js";
import { injectionSucceeded } from "./scoring.js";
import type { Attack, AttackOutcome } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_ROOT = join(__dirname, "..");
const RESULTS_DIR = process.env["SECUREAGENT_RESULTS_DIR"] ?? join(process.cwd(), "results");

const ARG_MODEL = positionalArg(process.argv.slice(2));
const MODEL = ARG_MODEL ?? process.env["SECUREAGENT_MODEL"] ?? "llama3.2:3b";
const HOST = normalizeHost(process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434");
const SEED = parseSeed(process.env["SECUREAGENT_SEED"]);
const MAX_TURNS = 6;

type Preset = {
  name: string;
  build: () => Transform[];
};

const PRESETS: Preset[] = [
  { name: "baseline", build: () => [] },
  { name: "typed_only", build: () => [typedContextTransform] },
  { name: "caps_only", build: () => [capabilityHandlesTransform()] },
  { name: "dual_only", build: () => [dualLlmTransform] },
  { name: "typed+caps", build: () => [typedContextTransform, capabilityHandlesTransform()] },
  {
    name: "all_on",
    build: () => [dualLlmTransform, typedContextTransform, capabilityHandlesTransform()],
  },
];

async function main(): Promise<void> {
  const client = new OllamaClient(HOST);
  try {
    await client.ping();
  } catch (e) {
    console.error(`Cannot reach Ollama at ${HOST}: ${errString(e)}`);
    console.error("Start it with `ollama serve` or enter the nix dev shell.");
    process.exit(1);
  }

  try {
    await client.ensureModel(MODEL, (msg) => console.log(msg));
  } catch (e) {
    console.error(`Failed to ensure model ${MODEL}: ${errString(e)}`);
    process.exit(1);
  }

  const filter = (process.env["SECUREAGENT_CONFIGS"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const presets = filter.length > 0 ? PRESETS.filter((p) => filter.includes(p.name)) : PRESETS;

  const attacks = loadAttacks();
  const outcomes: AttackOutcome[] = [];
  let i = 0;
  const total = presets.length * attacks.length;

  console.log(`Model: ${MODEL}`);
  console.log(`Host:  ${HOST}`);
  console.log(`Seed:  ${SEED}`);
  console.log(`Configs: ${presets.map((p) => p.name).join(", ")}`);
  console.log(`Attacks: ${attacks.length}\n`);

  for (const preset of presets) {
    for (const atk of attacks) {
      i++;
      const transforms = preset.build();
      const t0 = Date.now();
      const run = await runAgent(
        client,
        { model: MODEL, maxTurns: MAX_TURNS, seed: SEED, transforms },
        atk.userInput,
      );
      const latencyMs = Date.now() - t0;
      const succeeded = injectionSucceeded(atk, run.toolCallsExecuted);
      const outcome: AttackOutcome = {
        attackId: atk.id,
        configName: preset.name,
        transforms: transforms.map((t) => t.name),
        injectionSucceeded: succeeded,
        taskCompleted: !run.error,
        toolCallsAttempted: run.toolCallsAttempted,
        toolCallsExecuted: run.toolCallsExecuted,
        turns: run.turns,
        latencyMs,
        ...(run.error ? { error: run.error } : {}),
      };
      outcomes.push(outcome);
      console.log(
        `[${i}/${total}] ${preset.name.padEnd(12)} ${atk.id.padEnd(24)} ` +
          `${succeeded ? "INJECTED" : "blocked "} ${latencyMs}ms` +
          (run.error ? ` (error: ${run.error})` : ""),
      );
    }
  }

  writeOutputs(outcomes);
  printSummary(outcomes, presets.map((p) => p.name));
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
    "attack_id",
    "config",
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
      o.attackId,
      o.configName,
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

  console.log(`\nWrote ${csvPath}`);
  console.log(`Wrote ${jsonPath}`);
}

function printSummary(outcomes: AttackOutcome[], names: string[]): void {
  console.log("\nInjection success rate by config:");
  for (const name of names) {
    const rows = outcomes.filter((o) => o.configName === name);
    const n = rows.length;
    const hits = rows.filter((o) => o.injectionSucceeded).length;
    const pct = n === 0 ? 0 : Math.round((100 * hits) / n);
    console.log(`  ${name.padEnd(12)} ${hits}/${n}  (${pct}%)`);
  }
}

function normalizeHost(h: string): string {
  return /^https?:\/\//.test(h) ? h : `http://${h}`;
}

function positionalArg(args: string[]): string | undefined {
  for (const a of args) {
    if (!a.startsWith("-")) return a;
  }
  return undefined;
}

function parseSeed(raw: string | undefined): number {
  if (!raw) return 42;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 42;
}

function errString(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
