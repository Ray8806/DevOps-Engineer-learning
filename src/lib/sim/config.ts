import type { Sim } from "@/lib/content/schema";
import type { SimConfig } from "./engine";

/** The engine settings for one step of a lesson simulation. */
export function stepConfig(sim: Sim, index: number): SimConfig {
  const step = sim.steps[index];
  return {
    kinds: sim.kinds,
    sequence: sim.sequence,
    requestsPerSecond: sim.requestsPerSecond,
    algorithm: step.algorithm,
    servers: step.servers,
    healthCheck: step.healthCheck,
  };
}
