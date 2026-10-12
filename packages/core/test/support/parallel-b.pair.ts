import { test } from "vitest";
import { runParallelPeer } from "./parallel.js";

test("runs alongside parallel-a.pair.ts without sharing any state", () => runParallelPeer("b", 5));
