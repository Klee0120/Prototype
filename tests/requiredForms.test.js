const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

// Roster Required Forms -- a per-employee requirement (db.js's
// technician_required_forms table), distinct from the existing ad hoc
// Forms & Certifications upload: this one has a real "missing" state
// before anything's uploaded, and the owning technician can upload the
// completed form back themselves (see files.js's technician_required_form
// relatedType).
test("Roster Required Forms: CRUD, status, and roster-wide visibility", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  let requirementId;

  await t.test("a technician cannot assign a requirement to themselves or anyone else", async () => {
    const res = await server.call("POST", "/api/technicians/required-forms", {
      userId: "T1001",
      body: { techId: "T1001", name: "Background Check Consent" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("admin can require a form of a specific technician", async () => {
    const res = await server.call("POST", "/api/technicians/required-forms", {
      userId: "ADMIN",
      body: { techId: "T1001", name: "Background Check Consent", instructions: "Sign and return to your site admin" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.techId, "T1001");
    assert.equal(res.body.techName, "Alex Rivera"); // seeded T1001 name, server/data/seed.js
    assert.equal(res.body.status, "missing");
    requirementId = res.body.id;
  });

  await t.test("rejects an unknown technician", async () => {
    const res = await server.call("POST", "/api/technicians/required-forms", {
      userId: "ADMIN",
      body: { techId: "NOPE", name: "x" },
    });
    assert.equal(res.status, 400);
  });

  await t.test("shows up on the roster-wide list, admin only", async () => {
    const techRes = await server.call("GET", "/api/technicians/required-forms", { userId: "T1001" });
    assert.equal(techRes.status, 403);

    const adminRes = await server.call("GET", "/api/technicians/required-forms", { userId: "ADMIN" });
    assert.equal(adminRes.status, 200);
    assert.ok(adminRes.body.some((r) => r.id === requirementId));
  });

  await t.test("the owning technician can see it on their own list; another technician cannot see it on theirs", async () => {
    const ownRes = await server.call("GET", "/api/technicians/T1001/required-forms", { userId: "T1001" });
    assert.equal(ownRes.status, 200);
    assert.ok(ownRes.body.some((r) => r.id === requirementId));

    const otherRes = await server.call("GET", "/api/technicians/T1002/required-forms", { userId: "T1001" });
    assert.equal(otherRes.status, 403);
  });

  await t.test("the owning technician can upload the completed form themselves", async () => {
    const res = await server.upload("/api/files", {
      userId: "T1001",
      fields: { relatedType: "technician_required_form", relatedId: String(requirementId), category: "completed", expiresAt: "2027-01-01" },
      fileName: "consent.pdf",
      fileContent: "pretend signed consent form",
    });
    assert.equal(res.status, 201);
  });

  await t.test("another technician cannot upload to someone else's requirement", async () => {
    const res = await server.upload("/api/files", {
      userId: "T1002",
      fields: { relatedType: "technician_required_form", relatedId: String(requirementId), category: "completed" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("the owning technician cannot upload a 'template' -- that's admin-only", async () => {
    const res = await server.upload("/api/files", {
      userId: "T1001",
      fields: { relatedType: "technician_required_form", relatedId: String(requirementId), category: "template" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("admin can upload a blank template", async () => {
    const res = await server.upload("/api/files", {
      userId: "ADMIN",
      fields: { relatedType: "technician_required_form", relatedId: String(requirementId), category: "template" },
      fileName: "blank-consent.pdf",
      fileContent: "pretend blank form",
    });
    assert.equal(res.status, 201);
  });

  await t.test("status is now on_file", async () => {
    const res = await server.call("GET", "/api/technicians/T1001/required-forms", { userId: "T1001" });
    const req = res.body.find((r) => r.id === requirementId);
    assert.equal(req.status, "on_file");
    assert.equal(req.expiresAt, "2027-01-01");
  });

  await t.test("another technician cannot read the template or the completed file via /api/files", async () => {
    const res = await server.call("GET", `/api/files?relatedType=technician_required_form&relatedId=${requirementId}`, { userId: "T1002" });
    assert.equal(res.status, 403);
  });

  await t.test("admin can delete the requirement, which also removes its files", async () => {
    const delRes = await server.call("DELETE", `/api/technicians/required-forms/${requirementId}`, { userId: "ADMIN" });
    assert.equal(delRes.status, 200);
    const listRes = await server.call("GET", "/api/technicians/required-forms", { userId: "ADMIN" });
    assert.ok(!listRes.body.some((r) => r.id === requirementId));
  });

  await t.test("a technician cannot delete a requirement", async () => {
    const createRes = await server.call("POST", "/api/technicians/required-forms", { userId: "ADMIN", body: { techId: "T1001", name: "Re-created" } });
    const res = await server.call("DELETE", `/api/technicians/required-forms/${createRes.body.id}`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("404s deleting a requirement that doesn't exist", async () => {
    const res = await server.call("DELETE", "/api/technicians/required-forms/999999", { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });
});

test("Roster Required Forms: status computation respects expiry", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const db = require("../server/data/db");

  const requirement = db.createTechnicianRequiredForm({ techId: "T1002", name: "W-4", createdBy: "ADMIN" });

  await t.test("no file yet -> missing", () => {
    const list = db.listTechnicianRequiredForms({ techId: "T1002" });
    assert.equal(list.find((r) => r.id === requirement.id).status, "missing");
  });

  await t.test("an uploaded file with a future expiry -> on_file", async () => {
    const res = await server.upload("/api/files", {
      userId: "T1002",
      fields: { relatedType: "technician_required_form", relatedId: String(requirement.id), category: "completed", expiresAt: "2099-01-01" },
      fileName: "w4.pdf",
      fileContent: "pretend w4",
    });
    assert.equal(res.status, 201);
    const list = db.listTechnicianRequiredForms({ techId: "T1002" });
    assert.equal(list.find((r) => r.id === requirement.id).status, "on_file");
  });

  await t.test("a re-upload with a past expiry -> expired (most recent file wins)", async () => {
    const res = await server.upload("/api/files", {
      userId: "T1002",
      fields: { relatedType: "technician_required_form", relatedId: String(requirement.id), category: "completed", expiresAt: "2000-01-01" },
      fileName: "w4-old.pdf",
      fileContent: "pretend expired w4",
    });
    assert.equal(res.status, 201);
    const list = db.listTechnicianRequiredForms({ techId: "T1002" });
    assert.equal(list.find((r) => r.id === requirement.id).status, "expired");
  });

  await t.test("a file with no expiry at all -> on_file, never expires", async () => {
    const requirement2 = db.createTechnicianRequiredForm({ techId: "T1002", name: "I-9", createdBy: "ADMIN" });
    await server.upload("/api/files", {
      userId: "T1002",
      fields: { relatedType: "technician_required_form", relatedId: String(requirement2.id), category: "completed" },
      fileName: "i9.pdf",
      fileContent: "pretend i9, no expiry",
    });
    const list = db.listTechnicianRequiredForms({ techId: "T1002" });
    assert.equal(list.find((r) => r.id === requirement2.id).status, "on_file");
  });
});
