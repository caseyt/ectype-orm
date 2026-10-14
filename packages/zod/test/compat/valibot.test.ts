import * as v from "valibot";
import { runScenarios } from "./scenarios.js";

runScenarios("Valibot", {
  signup: v.object({
    email: v.pipe(v.string(), v.email()),
    age: v.nullish(v.pipe(v.number(), v.integer(), v.minValue(13))),
  }),
  settings: v.object({ settings: v.nullable(v.object({ theme: v.picklist(["light", "dark"]) })) }),
  schedule: v.pipe(
    v.object({ startsAt: v.date(), endsAt: v.date() }),
    v.forward(
      v.check((input) => input.endsAt > input.startsAt, "must be after start"),
      ["endsAt"],
    ),
  ),
  normalizeEmail: v.object({ email: v.pipe(v.string(), v.trim(), v.toLowerCase()) }),
  email: v.pipe(v.string(), v.email()),
});
