// The adapter conformance suite, run against Postgres.
//
// The process runs in a time zone with daylight saving and, for year 1, an offset in
// seconds (local mean time), so that any conversion that depends on the process's zone
// shows up here even on a machine set to UTC. Node reads TZ again when it changes.
process.env.TZ = "Europe/Amsterdam";

import { runAdapterConformance } from "../../core/test/conformance/adapter/index.js";
import { POSTGRES_PROFILE } from "./profile.js";

runAdapterConformance(POSTGRES_PROFILE);
