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

export type SamplingOptions = {
  temperature: number;
  top_k: number;
  top_p: number;
  seed: number;
  num_ctx: number;
  num_predict: number;
};

export function deterministicSampling(seed: number, numPredict = 512): SamplingOptions {
  return {
    temperature: 0,
    top_k: 1,
    top_p: 1,
    seed,
    num_ctx: 4096,
    num_predict: numPredict,
  };
}
