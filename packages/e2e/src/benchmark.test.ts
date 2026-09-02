// oxlint-disable vitest/max-expects
import fs from "node:fs";

import { describe, expect, test } from "vite-plus/test";

import {
  clearAllScenarioBenchmarks,
  createBenchmarkTracker,
  formatBenchmarkTable,
  getBenchmarkRunDirectory,
  loadAllScenarioBenchmarks,
  normalizeRoute,
  registerScenarioBenchmark,
} from "./benchmark.ts";

describe("benchmark module", () => {
  describe("route normalization", () => {
    test("normalizes contract metadata endpoint", () => {
      const url =
        "https://api.hiro.so/extended/v1/contract/SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles";
      expect(normalizeRoute("GET", url)).toBe("GET /extended/v1/contract/:contract_id");
    });

    test("normalizes principal transactions endpoint with query params", () => {
      const url =
        "https://api.hiro.so/extended/v3/principals/SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles/transactions?cursor=47784:0:0&limit=50";
      expect(normalizeRoute("GET", url)).toBe(
        "GET /extended/v3/principals/:principal/transactions",
      );
    });

    test("normalizes transaction events endpoint", () => {
      const url =
        "https://api.hiro.so/extended/v3/transactions/0xc5c2b57b01170927608158110f634def41af4eb2a2ec3bfd71d8af6f0deac4ae/events?limit=50";
      expect(normalizeRoute("GET", url)).toBe("GET /extended/v3/transactions/:tx_id/events");
    });

    test("normalizes transaction by tx_id endpoint", () => {
      const url =
        "https://api.hiro.so/extended/v3/transactions/0xc5c2b57b01170927608158110f634def41af4eb2a2ec3bfd71d8af6f0deac4ae";
      expect(normalizeRoute("GET", url)).toBe("GET /extended/v3/transactions/:tx_id");
    });

    test("normalizes block by height or hash endpoint", () => {
      const url = "https://api.hiro.so/extended/v2/blocks/47784";
      expect(normalizeRoute("GET", url)).toBe("GET /extended/v2/blocks/:height_or_hash");
    });

    test("normalizes block transactions endpoint", () => {
      const url = "https://api.hiro.so/extended/v3/blocks/47784/transactions";
      expect(normalizeRoute("GET", url)).toBe(
        "GET /extended/v3/blocks/:height_or_hash/transactions",
      );
    });

    test("normalizes smart-contract logs endpoint", () => {
      const url =
        "https://api.hiro.so/extended/v2/smart-contracts/SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles/logs?limit=100";
      expect(normalizeRoute("GET", url)).toBe("GET /extended/v2/smart-contracts/:contract_id/logs");
    });

    test("normalizes status endpoint", () => {
      expect(normalizeRoute("GET", "https://api.hiro.so/extended/v1/status")).toBe(
        "GET /extended/v1/status",
      );
      expect(normalizeRoute("GET", "https://api.hiro.so/extended")).toBe("GET /extended/v1/status");
    });

    test("normalizes read-only call-read endpoints", () => {
      const url1 =
        "https://api.hiro.so/v2/contracts/call-read/SP000000000000000000002Q6VF78/pox-3/get-burn-height";
      expect(normalizeRoute("POST", url1)).toBe(
        "POST /v2/contracts/call-read/:contract_address/:contract_name/:function_name",
      );

      const url2 =
        "https://api.hiro.so/v2/contracts/call-read/SP000000000000000000002Q6VF78.pox-3/get-burn-height";
      expect(normalizeRoute("POST", url2)).toBe(
        "POST /v2/contracts/call-read/:contract_id/:function_name",
      );
    });

    test("normalizes relative paths and handles method casing", () => {
      expect(normalizeRoute("get", "/extended/v2/blocks/12345")).toBe(
        "GET /extended/v2/blocks/:height_or_hash",
      );
    });
  });

  describe("benchmark tracker", () => {
    test("tallies calls, groups by endpoint, and sorts keys alphabetically", () => {
      const tracker = createBenchmarkTracker();

      tracker.recordCall(
        "GET",
        "https://api.hiro.so/extended/v3/principals/SP6P4/transactions?limit=50",
      );
      tracker.recordCall("GET", "https://api.hiro.so/extended/v1/contract/SP6P4.satoshibles");
      tracker.recordCall(
        "GET",
        "https://api.hiro.so/extended/v3/principals/SP6P4/transactions?cursor=1",
      );

      const summary = tracker.getSummary();
      expect(summary.totalCalls).toBe(3);
      expect(summary.endpoints).toStrictEqual({
        "GET /extended/v1/contract/:contract_id": 1,
        "GET /extended/v3/principals/:principal/transactions": 2,
      });

      // Keys must be in sorted order
      expect(Object.keys(summary.endpoints)).toStrictEqual([
        "GET /extended/v1/contract/:contract_id",
        "GET /extended/v3/principals/:principal/transactions",
      ]);
    });

    test("resets call counts", () => {
      const tracker = createBenchmarkTracker();
      tracker.recordCall("GET", "/extended/v1/status");
      expect(tracker.getSummary().totalCalls).toBe(1);

      tracker.reset();
      expect(tracker.getSummary()).toStrictEqual({
        totalCalls: 0,
        endpoints: {},
      });
    });
  });

  describe("scenario benchmark registry and table formatting", () => {
    test("registers scenarios in separate worker files and formats ASCII table with grand total", () => {
      clearAllScenarioBenchmarks();

      registerScenarioBenchmark("scenario-a", {
        totalCalls: 3,
        endpoints: {
          "GET /extended/v1/contract/:contract_id": 1,
          "GET /extended/v3/principals/:principal/transactions": 2,
        },
      });

      registerScenarioBenchmark("scenario-b", {
        totalCalls: 5,
        endpoints: {
          "GET /extended/v2/blocks/:height_or_hash": 5,
        },
      });

      // Verify isolated files are written to the unique run directory
      const runDir = getBenchmarkRunDirectory();
      expect(fs.existsSync(runDir)).toBe(true);
      const workerFiles = fs.readdirSync(runDir);
      expect(workerFiles.length).toBeGreaterThanOrEqual(2);

      const loaded = loadAllScenarioBenchmarks();
      expect(loaded.size).toBe(2);

      const table = formatBenchmarkTable(loaded);
      expect(table).toContain("E2E API Call-Count Benchmark Summary");
      expect(table).toContain("scenario-a");
      expect(table).toContain("scenario-b");
      expect(table).toContain("Grand Total");
      expect(table).toContain("8");

      // Verify table uses ASCII-only characters (+, -, |) and no Unicode box-drawing chars
      expect(table).toContain("+");
      expect(table).toContain("-");
      expect(table).toContain("|");
      expect(table).not.toContain("┌");
      expect(table).not.toContain("─");
      expect(table).not.toContain("│");
      expect(table).not.toContain("├");
      expect(table).not.toContain("└");

      clearAllScenarioBenchmarks();
      expect(loadAllScenarioBenchmarks().size).toBe(0);
      expect(fs.existsSync(runDir)).toBe(false);
    });

    test("returns empty string when no benchmarks are registered", () => {
      expect(formatBenchmarkTable(new Map())).toBe("");
    });
  });
});
