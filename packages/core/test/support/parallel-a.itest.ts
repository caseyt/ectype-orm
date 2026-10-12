import { test } from "vitest";
import { runParallelPeer } from "./parallel.js";

test("runs alongside parallel-b.itest.ts without sharing any state", () => runParallelPeer("a", 3));
