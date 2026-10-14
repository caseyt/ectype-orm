import { z } from "zod";
import { runScenarios } from "./scenarios.js";

runScenarios("Zod", {
  signup: z.object({ email: z.string().email(), age: z.number().int().min(13).nullish() }),
  settings: z.object({ settings: z.object({ theme: z.enum(["light", "dark"]) }).nullable() }),
  schedule: z
    .object({ startsAt: z.date(), endsAt: z.date() })
    .refine((v) => v.endsAt > v.startsAt, { path: ["endsAt"], message: "must be after start" }),
  normalizeEmail: z.object({ email: z.string().trim().toLowerCase() }),
  email: z.string().email(),
});
