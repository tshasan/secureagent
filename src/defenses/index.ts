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

import type { DefenseDef } from "../pipeline.js";
import type { DefenseClass } from "../types.js";
import { capabilityHandles } from "./capabilityHandles.js";
import { dualLlm } from "./dualLlm.js";
import { signedContext } from "./signedContext.js";
import { typedContext } from "./typedContext.js";

// The defense registry. Adding a defense is: write the file exporting a
// DefenseDef, then add it to this array. Everything downstream (presets,
// defenseClass derivation, CSV columns) keys off the registry.
const DEFS: DefenseDef[] = [typedContext, dualLlm, signedContext, capabilityHandles];

export const DEFENSES: Record<string, DefenseDef> = Object.fromEntries(
  DEFS.map((d) => [d.id, d]),
);

export function getDefense(id: string): DefenseDef {
  const def = DEFENSES[id];
  if (!def) {
    throw new Error(`Unknown defense id "${id}". Known: ${Object.keys(DEFENSES).join(", ")}`);
  }
  return def;
}

// A preset is a named list of defense ids; its defenseClass is *derived* from
// the constituents so it can never drift from what the transforms actually do.
// Empty -> "none"; one class -> that class; spanning both -> "mixed".
export function classOf(ids: readonly string[]): DefenseClass {
  const classes = new Set(ids.map((id) => getDefense(id).defenseClass));
  if (classes.size === 0) return "none";
  if (classes.size > 1) return "mixed";
  return [...classes][0]!;
}
