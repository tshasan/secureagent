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

import type { ChatClient, ChatMessage, ChatRequest, ChatResponse, ChatToolCall } from "./llm.js";

const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

// OpenRouter speaks the OpenAI chat-completions wire format, which differs from
// the harness's internal (Ollama-shaped) protocol in three ways this client
// reconciles:
//   1. tool-call arguments are a JSON *string*, not a parsed object;
//   2. every `tool` message must carry the `tool_call_id` it answers;
//   3. sampling fields are top-level, not nested under `options`.
// The agent loop never sees any of this — it gets the same ChatResponse it would
// from Ollama.
type OAToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OAMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OAToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

type OAResponse = {
  model?: string;
  choices?: Array<{
    message?: { role?: string; content?: string | null; tool_calls?: OAToolCall[] };
  }>;
};

export class OpenRouterClient implements ChatClient {
  private readonly baseUrl: string;

  constructor(
    private readonly apiKey: string,
    baseUrl: string = DEFAULT_BASE_URL,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: toOpenAIMessages(req.messages),
      stream: false,
    };
    if (req.tools && req.tools.length > 0) {
      body["tools"] = req.tools; // identical {type, function:{name,description,parameters}} shape
      body["tool_choice"] = "auto";
    }
    const opts = req.options;
    if (opts) {
      if (opts.temperature !== undefined) body["temperature"] = opts.temperature;
      if (opts.top_p !== undefined) body["top_p"] = opts.top_p;
      if (opts.top_k !== undefined) body["top_k"] = opts.top_k;
      if (opts.seed !== undefined) body["seed"] = opts.seed;
      if (opts.num_predict !== undefined) body["max_tokens"] = opts.num_predict;
    }
    if (req.format === "json") body["response_format"] = { type: "json_object" };

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        // Optional attribution headers OpenRouter surfaces in its dashboard.
        "x-title": "secureagent",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 400)}`);
    }
    const data = (await res.json()) as OAResponse;
    return fromOpenAIResponse(req.model, data);
  }

  // OpenRouter exposes the authenticated key's metadata here; a 200 means the
  // key is valid and the gateway is reachable.
  async ping(): Promise<void> {
    const res = await fetch(`${this.baseUrl}/key`, {
      headers: { authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenRouter ping failed: ${res.status}`);
  }

  // Models on a hosted gateway are pulled on demand server-side, so there is
  // nothing to provision locally.
  async ensureModel(_model: string, _log: (msg: string) => void): Promise<void> {
    return;
  }
}

// Translate the internal message log to OpenAI shape. The internal format omits
// tool-call ids, so we mint them sequentially and pair each `tool` reply with
// the call it answers in FIFO order — the agent loop appends exactly one tool
// reply per tool call, in order, so the pairing is unambiguous.
function toOpenAIMessages(messages: ChatMessage[]): OAMessage[] {
  const pending: string[] = [];
  let counter = 0;
  return messages.map((m): OAMessage => {
    if (m.role === "assistant") {
      if (m.tool_calls && m.tool_calls.length > 0) {
        const tool_calls = m.tool_calls.map((tc): OAToolCall => {
          const id = `call_${counter++}`;
          pending.push(id);
          return {
            id,
            type: "function",
            function: { name: tc.function.name, arguments: JSON.stringify(tc.function.arguments) },
          };
        });
        return { role: "assistant", content: m.content || null, tool_calls };
      }
      return { role: "assistant", content: m.content };
    }
    if (m.role === "tool") {
      const tool_call_id = pending.shift() ?? `call_${counter++}`;
      return { role: "tool", content: m.content, tool_call_id };
    }
    if (m.role === "system") return { role: "system", content: m.content };
    return { role: "user", content: m.content };
  });
}

function fromOpenAIResponse(fallbackModel: string, data: OAResponse): ChatResponse {
  const msg = data.choices?.[0]?.message ?? {};
  const toolCalls: ChatToolCall[] = (msg.tool_calls ?? []).map((tc) => ({
    function: { name: tc.function.name, arguments: parseArgs(tc.function.arguments) },
  }));
  const message: ChatMessage = { role: "assistant", content: msg.content ?? "" };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return { model: data.model ?? fallbackModel, message, done: true };
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
