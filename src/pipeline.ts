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

import type { ChatClient } from "./llm.js";
import type { ToolCall, ToolSpec } from "./types.js";

export type StaticCtx = Record<string, never>;

export type RequestCtx = {
  client: ChatClient;
  model: string;
  seed: number;
};

export type ExecCtx = Record<string, never>;

export type ToolCallVerdict =
  | { kind: "allow"; call: ToolCall }
  | { kind: "reject"; reason: string };

export type Transform = {
  name: string;
  augmentSystem?: (parts: string[], ctx: StaticCtx) => string[];
  augmentTools?: (tools: ToolSpec[], ctx: StaticCtx) => ToolSpec[];
  rewriteUserInput?: (input: string, ctx: RequestCtx) => Promise<string> | string;
  validateToolCall?: (call: ToolCall, ctx: ExecCtx) => ToolCallVerdict;
};

export class Pipeline {
  constructor(private readonly transforms: readonly Transform[]) {}

  buildSystem(base: string, ctx: StaticCtx): string {
    let parts: string[] = [base];
    for (const t of this.transforms) {
      if (t.augmentSystem) parts = t.augmentSystem(parts, ctx);
    }
    return parts.join("\n\n");
  }

  buildTools(base: ToolSpec[], ctx: StaticCtx): ToolSpec[] {
    let tools: ToolSpec[] = base;
    for (const t of this.transforms) {
      if (t.augmentTools) tools = t.augmentTools(tools, ctx);
    }
    return tools;
  }

  async rewriteUserInput(input: string, ctx: RequestCtx): Promise<string> {
    let current = input;
    for (const t of this.transforms) {
      if (t.rewriteUserInput) {
        current = await t.rewriteUserInput(current, ctx);
      }
    }
    return current;
  }

  validateToolCall(call: ToolCall, ctx: ExecCtx): ToolCallVerdict {
    let current = call;
    for (const t of this.transforms) {
      if (t.validateToolCall) {
        const v = t.validateToolCall(current, ctx);
        if (v.kind === "reject") return v;
        current = v.call;
      }
    }
    return { kind: "allow", call: current };
  }

  names(): string[] {
    return this.transforms.map((t) => t.name);
  }
}
