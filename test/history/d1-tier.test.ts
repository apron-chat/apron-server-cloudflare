import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1HistoryTier } from "../../src/history/d1";
import { describeHistoryTier } from "./conformance/history-tier";

// The tier conformance suite on D1 (miniflare's local
// database, HISTORY_D1), each tier in a table of its own.
let tables = 0;
describeHistoryTier("D1HistoryTier", () => new D1HistoryTier("recent", env.HISTORY_D1!, { table: `conformance_${Date.now()}_${(tables += 1)}` }), { describe, it, expect });
