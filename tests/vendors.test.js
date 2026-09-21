const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("vendors: onboarding/compliance tracker CRUD + authorization", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("a technician cannot list vendors", async () => {
    const res = await server.call("GET", "/api/admin/vendors", { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("admin sees an empty list before any vendors exist", async () => {
    const res = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
  });

  await t.test("a technician cannot create a vendor", async () => {
    const res = await server.call("POST", "/api/admin/vendors", {
      userId: "T1001",
      body: { name: "Hijack Vendor" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("name is required", async () => {
    const res = await server.call("POST", "/api/admin/vendors", { userId: "ADMIN", body: {} });
    assert.equal(res.status, 400);
  });

  await t.test("rejects an invalid status value", async () => {
    const res = await server.call("POST", "/api/admin/vendors", {
      userId: "ADMIN",
      body: { name: "Bad Status Co", cwStatus: "sort-of" },
    });
    assert.equal(res.status, 400);
  });

  let vendorId;
  await t.test("admin can create a vendor, defaulting unset statuses to unknown", async () => {
    const res = await server.call("POST", "/api/admin/vendors", {
      userId: "ADMIN",
      body: { name: "24/7 Fire Protection", jdeVendorNumber: "5865247", toyotaStatus: "approved" },
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.name, "24/7 Fire Protection");
    assert.equal(res.body.jdeVendorNumber, "5865247");
    assert.equal(res.body.toyotaStatus, "approved");
    assert.equal(res.body.cwStatus, "unknown");
    assert.equal(res.body.formsStatus, "unknown");
    vendorId = res.body.id;
  });

  await t.test("the new vendor shows up in the list", async () => {
    const res = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.equal(res.body.length, 1);
    assert.equal(res.body[0].id, vendorId);
  });

  await t.test("a technician cannot edit a vendor", async () => {
    const res = await server.call("PATCH", `/api/admin/vendors/${vendorId}`, {
      userId: "T1001",
      body: { name: "Hijacked" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("admin can edit a vendor's status and detail fields", async () => {
    const res = await server.call("PATCH", `/api/admin/vendors/${vendorId}`, {
      userId: "ADMIN",
      body: {
        name: "24/7 Fire Protection",
        cwStatus: "active",
        toyotaStatus: "approved",
        formsStatus: "outdated",
        phone: "(513) 555-0100",
        services: "Fire/Life Safety",
        successfulInvoiceRecords: 2,
      },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.cwStatus, "active");
    assert.equal(res.body.formsStatus, "outdated");
    assert.equal(res.body.phone, "(513) 555-0100");
    assert.equal(res.body.services, "Fire/Life Safety");
    assert.equal(res.body.successfulInvoiceRecords, 2);
  });

  await t.test("editing an unknown vendor 404s", async () => {
    const res = await server.call("PATCH", "/api/admin/vendors/999999", {
      userId: "ADMIN",
      body: { name: "Nope" },
    });
    assert.equal(res.status, 404);
  });

  await t.test("a technician cannot delete a vendor", async () => {
    const res = await server.call("DELETE", `/api/admin/vendors/${vendorId}`, { userId: "T1001" });
    assert.equal(res.status, 403);
  });

  await t.test("admin can delete a vendor", async () => {
    const res = await server.call("DELETE", `/api/admin/vendors/${vendorId}`, { userId: "ADMIN" });
    assert.equal(res.status, 200);

    const list = await server.call("GET", "/api/admin/vendors", { userId: "ADMIN" });
    assert.deepEqual(list.body, []);
  });

  await t.test("deleting an already-deleted vendor 404s", async () => {
    const res = await server.call("DELETE", `/api/admin/vendors/${vendorId}`, { userId: "ADMIN" });
    assert.equal(res.status, 404);
  });

  await t.test("vendor create/update/delete are audited", async () => {
    const res = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    const actions = res.body.map((e) => e.action);
    assert.ok(actions.includes("VENDOR_CREATED"));
    assert.ok(actions.includes("VENDOR_UPDATED"));
    assert.ok(actions.includes("VENDOR_DELETED"));
  });
});
