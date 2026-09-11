import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const hardeningSource = readFileSync(
  new URL("../extension/lib/integrity-hardening.js", import.meta.url),
  "utf8"
);
const complianceSource = readFileSync(
  new URL("../extension/lib/compliance.js", import.meta.url),
  "utf8"
);

function createContext() {
  const storage = {};
  const AIExporter = {
    platform: { id: "chatgpt" },
    browser: {
      async storageGet(keys) {
        return Object.fromEntries(keys.map((key) => [key, storage[key]]));
      },
      async storageSet(items) {
        Object.assign(storage, structuredClone(items));
      },
    },
    exporter: {
      async getLastExportTime() {
        return 0;
      },
      async filterConversations(list, options) {
        let filtered = list;
        if (options.searchQuery) {
          const query = options.searchQuery.toLowerCase();
          filtered = filtered.filter((item) =>
            (item.title || "").toLowerCase().includes(query)
          );
        }
        if (options.scope === "new") {
          const lastExport = await this.getLastExportTime();
          filtered = filtered.filter((item) => {
            const ts = item.update_time || item.create_time;
            return ts == null || ts > lastExport;
          });
        }
        return filtered;
      },
      async run(options = {}) {
        if (this._testList) {
          await this.filterConversations(this._testList, options);
        }
        return this._testRunResult;
      },
      _testList: null,
      _testRunResult: { success: true, count: 1, failed: 0, errors: [] },
    },
  };

  const context = vm.createContext({
    AIExporter,
    crypto: globalThis.crypto,
    TextEncoder,
    Uint8Array,
    Date,
    Set,
    String,
    Number,
    structuredClone,
  });
  vm.runInContext(hardeningSource, context);
  vm.runInContext(complianceSource, context);
  return { AIExporter, storage };
}

test("compliance SHA-256 is canonical lowercase hex", async () => {
  const { AIExporter } = createContext();
  assert.equal(
    await AIExporter.compliance.sha256("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
  );
});

test("checkpoints are isolated by provider", async () => {
  const { AIExporter } = createContext();
  await AIExporter.exporter.saveExportCheckpoint({ lastSuccessfulExport: 100 }, "chatgpt");
  await AIExporter.exporter.saveExportCheckpoint({ lastSuccessfulExport: 200 }, "gemini");

  AIExporter.platform.id = "chatgpt";
  assert.equal(await AIExporter.exporter.getLastExportTime(), 100);
  AIExporter.platform.id = "gemini";
  assert.equal(await AIExporter.exporter.getLastExportTime(), 200);
});

test("failed conversations stay eligible for the next incremental export", async () => {
  const { AIExporter } = createContext();
  await AIExporter.exporter.saveExportCheckpoint(
    { lastSuccessfulExport: 100, failedConversationIds: ["old-failure"] },
    "chatgpt"
  );

  const filtered = await AIExporter.exporter.filterConversations(
    [
      { id: "old-failure", title: "retry", update_time: 50 },
      { id: "old-success", title: "old", update_time: 60 },
      { id: "new-chat", title: "new", update_time: 150 },
    ],
    { scope: "new", searchQuery: "" }
  );

  assert.deepEqual(
    Array.from(filtered, (item) => item.id).sort(),
    ["new-chat", "old-failure"].sort()
  );
});

test("a partial failure does not advance the checkpoint and is queued", async () => {
  const { AIExporter } = createContext();
  await AIExporter.exporter.saveExportCheckpoint({ lastSuccessfulExport: 100 }, "chatgpt");
  AIExporter.exporter._testRunResult = {
    success: true,
    count: 2,
    failed: 1,
    errors: [{ id: "failed-chat", error: "HTTP 500" }],
  };

  await AIExporter.exporter.run({ scope: "new" });
  const checkpoint = await AIExporter.exporter.getExportCheckpoint("chatgpt");
  assert.equal(checkpoint.lastSuccessfulExport, 100);
  assert.deepEqual(Array.from(checkpoint.failedConversationIds), ["failed-chat"]);
});

test("a complete bulk success advances the checkpoint and clears retried failures", async () => {
  const { AIExporter } = createContext();
  await AIExporter.exporter.saveExportCheckpoint(
    { lastSuccessfulExport: 100, failedConversationIds: ["retry-me"] },
    "chatgpt"
  );
  AIExporter.exporter._testList = [{ id: "retry-me", update_time: 50 }];
  AIExporter.exporter._testRunResult = {
    success: true,
    count: 1,
    failed: 0,
    errors: [],
  };

  await AIExporter.exporter.run({ scope: "new" });
  const checkpoint = await AIExporter.exporter.getExportCheckpoint("chatgpt");
  assert.ok(checkpoint.lastSuccessfulExport > 100);
  assert.deepEqual(Array.from(checkpoint.failedConversationIds), []);
});

test("partial exports never advance the bulk checkpoint", async () => {
  const { AIExporter } = createContext();
  await AIExporter.exporter.saveExportCheckpoint({ lastSuccessfulExport: 100 }, "chatgpt");
  AIExporter.exporter._testRunResult = {
    success: true,
    count: 1,
    failed: 0,
    errors: [],
  };

  await AIExporter.exporter.run({
    scope: "all",
    conversationIds: ["one-chat"],
  });
  const checkpoint = await AIExporter.exporter.getExportCheckpoint("chatgpt");
  assert.equal(checkpoint.lastSuccessfulExport, 100);
});
