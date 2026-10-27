const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

// Vendor Correspondence: a running log of emails/documents an admin
// received from a vendor outside the self-service portal (for vendors who
// don't use it, or send paperwork a different way). Covers manual
// logging, the .eml drag-and-drop auto-parse path, the non-.eml fallback
// ("just drag whatever you have"), and that it's admin-only throughout,
// same as every other vendor compliance document.
test("vendors: correspondence log", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const createRes = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Acme Plumbing Co" } });
  const vendorId = createRes.body.id;

  await t.test("a technician cannot read or write correspondence", async () => {
    const getRes = await server.call("GET", `/api/admin/vendors/${vendorId}/correspondence`, { userId: "T1001" });
    assert.equal(getRes.status, 403);
    const postRes = await server.call("POST", `/api/admin/vendors/${vendorId}/correspondence`, {
      userId: "T1001",
      body: { subject: "Hijack", correspondent: "nobody" },
    });
    assert.equal(postRes.status, 403);
  });

  await t.test("empty before anything is logged", async () => {
    const res = await server.call("GET", `/api/admin/vendors/${vendorId}/correspondence`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  await t.test("subject and correspondent are required", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/correspondence`, { userId: "ADMIN", body: { subject: "Hi" } });
    assert.equal(res.status, 400);
  });

  let manualEntryId;
  await t.test("manual logging creates an entry", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/correspondence`, {
      userId: "ADMIN",
      body: { subject: "Called about COI renewal", correspondent: "Jane at Acme", occurredAt: "2026-10-01", bodyText: "Left a voicemail." },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.subject, "Called about COI renewal");
    assert.equal(res.body.correspondent, "Jane at Acme");
    assert.equal(res.body.occurredAt, "2026-10-01");
    assert.equal(res.body.loggedBy, "Krista Lee");
    assert.equal(res.body.summary, null, "stays null until AI summarization exists as its own later piece");
    manualEntryId = res.body.id;
  });

  await t.test("a manual entry's attachments go through the normal files upload, scoped to just that entry", async () => {
    const uploadRes = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "vendor_correspondence", relatedId: String(manualEntryId), category: "attachment" },
      fileName: "voicemail-note.txt",
      fileContent: "transcript",
    });
    assert.equal(uploadRes.status, 201);

    const listRes = await server.call("GET", `/api/files?relatedType=vendor_correspondence&relatedId=${manualEntryId}`, { userId: "ADMIN" });
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.length, 1);
    assert.equal(listRes.body[0].originalName, "voicemail-note.txt");
  });

  await t.test("a technician cannot upload to a correspondence entry, or read its attachments", async () => {
    const uploadRes = await server.upload("/api/files", {
      userId: "T1001",
      fields: { relatedType: "vendor_correspondence", relatedId: String(manualEntryId), category: "attachment" },
      fileName: "x.txt",
    });
    assert.equal(uploadRes.status, 403);
    const listRes = await server.call("GET", `/api/files?relatedType=vendor_correspondence&relatedId=${manualEntryId}`, { userId: "T1001" });
    assert.equal(listRes.status, 403);
  });

  await t.test("uploading against a nonexistent correspondence entry 404s", async () => {
    const res = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "vendor_correspondence", relatedId: "999999", category: "attachment" },
      fileName: "x.txt",
    });
    assert.equal(res.status, 404);
  });

  const EML = [
    "From: Jane Vendor <jane@acmeplumbing.com>",
    "To: ap@cwservices.com",
    "Subject: COI renewal attached",
    "Date: Mon, 26 Oct 2026 14:30:00 -0500",
    'Content-Type: multipart/mixed; boundary="XYZ"',
    "",
    "--XYZ",
    "Content-Type: text/plain",
    "",
    "Hi, attached is our updated certificate of insurance.",
    "",
    "--XYZ",
    'Content-Type: application/pdf; name="coi.pdf"',
    'Content-Disposition: attachment; filename="coi.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("fake pdf bytes").toString("base64"),
    "--XYZ--",
  ].join("\r\n");

  let emlEntryId;
  await t.test("dragging in a real .eml auto-parses subject/from/date/body and files its attachment", async () => {
    const res = await server.upload(`/api/admin/vendors/${vendorId}/correspondence/import-eml`, {
      userId: "ADMIN",
      fileName: "vendor-email.eml",
      fileContent: EML,
      mimeType: "message/rfc822",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.imported, true);
    assert.equal(res.body.entry.subject, "COI renewal attached");
    assert.equal(res.body.entry.correspondent, '"Jane Vendor" <jane@acmeplumbing.com>');
    assert.match(res.body.entry.bodyText, /attached is our updated certificate/);
    assert.equal(res.body.attachments.length, 1);
    assert.equal(res.body.attachments[0].originalName, "coi.pdf");
    emlEntryId = res.body.entry.id;

    const filesRes = await server.call("GET", `/api/files?relatedType=vendor_correspondence&relatedId=${emlEntryId}`, { userId: "ADMIN" });
    assert.equal(filesRes.body.length, 1);
  });

  await t.test("a technician cannot import an .eml", async () => {
    const res = await server.upload(`/api/admin/vendors/${vendorId}/correspondence/import-eml`, {
      userId: "T1001",
      fileName: "x.eml",
      fileContent: EML,
    });
    assert.equal(res.status, 403);
  });

  await t.test("a non-.eml file falls back to a blank entry titled from the filename, with itself as the one attachment", async () => {
    const res = await server.upload(`/api/admin/vendors/${vendorId}/correspondence/import-eml`, {
      userId: "ADMIN",
      fileName: "forwarded-w9-screenshot.png",
      fileContent: "not really a png but that's fine for this test",
      mimeType: "image/png",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.imported, false);
    assert.equal(res.body.entry.subject, "forwarded-w9-screenshot");
    assert.equal(res.body.entry.correspondent, "");
    assert.equal(res.body.attachments.length, 1);
    assert.equal(res.body.attachments[0].originalName, "forwarded-w9-screenshot.png");
  });

  await t.test("the list is newest-first by the email's own date, not by when it was logged", async () => {
    const res = await server.call("GET", `/api/admin/vendors/${vendorId}/correspondence`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 3);
    // manual entry was backdated to 2026-10-01; the .eml's own date is
    // 2026-10-26; the fallback entry defaults to "now" (test run time) --
    // whichever of those is actually latest should sort first, and the
    // backdated manual entry should always sort last.
    assert.equal(res.body[res.body.length - 1].id, manualEntryId);
  });

  await t.test("the vendor list reflects how many correspondence attachments are still unfiled", async () => {
    const res = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    const vendor = res.body.find((v) => v.id === vendorId);
    // manual entry's voicemail note + the .eml's coi.pdf + the fallback
    // entry's own screenshot -- three attachments, none filed yet.
    assert.equal(vendor.pendingCorrespondenceCount, 3);
  });

  await t.test("filing a correspondence attachment to a case moves it onto the vendor's real Documents", async () => {
    const beforeFiles = await server.call("GET", `/api/files?relatedType=vendor_correspondence&relatedId=${emlEntryId}`, { userId: "ADMIN" });
    const coiFileId = beforeFiles.body[0].id;

    const relocateRes = await server.call("PATCH", `/api/files/${coiFileId}/relocate`, {
      userId: "ADMIN",
      body: { relatedType: "vendor", relatedId: vendorId, category: "coi" },
    });
    assert.equal(relocateRes.status, 200);

    const afterCorrespondenceFiles = await server.call("GET", `/api/files?relatedType=vendor_correspondence&relatedId=${emlEntryId}`, {
      userId: "ADMIN",
    });
    assert.equal(afterCorrespondenceFiles.body.length, 0, "no longer shows up under its old correspondence entry");

    const vendorDocs = await server.call("GET", `/api/files?relatedType=vendor&relatedId=${vendorId}`, { userId: "ADMIN" });
    assert.ok(vendorDocs.body.some((f) => f.id === coiFileId && f.category === "coi"), "now shows up on the vendor's real Documents");

    const vendorListRes = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    const vendor = vendorListRes.body.find((v) => v.id === vendorId);
    assert.equal(vendor.pendingCorrespondenceCount, 2, "one fewer, now that it's been filed");
  });

  await t.test("importing without a file is rejected", async () => {
    const res = await server.call("POST", `/api/admin/vendors/${vendorId}/correspondence/import-eml`, { userId: "ADMIN", body: {} });
    assert.equal(res.status, 400);
  });

  await t.test("correspondence shows up on vendor delete cleanup without erroring", async () => {
    const delRes = await server.call("DELETE", `/api/admin/vendors/${vendorId}`, { userId: "ADMIN" });
    assert.equal(delRes.status, 200);
    const filesRes = await server.call("GET", `/api/files?relatedType=vendor_correspondence&relatedId=${manualEntryId}`, { userId: "ADMIN" });
    // The vendor is gone, so its correspondence entries no longer exist --
    // relatedRecordExists correctly reports nothing to look up against.
    assert.equal(filesRes.status, 200);
    assert.deepEqual(filesRes.body, []);
  });
});
