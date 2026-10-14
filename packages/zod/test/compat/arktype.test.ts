import { type } from "arktype";
import { runScenarios } from "./scenarios.js";

runScenarios("ArkType", {
  signup: type({ email: "string.email", "age?": "number.integer >= 13 | null" }),
  settings: type({ settings: type({ theme: "'light' | 'dark'" }).or("null") }),
  schedule: type({ startsAt: "Date", endsAt: "Date" }).narrow(
    (input, ctx) =>
      input.endsAt > input.startsAt || ctx.reject({ path: ["endsAt"], message: "must be after start" }),
  ),
  normalizeEmail: type({ email: type("string").pipe((email) => email.trim().toLowerCase()) }),
  email: type("string.email"),
});
