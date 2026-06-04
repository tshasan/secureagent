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

// The scale axis for the cross-scale study. We keep one model family on the
// sweep by default (qwen2.5, 0.5B -> 7B) so the only thing changing across the
// axis is parameter count, not tokenizer / training recipe / tool-calling
// convention. Mixing families confounds "scale" with "which lab made it".
export const DEFAULT_SWEEP = [
  "qwen2.5:0.5b",
  "qwen2.5:1.5b",
  "qwen2.5:3b",
  "qwen2.5:7b",
] as const;

// Parameter count in billions, parsed from the size token of an Ollama tag.
// "qwen2.5:7b" -> 7, "qwen2.5:0.5b" -> 0.5, "llama3.1:8b" -> 8,
// "llama3.2:3b-instruct-q4_K_M" -> 3. Returns NaN if there is no size token,
// in which case the model still runs but sorts to the end of the scale axis.
export function parseParamsB(tag: string): number {
  const seg = tag.includes(":") ? tag.slice(tag.lastIndexOf(":") + 1) : tag;
  const m = seg.match(/(\d+(?:\.\d+)?)b/i);
  return m ? Number.parseFloat(m[1]!) : NaN;
}

// Ascending by parameter count. Unknown sizes (NaN) sort last so a tag we
// cannot parse never silently anchors the small end of the curve.
export function orderByScale(models: readonly string[]): string[] {
  return [...models].sort((a, b) => {
    const pa = parseParamsB(a);
    const pb = parseParamsB(b);
    if (Number.isNaN(pa) && Number.isNaN(pb)) return a.localeCompare(b);
    if (Number.isNaN(pa)) return 1;
    if (Number.isNaN(pb)) return -1;
    return pa - pb;
  });
}

// Sweep selection precedence: explicit positional args > SECUREAGENT_MODELS >
// SECUREAGENT_MODEL (back-compat single tag) > DEFAULT_SWEEP. Duplicates are
// dropped, order is preserved, then the caller sorts by scale for reporting.
export function resolveSweep(
  positional: string[],
  env: { models: string | undefined; model: string | undefined },
): string[] {
  const fromList = (s: string | undefined): string[] =>
    (s ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter((x) => x.length > 0);

  let chosen: string[];
  if (positional.length > 0) chosen = positional;
  else if (fromList(env.models).length > 0) chosen = fromList(env.models);
  else if (env.model && env.model.trim().length > 0) chosen = [env.model.trim()];
  else chosen = [...DEFAULT_SWEEP];

  return [...new Set(chosen)];
}
