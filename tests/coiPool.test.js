const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");
const { PDFDocument, StandardFonts } = require("pdf-lib");

test("COI pool: an unmatched COI can be uploaded, queued, and assigned onto a vendor", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("a technician can't see or touch the pool", async () => {
    const upload = await server.upload("/api/files", {
      userId: "T1001",
      fields: { relatedType: "coi_pool", relatedId: "pool", category: "coi" },
      fileName: "coi.pdf",
    });
    assert.equal(upload.status, 403);

    const list = await server.call("GET", "/api/files?relatedType=coi_pool&relatedId=pool", { userId: "T1001" });
    assert.equal(list.status, 403);

    const queue = await server.call("GET", "/api/admin/coi-reviews/queue", { userId: "T1001" });
    assert.equal(queue.status, 403);
  });

  let fileId;
  await t.test("an admin uploads an unmatched COI straight to the pool", async () => {
    const upload = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "coi_pool", relatedId: "pool", category: "coi" },
      fileName: "unmatched-coi.pdf",
      fileContent: "pretend coi bytes",
    });
    assert.equal(upload.status, 201);
    assert.equal(upload.body.relatedType, "coi_pool");
    fileId = upload.body.id;

    const queue = await server.call("GET", "/api/admin/coi-reviews/queue", { userId: "ADMIN" });
    assert.equal(queue.status, 200);
    assert.ok(queue.body.pool.some((f) => f.id === fileId));
    assert.equal(queue.body.pendingReviews.length, 0);
  });

  let vendorId;
  await t.test("assigning it to a vendor repoints the file and starts its review", async () => {
    const vendorRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Pool Assign Co" } });
    vendorId = vendorRes.body.id;

    const assignRes = await server.call("POST", `/api/admin/coi-reviews/pool/${fileId}/assign-vendor`, {
      userId: "ADMIN",
      body: { vendorId },
    });
    assert.equal(assignRes.status, 200);
    assert.equal(assignRes.body.file.relatedType, "vendor");
    assert.equal(assignRes.body.file.relatedId, String(vendorId));
    assert.equal(assignRes.body.file.id, fileId, "same file row, not a re-upload");
    assert.equal(assignRes.body.review.status, "pending");
    assert.equal(assignRes.body.review.vendorId, vendorId);

    const audit = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    assert.ok(audit.body.some((e) => e.action === "COI_POOL_FILE_ASSIGNED" && e.details.includes("Pool Assign Co")));
  });

  await t.test("the queue now shows it under pending reviews, not the pool", async () => {
    const queue = await server.call("GET", "/api/admin/coi-reviews/queue", { userId: "ADMIN" });
    assert.ok(!queue.body.pool.some((f) => f.id === fileId));
    assert.ok(queue.body.pendingReviews.some((r) => r.fileId === fileId && r.vendorName === "Pool Assign Co"));
  });

  await t.test("the file now shows up on the vendor's own document list", async () => {
    const files = await server.call("GET", `/api/files?relatedType=vendor&relatedId=${vendorId}`, { userId: "ADMIN" });
    assert.ok(files.body.some((f) => f.id === fileId));
  });

  await t.test("assigning an already-assigned file fails (not a pool file anymore)", async () => {
    const res = await server.call("POST", `/api/admin/coi-reviews/pool/${fileId}/assign-vendor`, { userId: "ADMIN", body: { vendorId } });
    assert.equal(res.status, 404);
  });

  await t.test("assigning with no real vendorId fails", async () => {
    const upload = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "coi_pool", relatedId: "pool", category: "coi" },
      fileName: "another-unmatched.pdf",
    });
    const res = await server.call("POST", `/api/admin/coi-reviews/pool/${upload.body.id}/assign-vendor`, {
      userId: "ADMIN",
      body: { vendorId: 999999 },
    });
    assert.equal(res.status, 400);
  });
});

test("COI pool: the preview route reads extraction without matching or creating anything", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 740;
  for (const line of ["INSURED Acme Facilities Maintenance LLC 123 Main St", "CL1234567890 01/01/2025 01/01/2026"]) {
    page.drawText(line, { x: 40, y, size: 10, font, maxWidth: 530 });
    y -= 16;
  }
  const pdfBytes = Buffer.from(await doc.save());

  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "coi_pool", relatedId: "pool", category: "coi" },
    fileName: "unmatched-with-name.pdf",
    fileContent: pdfBytes,
    mimeType: "application/pdf",
  });

  const preview = await server.call("GET", `/api/admin/coi-reviews/pool/${upload.body.id}/preview`, { userId: "ADMIN" });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.extractedFields.insuredName, "Acme Facilities Maintenance LLC");
  // Regression check: pdfjs's getTextContent joins every text run on a page
  // with a single space by default, with no line breaks at all, unless the
  // extraction explicitly honors each run's own hasEOL flag -- without
  // that, this would swallow the *next* drawn line ("CL1234567890 ...")
  // straight into the address.
  assert.equal(preview.body.extractedFields.insuredAddress, "123 Main St");
  assert.equal(preview.body.extractedFields.policyNumber, "CL1234567890");

  // Read-only -- the file is still sitting in the pool, unassigned, and
  // calling it again gives the identical result (nothing was consumed or
  // mutated by looking).
  const queue = await server.call("GET", "/api/admin/coi-reviews/queue", { userId: "ADMIN" });
  assert.ok(queue.body.pool.some((f) => f.id === upload.body.id));
  const secondPreview = await server.call("GET", `/api/admin/coi-reviews/pool/${upload.body.id}/preview`, { userId: "ADMIN" });
  assert.deepEqual(secondPreview.body.extractedFields, preview.body.extractedFields);

  const notPooled = await server.call("GET", "/api/admin/coi-reviews/pool/999999/preview", { userId: "ADMIN" });
  assert.equal(notPooled.status, 404);

  const techRes = await server.call("GET", `/api/admin/coi-reviews/pool/${upload.body.id}/preview`, { userId: "T1001" });
  assert.equal(techRes.status, 403);
});
