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

// Provider-neutral chat protocol. The harness speaks this shape internally; each
// backend (Ollama, OpenRouter) translates it to and from its own wire format.
// The shape is deliberately Ollama-flavored — tool-call arguments are a parsed
// object, sampling lives under `options` — because that was the original
// in-tree representation; the OpenRouter client adapts to the OpenAI wire format
// so the agent loop and defenses never have to know which backend is in use.

import { OllamaClient } from "./ollama.js";
import { OpenRouterClient } from "./openrouter.js";

export type ChatRole = "system" | "user" | "assistant" | "tool";

export type ChatToolCall = {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
};

export type ChatMessage = {
  role: ChatRole;
  content: string;
  tool_calls?: ChatToolCall[];
};

export type ChatFunctionTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatOptions = {
  temperature?: number;
  num_predict?: number;
  seed?: number;
  top_k?: number;
  top_p?: number;
  num_ctx?: number;
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ChatFunctionTool[];
  stream: false;
  options?: ChatOptions;
  format?: "json";
};

export type ChatResponse = {
  model: string;
  message: ChatMessage;
  done: boolean;
};

// The single surface the agent loop and runner depend on. A backend must be
// able to answer a chat turn, prove it is reachable, and make a model available
// (a pull for Ollama, a no-op for a hosted gateway).
export interface ChatClient {
  chat(req: ChatRequest): Promise<ChatResponse>;
  ping(): Promise<void>;
  ensureModel(model: string, log: (msg: string) => void): Promise<void>;
}

export type ProviderName = "ollama" | "openrouter";

export type ProviderEnv = {
  provider?: string | undefined;
  ollamaHost?: string | undefined;
  openrouterKey?: string | undefined;
  openrouterBaseUrl?: string | undefined;
};

// Pick the backend. An explicit SECUREAGENT_PROVIDER always wins; otherwise the
// mere presence of an OpenRouter key means the user wants the gateway. With
// neither set we default to local Ollama, so the existing local workflow is
// unchanged for anyone who has not opted in.
export function resolveProvider(env: ProviderEnv): ProviderName {
  const explicit = env.provider?.trim().toLowerCase();
  if (explicit === "ollama" || explicit === "openrouter") return explicit;
  if (explicit) {
    throw new Error(`Unknown SECUREAGENT_PROVIDER "${env.provider}". Use "ollama" or "openrouter".`);
  }
  return env.openrouterKey && env.openrouterKey.trim().length > 0 ? "openrouter" : "ollama";
}

export function createClient(provider: ProviderName, env: ProviderEnv): ChatClient {
  if (provider === "openrouter") {
    const key = env.openrouterKey?.trim();
    if (!key) {
      throw new Error("OPENROUTER_API_KEY is required when SECUREAGENT_PROVIDER=openrouter.");
    }
    return new OpenRouterClient(key, env.openrouterBaseUrl?.trim() || undefined);
  }
  return new OllamaClient(normalizeHost(env.ollamaHost?.trim() || "http://127.0.0.1:11434"));
}

// A human-readable endpoint for the run header, per provider.
export function providerEndpoint(provider: ProviderName, env: ProviderEnv): string {
  if (provider === "openrouter") {
    return env.openrouterBaseUrl?.trim() || "https://openrouter.ai/api/v1";
  }
  return normalizeHost(env.ollamaHost?.trim() || "http://127.0.0.1:11434");
}

function normalizeHost(h: string): string {
  return /^https?:\/\//.test(h) ? h : `http://${h}`;
}
