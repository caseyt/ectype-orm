import { test } from "vitest";
import { runParallelPeer } from "./parallel.js";

test("runs alongside parallel-a.itest.ts without sharing any state", () => runParallelPeer("b", 5));
