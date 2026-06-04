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

import type { ToolCall } from "./types.js";

type Capability = {
  id: string;
  kind: "email_address" | "file_path";
  value: string;
};

export class CapabilityStore {
  private byId = new Map<string, Capability>();
  private counters = new Map<Capability["kind"], number>();

  issue(kind: Capability["kind"], value: string): string {
    const n = (this.counters.get(kind) ?? 0) + 1;
    this.counters.set(kind, n);
    const id = `cap:${kind}:${n.toString().padStart(4, "0")}`;
    this.byId.set(id, { id, kind, value });
    return id;
  }

  list(kind: Capability["kind"]): Array<{ handle: string; label: string }> {
    const out: Array<{ handle: string; label: string }> = [];
    for (const cap of this.byId.values()) {
      if (cap.kind === kind) {
        out.push({ handle: cap.id, label: labelFor(cap) });
      }
    }
    return out;
  }

  resolve(handle: string): Capability | undefined {
    return this.byId.get(handle);
  }
}

function labelFor(cap: Capability): string {
  if (cap.kind === "email_address") {
    const [, domain] = cap.value.split("@");
    return `contact at ${domain ?? "unknown"}`;
  }
  return cap.value.split("/").pop() ?? cap.value;
}

export function rewriteCallThroughCapabilities(
  call: ToolCall,
  store: CapabilityStore,
): { call: ToolCall; rejected?: string } {
  const input = { ...call.input };

  if (call.name === "send_email") {
    const to = String(input["to"] ?? "");
    if (!to.startsWith("cap:email_address:")) {
      return {
        call,
        rejected: `send_email refused: "to" must be a capability handle, got "${to}".`,
      };
    }
    const cap = store.resolve(to);
    if (!cap || cap.kind !== "email_address") {
      return { call, rejected: `send_email refused: unknown handle "${to}".` };
    }
    input["to"] = cap.value;
  }

  if (call.name === "delete_file") {
    const path = String(input["path"] ?? "");
    if (!path.startsWith("cap:file_path:")) {
      return {
        call,
        rejected: `delete_file refused: "path" must be a capability handle, got "${path}".`,
      };
    }
    const cap = store.resolve(path);
    if (!cap || cap.kind !== "file_path") {
      return { call, rejected: `delete_file refused: unknown handle "${path}".` };
    }
    input["path"] = cap.value;
  }

  return { call: { name: call.name, input } };
}
