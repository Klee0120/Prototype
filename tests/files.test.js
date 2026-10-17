const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("files: attachments (upload/list/download/delete) authorization", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const meta = await server.call("GET", "/api/meta/current-week");
  const week = meta.body.weekMonday;
  const weekRelatedId = `T1001|${week}`;

  await t.test("a technician can upload a receipt to their own week", async () => {
    const res = await server.upload("/api/files", {
      userId: "T1001",
      fields: { relatedType: "week", relatedId: weekRelatedId, category: "receipt" },
      fileName: "receipt.txt",
      fileContent: "receipt body",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.category, "receipt");
    assert.equal(res.body.uploadedBy, "T1001");
  });

  await t.test("a technician cannot upload to another technician's week", async () => {
    const res = await server.upload("/api/files", {
      userId: "T1002",
      fields: { relatedType: "week", relatedId: weekRelatedId, category: "receipt" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("rejects a category that doesn't belong to the related type", async () => {
    const res = await server.upload("/api/files", {
      userId: "T1001",
      fields: { relatedType: "week", relatedId: weekRelatedId, category: "wom_doc" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("a technician cannot upload a tech_form (admin-managed)", async () => {
    const res = await server.upload("/api/files", {
      userId: "T1001",
      fields: { relatedType: "technician", relatedId: "T1001", category: "tech_form" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("an admin can upload a tech_form for any technician", async () => {
    const res = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "technician", relatedId: "T1001", category: "tech_form" },
      fileName: "certification.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.category, "tech_form");
  });

  await t.test("any authenticated technician can upload a WOM document", async () => {
    const res = await server.upload("/api/files", {
      userId: "T1002",
      fields: { relatedType: "wom", relatedId: "WOM-4471", category: "wom_doc" },
      fileName: "job-photo.jpg",
      mimeType: "image/jpeg",
    });
    assert.equal(res.status, 201);
  });

  await t.test("labor_report uploads are admin-only, keyed by month", async () => {
    const nonAdmin = await server.upload("/api/files", {
      userId: "T1001",
      fields: { relatedType: "labor_report", relatedId: "2026-09", category: "labor_report" },
    });
    assert.equal(nonAdmin.status, 403);

    const badMonth = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "labor_report", relatedId: "not-a-month", category: "labor_report" },
    });
    assert.equal(badMonth.status, 404);

    const ok = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "labor_report", relatedId: "2026-09", category: "labor_report" },
      fileName: "labor-report-sept.xlsx",
    });
    assert.equal(ok.status, 201);

    const list = await server.call("GET", "/api/files?relatedType=labor_report&relatedId=2026-09", { userId: "ADMIN" });
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);

    const techList = await server.call("GET", "/api/files?relatedType=labor_report&relatedId=2026-09", { userId: "T1001" });
    assert.equal(techList.status, 403);
  });

  await t.test("WOM, Financial, and GL reports share the same monthly archive as labor reports", async () => {
    for (const category of ["wom_report", "financial_report", "gl_report"]) {
      const res = await server.upload("/api/files", {
        userId: "ADMIN",
        fields: { relatedType: "labor_report", relatedId: "2026-10", category },
        fileName: `${category}.xlsx`,
      });
      assert.equal(res.status, 201, `${category} should upload`);
    }

    const list = await server.call("GET", "/api/files?relatedType=labor_report&relatedId=2026-10", { userId: "ADMIN" });
    assert.equal(list.status, 200);
    const categories = list.body.map((f) => f.category).sort();
    assert.deepEqual(categories, ["financial_report", "gl_report", "wom_report"]);
  });

  await t.test("uploading against a nonexistent related record 404s", async () => {
    const res = await server.upload("/api/files", {
      userId: "T1002",
      fields: { relatedType: "wom", relatedId: "WOM-DOES-NOT-EXIST", category: "wom_doc" },
    });
    assert.equal(res.status, 404);
  });

  let receiptId;
  await t.test("listing a week's files requires being the owner or an admin", async () => {
    const own = await server.call("GET", `/api/files?relatedType=week&relatedId=${weekRelatedId}`, { userId: "T1001" });
    assert.equal(own.status, 200);
    assert.equal(own.body.length, 1);
    receiptId = own.body[0].id;

    const admin = await server.call("GET", `/api/files?relatedType=week&relatedId=${weekRelatedId}`, { userId: "ADMIN" });
    assert.equal(admin.status, 200);
    assert.equal(admin.body.length, 1);

    const other = await server.call("GET", `/api/files?relatedType=week&relatedId=${weekRelatedId}`, { userId: "T1002" });
    assert.equal(other.status, 403);
  });

  await t.test("anyone logged in can list a WOM's documents", async () => {
    const res = await server.call("GET", "/api/files?relatedType=wom&relatedId=WOM-4471", { userId: "T1003" });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
  });

  await t.test("download requires the same authorization as listing", async () => {
    const own = await server.rawGet(`/api/files/${receiptId}/download`, { userId: "T1001" });
    assert.equal(own.status, 200);
    assert.equal(own.text, "receipt body");
    assert.match(own.headers.get("content-disposition"), /receipt\.txt/);

    const other = await server.rawGet(`/api/files/${receiptId}/download`, { userId: "T1002" });
    assert.equal(other.status, 403);
  });

  await t.test("only an admin can delete a file -- not even the technician who uploaded it", async () => {
    const wrongUser = await server.call("DELETE", `/api/files/${receiptId}`, { userId: "T1002" });
    assert.equal(wrongUser.status, 403);

    const owner = await server.call("DELETE", `/api/files/${receiptId}`, { userId: "T1001" });
    assert.equal(owner.status, 403);

    const admin = await server.call("DELETE", `/api/files/${receiptId}`, { userId: "ADMIN" });
    assert.equal(admin.status, 200);

    const afterDelete = await server.call("GET", `/api/files?relatedType=week&relatedId=${weekRelatedId}`, { userId: "T1001" });
    assert.equal(afterDelete.body.length, 0);
  });

  await t.test("file uploads and deletes are audited", async () => {
    const res = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const actions = res.body.map((e) => e.action);
    assert.ok(actions.includes("FILE_UPLOADED"));
    assert.ok(actions.includes("FILE_DELETED"));
  });

  await t.test("a tech_form can carry a type and expiration date", async () => {
    const res = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "technician", relatedId: "T1002", category: "tech_form", formType: "Forklift License", expiresAt: "2020-01-01" },
      fileName: "forklift.pdf",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.formType, "Forklift License");
    assert.equal(res.body.expiresAt, "2020-01-01");

    const list = await server.call("GET", "/api/files?relatedType=technician&relatedId=T1002", { userId: "ADMIN" });
    assert.ok(list.body.some((f) => f.formType === "Forklift License" && f.expiresAt === "2020-01-01"));
  });

  await t.test("rejects a malformed expiration date", async () => {
    const res = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "technician", relatedId: "T1002", category: "tech_form", expiresAt: "not-a-date" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("expired/expiring forms surface on the admin expiring-forms endpoint", async () => {
    const res = await server.call("GET", "/api/admin/expiring-forms", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.some((f) => f.techId === "T1002" && f.formType === "Forklift License"));
  });

  await t.test("a form expiring far in the future doesn't show up on the warning list", async () => {
    await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "technician", relatedId: "T1003", category: "tech_form", formType: "Not due for years", expiresAt: "2099-01-01" },
    });
    const res = await server.call("GET", "/api/admin/expiring-forms", { userId: "ADMIN" });
    assert.ok(!res.body.some((f) => f.formType === "Not due for years"));
  });

  await t.test("a technician cannot view the expiring-forms list", async () => {
    const res = await server.call("GET", "/api/admin/expiring-forms", { userId: "T1001" });
    assert.equal(res.status, 403);
  });
});

// A COI (or W-9, etc.) can come in before Krista's picked a vendor to file
// it against -- e.g. a renewal email from Aon she hasn't worked yet. She
// needs somewhere to park the document without it being tied to any
// vendor, tracked on a task instead: same compliance-document handling
// (admin-only, never technician-visible) as a vendor's own files.
test("files: task attachments (documents not yet filed to a vendor)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const task = await server.call("POST", "/api/tasks", {
    userId: "ADMIN",
    body: { title: "File COI from Aon once vendor is confirmed" },
  });
  const taskId = task.body.id;

  await t.test("an admin can attach a COI to a task", async () => {
    const res = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "task", relatedId: String(taskId), category: "coi" },
      fileName: "aon-coi-renewal.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.category, "coi");
    assert.equal(res.body.relatedId, String(taskId));
  });

  await t.test("a technician cannot upload to a task", async () => {
    const res = await server.upload("/api/files", {
      userId: "T1001",
      fields: { relatedType: "task", relatedId: String(taskId), category: "coi" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("a technician cannot list a task's attachments", async () => {
    const res = await server.call("GET", `/api/files?relatedType=task&relatedId=${taskId}`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("an admin sees the attached file listed against the task", async () => {
    const res = await server.call("GET", `/api/files?relatedType=task&relatedId=${taskId}`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].originalName, "aon-coi-renewal.pdf");
  });

  await t.test("rejects a category that isn't a task-document category", async () => {
    const res = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "task", relatedId: String(taskId), category: "receipt" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("uploading against a task that doesn't exist 404s", async () => {
    const res = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "task", relatedId: "999999", category: "coi" },
    });
    assert.equal(res.status, 404);
  });
});

// Once it's clear which vendor a task-parked document belongs to, it gets
// assigned there instead of re-uploaded -- the file's bytes never move,
// only which record it's attached to.
test("files: assigning a task-parked document onto a vendor", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const task = await server.call("POST", "/api/tasks", { userId: "ADMIN", body: { title: "File COI once vendor confirmed" } });
  const upload = await server.upload("/api/files", {
    userId: "ADMIN",
    fields: { relatedType: "task", relatedId: String(task.body.id), category: "coi" },
    fileName: "renewal.pdf",
    mimeType: "application/pdf",
  });
  const fileId = upload.body.id;

  const vendor = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Morley and Associates" } });
  const vendorId = vendor.body.id;

  await t.test("the pending document shows up in the admin-wide task-documents list, with its task's title", async () => {
    const res = await server.call("GET", "/api/files/task-documents", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    const entry = res.body.find((f) => f.id === fileId);
    assert.ok(entry, "expected the uploaded file in the task-documents list");
    assert.equal(entry.taskTitle, "File COI once vendor confirmed");
  });

  await t.test("a technician cannot see the task-documents list", async () => {
    const res = await server.call("GET", "/api/files/task-documents", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("assigning it onto the vendor moves it there, off the task", async () => {
    const res = await server.call("PATCH", `/api/files/${fileId}/relocate`, {
      userId: "ADMIN",
      body: { relatedType: "vendor", relatedId: String(vendorId), category: "coi" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.relatedType, "vendor");
    assert.equal(res.body.relatedId, String(vendorId));

    const onVendor = await server.call("GET", `/api/files?relatedType=vendor&relatedId=${vendorId}`, { userId: "ADMIN" });
    assert.equal(onVendor.body.length, 1);
    assert.equal(onVendor.body[0].originalName, "renewal.pdf");

    const onTask = await server.call("GET", `/api/files?relatedType=task&relatedId=${task.body.id}`, { userId: "ADMIN" });
    assert.equal(onTask.body.length, 0);
  });

  await t.test("a technician cannot relocate a file", async () => {
    const res = await server.call("PATCH", `/api/files/${fileId}/relocate`, {
      userId: "T1001",
      body: { relatedType: "vendor", relatedId: String(vendorId), category: "coi" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("rejects relocating onto a category that doesn't belong to the target relatedType", async () => {
    const res = await server.call("PATCH", `/api/files/${fileId}/relocate`, {
      userId: "ADMIN",
      body: { relatedType: "vendor", relatedId: String(vendorId), category: "receipt" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("rejects relocating onto a vendor that doesn't exist", async () => {
    const res = await server.call("PATCH", `/api/files/${fileId}/relocate`, {
      userId: "ADMIN",
      body: { relatedType: "vendor", relatedId: "999999", category: "coi" },
    });
    assert.equal(res.status, 404);
  });
});

test("files: restricted access", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const vendor = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: { name: "Restricted Docs Co" } });
  const vendorId = vendor.body.id;

  await t.test("a non-admin's upload is always standard, even if they ask for restricted", async () => {
    const res = await server.upload("/api/files", {
      userId: "T1001",
      fields: { relatedType: "wom", relatedId: "WOM-4471", category: "wom_doc", accessLevel: "restricted" },
      fileName: "job-photo.jpg",
      mimeType: "image/jpeg",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.accessLevel, "standard");
  });

  let restrictedId;
  await t.test("an admin can upload a file marked restricted", async () => {
    const res = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "vendor", relatedId: String(vendorId), category: "ach", accessLevel: "restricted" },
      fileName: "bank-letter.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.accessLevel, "restricted");
    restrictedId = res.body.id;
  });

  await t.test("rejects an invalid accessLevel on upload", async () => {
    const res = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "vendor", relatedId: String(vendorId), category: "ach", accessLevel: "secret" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("an admin can download a restricted file", async () => {
    const res = await server.rawGet(`/api/files/${restrictedId}/download`, { userId: "ADMIN" });
    assert.equal(res.status, 200);
  });

  await t.test("an admin can mark a restricted file back to standard via PATCH /:id/access", async () => {
    const res = await server.call("PATCH", `/api/files/${restrictedId}/access`, {
      userId: "ADMIN",
      body: { accessLevel: "standard" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.accessLevel, "standard");
  });

  await t.test("a technician cannot toggle a file's access level", async () => {
    const res = await server.call("PATCH", `/api/files/${restrictedId}/access`, {
      userId: "T1001",
      body: { accessLevel: "restricted" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("rejects an invalid accessLevel on the PATCH route", async () => {
    const res = await server.call("PATCH", `/api/files/${restrictedId}/access`, {
      userId: "ADMIN",
      body: { accessLevel: "nope" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("PATCH /:id/access 404s for an unknown file", async () => {
    const res = await server.call("PATCH", "/api/files/does-not-exist/access", {
      userId: "ADMIN",
      body: { accessLevel: "restricted" },
    });
    assert.equal(res.status, 404);
  });

  // A WOM is open to every authenticated user to read -- the one relatedType
  // where a restricted file's extra gate (beyond canRead) is actually
  // reachable by a non-admin, so it's the one used to prove the list-filter
  // and download-block both work, not just the upload/PATCH plumbing above.
  await t.test("a restricted file on an otherwise-open relatedType is hidden from a non-admin's list and blocked on download", async () => {
    const restrictedWomFile = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "wom", relatedId: "WOM-4471", category: "wom_doc", accessLevel: "restricted" },
      fileName: "internal-note.pdf",
      mimeType: "application/pdf",
    });
    assert.equal(restrictedWomFile.body.accessLevel, "restricted");
    const restrictedWomFileId = restrictedWomFile.body.id;

    const techList = await server.call("GET", "/api/files?relatedType=wom&relatedId=WOM-4471", { userId: "T1002" });
    assert.equal(techList.status, 200);
    assert.ok(!techList.body.some((f) => f.id === restrictedWomFileId), "a non-admin's list should never include a restricted file");

    const adminList = await server.call("GET", "/api/files?relatedType=wom&relatedId=WOM-4471", { userId: "ADMIN" });
    assert.ok(adminList.body.some((f) => f.id === restrictedWomFileId), "an admin's list should still include it");

    const techDownload = await server.rawGet(`/api/files/${restrictedWomFileId}/download`, { userId: "T1002" });
    assert.equal(techDownload.status, 403);

    const adminDownload = await server.rawGet(`/api/files/${restrictedWomFileId}/download`, { userId: "ADMIN" });
    assert.equal(adminDownload.status, 200);
  });

  await t.test("marking a file restricted after upload hides it from non-admins going forward", async () => {
    const upload = await server.upload("/api/files", {
      userId: "T1003",
      fields: { relatedType: "wom", relatedId: "WOM-4471", category: "wom_doc" },
      fileName: "site-photo.jpg",
      mimeType: "image/jpeg",
    });
    const fileId = upload.body.id;

    const beforeList = await server.call("GET", "/api/files?relatedType=wom&relatedId=WOM-4471", { userId: "T1002" });
    assert.ok(beforeList.body.some((f) => f.id === fileId));

    await server.call("PATCH", `/api/files/${fileId}/access`, { userId: "ADMIN", body: { accessLevel: "restricted" } });

    const afterList = await server.call("GET", "/api/files?relatedType=wom&relatedId=WOM-4471", { userId: "T1002" });
    assert.ok(!afterList.body.some((f) => f.id === fileId));
  });

  await t.test("file access changes are audited", async () => {
    const res = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const actions = res.body.map((e) => e.action);
    assert.ok(actions.includes("FILE_ACCESS_CHANGED"));
  });
});
