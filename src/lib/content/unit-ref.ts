import type { UnitRef } from "@/lib/progress/progress";
import type { Unit } from "./loader";
import { PROVIDERS } from "./schema";

/** The slice of a unit that progress logic needs; safe to send to the browser. */
export function toUnitRef(unit: Unit): UnitRef {
  return {
    id: unit.meta.id,
    prerequisites: unit.meta.prerequisites,
    providers: PROVIDERS.filter((p) => unit.meta.providers[p]),
    labs: unit.labs.map((lab) => ({ id: lab.id, provider: lab.provider })),
  };
}
