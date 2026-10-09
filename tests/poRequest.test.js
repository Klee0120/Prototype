const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { startServer } = require("./helpers");

const SAMPLE_PO_BUFFER = fs.readFileSync(path.join(__dirname, "fixtures", "sample-po.pdf"));
// A second fixture with a different vendor # (same layout, same email) --
// every test() block in this file shares one SQLite file (see
// tests/helpers.js), so the mismatch test below needs its own vendor #
// rather than reusing "9999001" and colliding with the vendor the earlier
// test already created under that number.
const SAMPLE_PO_BUFFER_2 = fs.readFileSync(path.join(__dirname, "fixtures", "sample-po-2.pdf"));
// Matches the fixtures' own embedded text -- see tests/fixtures/sample-po*.pdf
// and the comment in server/utils/poDocument.js for why this is reliable
// without OCR: it's a real generated PDF with a text layer, not a scan.
const FIXTURE_VENDOR_NUMBER = "9999001";
const FIXTURE_VENDOR_NUMBER_2 = "9999002";
const FIXTURE_EMAIL = "fixturevendor@example.com";

test("tech-initiated PO request: no WOM required, routes to a real admin", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("a tech can request a PO with no WOM at all", async () => {
    const res = await server.call("POST", "/api/tasks/request-po", {
      userId: "T1001",
      body: { assignedTo: "ADMIN", note: "Need a PO for a general parts order" },
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.category, "po_request");
    assert.equal(res.body.poStage, "requested");
    assert.equal(res.body.relatedWomCode, null);
    assert.equal(res.body.assignedTo, "ADMIN");
    assert.match(res.body.title, /Generate C&W PO/);
  });

  await t.test("a WOM, when given, carries over as context", async () => {
    const res = await server.call("POST", "/api/tasks/request-po", {
      userId: "T1001",
      body: { womCode: "WOM-4502", assignedTo: "ADMIN" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.relatedWomCode, "WOM-4502");
    assert.match(res.body.title, /WOM-4502/);
  });

  await t.test("rejects an unknown WOM", async () => {
    const res = await server.call("POST", "/api/tasks/request-po", {
      userId: "T1001",
      body: { womCode: "WOM-NOPE", assignedTo: "ADMIN" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("assignedTo must be a real admin, not just any technician", async () => {
    const res = await server.call("POST", "/api/tasks/request-po", {
      userId: "T1001",
      body: { assignedTo: "T1002" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("assignedTo is required", async () => {
    const res = await server.call("POST", "/api/tasks/request-po", { userId: "T1001", body: {} });
    assert.equal(res.status, 400);
  });
});

test("marking a PO generated: real vendor verification off the uploaded PDF", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const requestRes = await server.call("POST", "/api/tasks/request-po", {
    userId: "T1001",
    body: { assignedTo: "ADMIN" },
  });
  const taskId = requestRes.body.id;

  await t.test("a technician cannot mark a PO generated", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}/po-generated`, {
      userId: "T1001",
      body: { vendorId: 1, poEmail: "x@example.com" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("rejects before the PO document is uploaded", async () => {
    const vendorRes = await server.call("POST", "/api/admin/vendors", {
      userId: "ADMIN",
      body: { name: "Fixture Vendor", jdeVendorNumber: FIXTURE_VENDOR_NUMBER, poEmail: FIXTURE_EMAIL },
    });
    assert.equal(vendorRes.status, 201);
    const vendorId = vendorRes.body.id;

    const res = await server.call("PATCH", `/api/tasks/${taskId}/po-generated`, {
      userId: "ADMIN",
      body: { vendorId, poEmail: FIXTURE_EMAIL },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /upload/i);
  });

  let fileId;
  await t.test("uploading the PO document, then extracting its vendor info", async () => {
    const upload = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "task", relatedId: String(taskId), category: "po_document" },
      fileName: "generated-po.pdf",
      fileContent: SAMPLE_PO_BUFFER,
      mimeType: "application/pdf",
    });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    fileId = upload.body.id;

    const extracted = await server.call("GET", `/api/files/${fileId}/extract-po-vendor`, { userId: "ADMIN" });
    assert.equal(extracted.status, 200);
    assert.equal(extracted.body.extractedVendorNumber, FIXTURE_VENDOR_NUMBER);
    assert.equal(extracted.body.extractedEmail, FIXTURE_EMAIL);
    assert.ok(extracted.body.matchedVendorId, "expected the fixture's vendor # to match the real vendor profile");
    assert.equal(extracted.body.matchedVendorName, "Fixture Vendor");
    assert.equal(extracted.body.emailMismatch, false, "the vendor's own po_email matches the PDF's email");
  });

  await t.test("extraction is scoped to po_document files only", async () => {
    const upload = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "task", relatedId: String(taskId), category: "document" },
      fileName: "unrelated.pdf",
      fileContent: SAMPLE_PO_BUFFER,
      mimeType: "application/pdf",
    });
    assert.equal(upload.status, 201);
    const res = await server.call("GET", `/api/files/${upload.body.id}/extract-po-vendor`, { userId: "ADMIN" });
    assert.equal(res.status, 400);
  });

  await t.test("a technician cannot call the extraction route either", async () => {
    const res = await server.call("GET", `/api/files/${fileId}/extract-po-vendor`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("marking it generated locks in the vendor and starts the follow-up clock", async () => {
    const extracted = await server.call("GET", `/api/files/${fileId}/extract-po-vendor`, { userId: "ADMIN" });
    const vendorId = extracted.body.matchedVendorId;

    const res = await server.call("PATCH", `/api/tasks/${taskId}/po-generated`, {
      userId: "ADMIN",
      body: { vendorId, poEmail: FIXTURE_EMAIL, emailVendor: false },
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.poStage, "pending_invoice");
    assert.equal(res.body.relatedVendorId, vendorId);
    assert.ok(res.body.poGeneratedAt);
    const daysOut = (new Date(res.body.dueAt) - Date.now()) / 86400000;
    assert.ok(daysOut > 29 && daysOut < 31, `expected ~30 days out, got ${daysOut}`);
  });

  await t.test("can't be marked generated a second time", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}/po-generated`, {
      userId: "ADMIN",
      body: { vendorId: 1, poEmail: FIXTURE_EMAIL },
    });
    assert.equal(res.status, 400);
  });

  await t.test("the change is audited", async () => {
    const audit = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    assert.ok(audit.body.some((e) => e.action === "PO_REQUESTED"));
    assert.ok(audit.body.some((e) => e.action === "PO_GENERATED"));
  });
});

test("marking a PO generated: a vendor-email mismatch is surfaced, not silently trusted", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendorRes = await server.call("POST", "/api/admin/vendors", {
    userId: "ADMIN",
    // A different email on file than what the fixture PDF actually says.
    body: { name: "Mismatch Vendor", jdeVendorNumber: FIXTURE_VENDOR_NUMBER_2, poEmail: "onfile@example.com" },
  });
  const vendorId = vendorRes.body.id;

  const requestRes = await server.call("POST", "/api/tasks/request-po", { userId: "T1001", body: { assignedTo: "ADMIN" } });
  const taskId = requestRes.body.id;

  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "task", relatedId: String(taskId), category: "po_document" },
    fileName: "generated-po.pdf",
    fileContent: SAMPLE_PO_BUFFER_2,
    mimeType: "application/pdf",
  });

  await t.test("extraction flags the mismatch instead of guessing", async () => {
    const extracted = await server.call("GET", `/api/files/${upload.body.id}/extract-po-vendor`, { userId: "ADMIN" });
    assert.equal(extracted.body.matchedVendorId, vendorId);
    assert.equal(extracted.body.matchedVendorPoEmail, "onfile@example.com");
    assert.equal(extracted.body.extractedEmail, FIXTURE_EMAIL);
    assert.equal(extracted.body.emailMismatch, true);
  });

  await t.test("marking generated still works once the admin picks which email is right", async () => {
    const res = await server.call("PATCH", `/api/tasks/${taskId}/po-generated`, {
      userId: "ADMIN",
      body: { vendorId, poEmail: FIXTURE_EMAIL, emailVendor: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.poStage, "pending_invoice");
  });
});
