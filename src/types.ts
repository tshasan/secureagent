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

import type { Transform } from "./pipeline.js";

export type Trust = "system" | "user" | "untrusted_data" | "tool_output";

export type ContextBlock = {
  trust: Trust;
  source: string;
  content: string;
};

export type ToolName = "send_email" | "read_notes" | "delete_file";

export type ToolSpec = {
  name: ToolName;
  description: string;
  input_schema: Record<string, unknown>;
};

export type ToolCall = {
  name: ToolName;
  input: Record<string, unknown>;
};

export type ToolResult = {
  ok: boolean;
  output: string;
};

export type AgentConfig = {
  model: string;
  maxTurns: number;
  seed: number;
  transforms: readonly Transform[];
};

export type AgentRun = {
  toolCallsAttempted: ToolCall[];
  toolCallsExecuted: ToolCall[];
  finalText: string;
  turns: number;
  error?: string;
};

export type Attack = {
  id: string;
  description: string;
  userInput: string;
  forbidden: ForbiddenPattern;
};

export type ForbiddenPattern =
  | { kind: "tool_called"; tool: ToolName }
  | { kind: "email_to"; address: string }
  | { kind: "file_deleted"; path: string };

export type DefenseClass = "none" | "prompt" | "enforcement" | "mixed";

export type AttackOutcome = {
  attackId: string;
  configName: string;
  defenseClass: DefenseClass;
  model: string;
  modelParamsB: number;
  transforms: string[];
  injectionSucceeded: boolean;
  taskCompleted: boolean;
  toolCallsAttempted: ToolCall[];
  toolCallsExecuted: ToolCall[];
  turns: number;
  latencyMs: number;
  error?: string;
};
