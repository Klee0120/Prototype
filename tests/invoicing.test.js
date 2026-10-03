const test = require("node:test");
const assert = require("node:assert/strict");

const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

test("Financials > Invoicing: queue of work-complete WOMs not yet fully invoiced", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);

  await t.test("a WOM with no work-completed signal never appears in the queue", async () => {
    const res = await server.call("GET", "/api/woms/invoicing-queue", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(!res.body.some((w) => w.code === "WOM-4502"), "WOM-4502 has no source_work_completed set yet");
  });

  await t.test("once work is marked complete, the WOM shows up needing all three requirements", async () => {
    raw.prepare("UPDATE woms SET source_work_completed = 1 WHERE code = ?").run("WOM-4502");

    const res = await server.call("GET", "/api/woms/invoicing-queue", { userId: "ADMIN" });
    const item = res.body.find((w) => w.code === "WOM-4502");
    assert.ok(item, "expected WOM-4502 in the invoicing queue");
    assert.deepEqual(item.missingRequirements.sort(), ["Batch #", "Invoice #", "Invoice document"].sort());
    assert.equal(item.hasInvoiceDocument, false);
  });

  await t.test("invoice #/batch # arriving (e.g. via sync) narrows down what's still missing", async () => {
    raw.prepare("UPDATE woms SET invoice_number = ?, batch_number = ? WHERE code = ?").run("INV-1001", "B-77", "WOM-4502");

    const res = await server.call("GET", "/api/woms/invoicing-queue", { userId: "ADMIN" });
    const item = res.body.find((w) => w.code === "WOM-4502");
    assert.ok(item, "still outstanding -- no invoice document attached yet");
    assert.deepEqual(item.missingRequirements, ["Invoice document"]);
    assert.equal(item.invoiceNumber, "INV-1001");
    assert.equal(item.batchNumber, "B-77");
  });

  await t.test("attaching the actual invoice document drops the WOM off the queue", async () => {
    const upload = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "wom", relatedId: "WOM-4502", category: "invoice" },
      fileName: "toyota-invoice.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(upload.status, 201, "the 'invoice' category should be a valid WOM document category");

    const res = await server.call("GET", "/api/woms/invoicing-queue", { userId: "ADMIN" });
    assert.ok(!res.body.some((w) => w.code === "WOM-4502"), "fully invoiced -- should no longer appear");
  });

  await t.test("a cancelled or closed WOM is never surfaced even if work-complete with nothing else on file", async () => {
    raw.prepare("UPDATE woms SET source_work_completed = 1 WHERE code = ?").run("WOM-4390"); // seeded as status: closed
    const res = await server.call("GET", "/api/woms/invoicing-queue", { userId: "ADMIN" });
    assert.ok(!res.body.some((w) => w.code === "WOM-4390"), "a closed WOM's invoicing is done by definition");
  });

  await t.test("a technician cannot read the invoicing queue", async () => {
    const res = await server.call("GET", "/api/woms/invoicing-queue", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  // The WOM Documents tab's quote/quote_revision categories were silently
  // rejected before this feature's fix to CATEGORY_BY_RELATED.wom -- covered
  // here since it's the same line this feature touched.
  await t.test("quote and quote_revision uploads to a WOM are also accepted", async () => {
    const quote = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "wom", relatedId: "WOM-4471", category: "quote" },
      fileName: "vendor-quote.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(quote.status, 201);

    const revision = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "wom", relatedId: "WOM-4471", category: "quote_revision" },
      fileName: "revised-quote.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(revision.status, 201);
  });
});
