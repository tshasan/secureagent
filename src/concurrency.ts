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

// Run `fn` over `items` with at most `limit` in flight at once, returning
// results in input order regardless of completion order. A fixed pool of
// workers pulls from a shared cursor — O(limit) live promises instead of one
// per item, so a large sweep never materialises thousands of pending tasks.
//
// Concurrency changes only scheduling, never a single run's inputs: each task
// gets its own messages and a fixed seed, so verdicts are identical to running
// serially. Only wall-clock latency and completion order differ.
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const workers = Math.max(1, Math.min(Math.floor(limit), items.length));
  let cursor = 0;

  const run = async (): Promise<void> => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };

  await Promise.all(Array.from({ length: workers }, run));
  return results;
}
