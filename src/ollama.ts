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

import type { ChatClient, ChatRequest, ChatResponse } from "./llm.js";

export class OllamaClient implements ChatClient {
  constructor(
    private readonly host: string,
    private readonly keepAlive: string | number = "10m",
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `keep_alive` holds the model resident between the back-to-back calls of
      // a sweep, so they skip reload churn. It affects latency only, not output.
      body: JSON.stringify({ keep_alive: this.keepAlive, ...req }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 400)}`);
    }
    return (await res.json()) as ChatResponse;
  }

  async ping(): Promise<void> {
    const res = await fetch(`${this.host}/api/tags`, { method: "GET" });
    if (!res.ok) throw new Error(`Ollama ping failed: ${res.status}`);
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.host}/api/tags`);
    if (!res.ok) throw new Error(`list models: ${res.status}`);
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    return (body.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string");
  }

  async pull(model: string, onStatus: (status: string) => void): Promise<void> {
    const res = await fetch(`${this.host}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: true }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`pull ${model}: ${res.status} ${await res.text().catch(() => "")}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let lastStatus = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line) as {
            status?: string;
            error?: string;
            completed?: number;
            total?: number;
          };
          if (obj.error) throw new Error(`ollama pull: ${obj.error}`);
          const status = obj.status ?? "";
          if (status && status !== lastStatus) {
            onStatus(status);
            lastStatus = status;
          }
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("ollama pull:")) throw e;
        }
      }
    }
  }

  async ensureModel(model: string, log: (msg: string) => void): Promise<void> {
    const have = await this.listModels();
    if (have.includes(model)) return;
    log(`Model ${model} is not pulled. Pulling...`);
    await this.pull(model, (status) => log(`  ${status}`));
    log(`Model ${model} ready.`);
  }
}
