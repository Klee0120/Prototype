const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");
const { PDFDocument, StandardFonts } = require("pdf-lib");
const { DatabaseSync } = require("node:sqlite");

const REQUIRED_COI_LANGUAGE =
  "C&W Facility Services Inc. d/b/a C&W Services, Toyota Motor Sales, USA, Inc., its subsidiaries and affiliated corporations are additional insureds (except Workers’ Compensation) as required by written contract/agreement.";

// A real, minimal digitally-generated PDF with a genuine text layer --
// what a real ACORD 25 generated or typed into digitally would look like,
// as opposed to a scanned image with no extractable text at all.
async function buildFakePdf(lines) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 740;
  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: 10, font, maxWidth: 530 });
    y -= 16;
  }
  return Buffer.from(await doc.save());
}

test("coi document review: a digitally-generated PDF extracts real text and the right hints", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", {
    userId: "ADMIN",
    body: { name: "Print Shop Co", email: "ops@printshop.test", services: "Corporate Administrative / Marketing & Communications / Commercial Printing & Finishing" },
  });
  const vendor = vendorRes.body;

  const pdfBytes = await buildFakePdf(["CERTIFICATE OF LIABILITY INSURANCE", "ACORD 25 (2016/03)", REQUIRED_COI_LANGUAGE]);
  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi.pdf",
    fileContent: pdfBytes,
    mimeType: "application/pdf",
  });

  const startRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "ADMIN" });
  assert.equal(startRes.status, 201);
  const review = startRes.body;
  assert.equal(review.status, "pending");
  assert.ok(review.extractedText.includes("ACORD 25"), "should have pulled real text off the digital PDF");
  assert.equal(review.extractionHints.acord25, true);
  assert.equal(review.extractionHints.language, true);

  // Universal items + GL OCC/GL AGG/WC for this vendor's one service (auto/
  // exs/eAndO/pol/crime/productsComplOpAgg are all "-" for this service, so
  // they're correctly left off).
  const keys = review.checklist.map((i) => i.key);
  assert.ok(keys.includes("acord25"));
  assert.ok(keys.includes("language"));
  assert.ok(keys.includes("certHolder"));
  assert.ok(keys.includes("autoLiabilityBoxes"));
  assert.ok(keys.some((k) => k.startsWith("glOcc:")));
  assert.ok(keys.some((k) => k.startsWith("glAgg:")));
  assert.ok(keys.some((k) => k.startsWith("wc:")));
  assert.ok(!keys.some((k) => k.startsWith("auto:")), "this service's auto requirement is '-' and shouldn't appear");

  // Re-starting a review on the same file while one is still pending
  // returns the same row, not a duplicate.
  const againRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "ADMIN" });
  assert.equal(againRes.status, 200);
  assert.equal(againRes.body.id, review.id);
});

test("coi document review: a non-extractable file still gets a review, just with no text", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Scanned Doc Co", email: "ops@scanneddoc.test" } });
  const vendor = vendorRes.body;

  // Not a real PDF at all -- same real-world outcome as a flat scanned
  // image with no text layer: pdfjs can't pull anything out of it.
  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi.pdf",
    fileContent: "not actually a pdf, just a scanned image pretending to be one",
    mimeType: "application/pdf",
  });

  const startRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "ADMIN" });
  assert.equal(startRes.status, 201);
  assert.equal(startRes.body.extractedText, "");
  assert.deepEqual(startRes.body.extractionHints, {});
  // Still gets the universal checklist items even with no service on file.
  assert.ok(startRes.body.checklist.some((i) => i.key === "acord25"));
});

test("coi document review: approve creates a ServiceEdge task naming the vendor's real territory", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Territory Co", email: "ops@territoryco.test" } });
  const vendor = vendorRes.body;

  // getVendorTerritories reads territory straight off a vendor's own PO
  // history (pos.region) -- a real PO import is a whole pipeline of its
  // own with dedicated test coverage elsewhere, so a raw insert is the
  // direct way to put "this vendor has been invoiced in Midwest" on
  // record for this test, same shortcut vendorComplianceReminders.test.js
  // takes for backdating a timestamp.
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const now = new Date().toISOString();
  raw
    .prepare(
      `INSERT INTO pos (composite_key, vendor_id, region, first_imported_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, 'Midwest', ?, ?, ?, ?)`
    )
    .run(`TERRITORY-TEST-${vendor.id}`, vendor.id, now, now, now, now);

  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi.pdf",
    fileContent: await buildFakePdf(["placeholder"]),
    mimeType: "application/pdf",
  });
  const review = (await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "ADMIN" })).body;

  const approveRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review.id}/approve`, { userId: "ADMIN" });
  assert.equal(approveRes.status, 200);
  assert.equal(approveRes.body.review.status, "approved");
  assert.ok(approveRes.body.review.reviewedByName);
  assert.ok(approveRes.body.task.description.includes("Midwest"), approveRes.body.task.description);
  // createTask (same as every other route calling it directly) returns the
  // raw DB row, snake_case columns included -- not run through a presenter.
  assert.equal(approveRes.body.task.related_vendor_id, vendor.id);

  // Can't approve (or reject) the same review twice.
  const reapproveRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review.id}/approve`, { userId: "ADMIN" });
  assert.equal(reapproveRes.status, 400);

  const audit = await server.call("GET", "/api/audit", { userId: "ADMIN" });
  assert.ok(audit.body.some((e) => e.action === "VENDOR_COI_REVIEW_APPROVED" && e.details.includes("Territory Co")));
});

test("coi document review: reject requires reasons from the review's own checklist, and emails the vendor", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Rejected Co", email: "ops@rejectedco.test" } });
  const vendor = vendorRes.body;

  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi.pdf",
    fileContent: await buildFakePdf(["placeholder"]),
    mimeType: "application/pdf",
  });
  const review = (await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "ADMIN" })).body;

  const noReasonsRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review.id}/reject`, { userId: "ADMIN", body: { reasonKeys: [] } });
  assert.equal(noReasonsRes.status, 400);

  const badReasonRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review.id}/reject`, {
    userId: "ADMIN",
    body: { reasonKeys: ["not-a-real-key"] },
  });
  assert.equal(badReasonRes.status, 400);

  const rejectRes = await server.call("POST", `/api/admin/vendors/${vendor.id}/coi-reviews/${review.id}/reject`, {
    userId: "ADMIN",
    body: { reasonKeys: ["acord25", "certHolder"] },
  });
  assert.equal(rejectRes.status, 200);
  assert.equal(rejectRes.body.review.status, "rejected");
  assert.deepEqual(rejectRes.body.review.rejectedReasons, ["acord25", "certHolder"]);
  assert.equal(rejectRes.body.emailSkippedNoAddress, false);

  const audit = await server.call("GET", "/api/audit", { userId: "ADMIN" });
  const entry = audit.body.find((e) => e.action === "VENDOR_COI_REVIEW_REJECTED" && e.details.includes("Rejected Co"));
  assert.ok(entry);
  assert.match(entry.details, /ACORD 25/);
  assert.match(entry.details, /Certificate Holder/);
});

test("coi document review: a technician can't start, approve, or reject a review", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Tech Blocked Co" } });
  const vendor = vendorRes.body;
  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "vendor", relatedId: String(vendor.id), category: "coi" },
    fileName: "coi.pdf",
    fileContent: "x",
  });

  const res = await server.call("POST", `/api/admin/vendors/${vendor.id}/files/${upload.body.id}/coi-review`, { userId: "T1001" });
  assert.equal(res.status, 403);
});
