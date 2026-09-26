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
