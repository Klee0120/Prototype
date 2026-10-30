const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

// The native PSE Request intake form (POST /api/woms/requests, db.js's
// createWomRequest) -- a technician requesting a new project themselves,
// replacing the external Smartsheet form. Creates a real 'pending' WOM
// with a placeholder code, same shape a Smartsheet-synced row with no WOM #
// yet already uses (see db.js's "PENDING-${rowId}" for the sync path).
test("woms: native PSE Request intake (self-service WOM creation)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  const nowIso = new Date().toISOString();
  raw
    .prepare("INSERT INTO vendors (name, cw_status, toyota_status, forms_status, created_at, updated_at) VALUES (?, 'active', 'approved', 'current', ?, ?)")
    .run("Acme Plumbing", nowIso, nowIso);
  const vendorId = raw.prepare("SELECT id FROM vendors WHERE name = 'Acme Plumbing'").get().id;

  const validBody = {
    description: "Replace rooftop condenser",
    background: "Unit failed PM inspection, vendor quote attached.",
    locationCode: "PRINCETON",
    propertyCode: "PRIN-001",
    subsidiaryCode: "2002",
    laborHoursEstimate: 8,
    estimatedContracted: 4500,
  };

  let createdCode;

  await t.test("a technician can submit a request for themselves", async () => {
    const res = await server.call("POST", "/api/woms/requests", { userId: "T1001", body: validBody });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "pending");
    assert.match(res.body.code, /^PENDING-REQ-/);
    assert.equal(res.body.description, validBody.description);
    assert.equal(res.body.requestedByTechId, "T1001");
    assert.equal(res.body.laborHoursEstimate, 8);
    assert.equal(res.body.estimatedContracted, 4500);
    assert.equal(res.body.propertyCode, "PRIN-001");
    // Defaults the form itself suggests when left blank.
    assert.equal(res.body.exclusions, "None");
    assert.match(res.body.assumptions, /Monday thru Friday/);
    createdCode = res.body.code;
  });

  await t.test("it shows up in the plain WOM list, same as any other pending WOM", async () => {
    const res = await server.call("GET", "/api/woms", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.ok(res.body.some((w) => w.code === createdCode && w.status === "pending"));
  });

  await t.test("does NOT get auto-marked as already sent to Toyota (the sync heuristic doesn't apply to a brand-new request)", async () => {
    const res = await server.call("GET", "/api/woms", { userId: "ADMIN" });
    const wom = res.body.find((w) => w.code === createdCode);
    const sentStep = wom.lifecycleSteps.find((s) => s.key === "sent_to_toyota");
    assert.ok(!sentStep || !sentStep.completedAt, "Send PSE to Toyota must still be a real, unstarted step for a fresh request");
  });

  await t.test("optional fields default sensibly, vendor/maximo stay null when omitted", async () => {
    const res = await server.call("POST", "/api/woms/requests", { userId: "T1001", body: validBody });
    assert.equal(res.status, 201);
    assert.equal(res.body.vendorId, null);
    assert.equal(res.body.estimatedMaterials, 0);
    assert.equal(res.body.estimatedTax, 0);
    assert.equal(res.body.estimatedContingency, 0);
    assert.equal(res.body.urgent, false);
  });

  await t.test("a real vendor can be attached", async () => {
    const res = await server.call("POST", "/api/woms/requests", { userId: "T1001", body: { ...validBody, vendorId } });
    assert.equal(res.status, 201);
    assert.equal(res.body.vendorId, vendorId);
    assert.equal(res.body.vendorName, "Acme Plumbing");
  });

  await t.test("rejects a nonexistent vendor", async () => {
    const res = await server.call("POST", "/api/woms/requests", { userId: "T1001", body: { ...validBody, vendorId: 999999 } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Vendor not found/);
  });

  await t.test("rejects an unknown location", async () => {
    const res = await server.call("POST", "/api/woms/requests", { userId: "T1001", body: { ...validBody, locationCode: "NOPE" } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Site Location/);
  });

  for (const field of ["description", "background", "propertyCode", "subsidiaryCode"]) {
    await t.test(`rejects a missing ${field}`, async () => {
      const body = { ...validBody, [field]: "" };
      const res = await server.call("POST", "/api/woms/requests", { userId: "T1001", body });
      assert.equal(res.status, 400);
    });
  }

  await t.test("rejects a zero/missing Labor Hrs", async () => {
    const res = await server.call("POST", "/api/woms/requests", { userId: "T1001", body: { ...validBody, laborHoursEstimate: 0 } });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Labor Hrs/);
  });

  await t.test("allows 0 for Estimate PO $ (a C&W-labor-only job)", async () => {
    const res = await server.call("POST", "/api/woms/requests", { userId: "T1001", body: { ...validBody, estimatedContracted: 0 } });
    assert.equal(res.status, 201);
    assert.equal(res.body.estimatedContracted, 0);
  });

  await t.test("an admin can submit on a technician's behalf", async () => {
    const res = await server.call("POST", "/api/woms/requests", { userId: "ADMIN", body: { ...validBody, techId: "T1002" } });
    assert.equal(res.status, 201);
    assert.equal(res.body.requestedByTechId, "T1002");
  });

  await t.test("a technician cannot submit a request for someone else", async () => {
    const res = await server.call("POST", "/api/woms/requests", { userId: "T1001", body: { ...validBody, techId: "T1002" } });
    assert.equal(res.status, 403);
  });

  await t.test("logs an audit entry", async () => {
    const audit = await server.call("GET", "/api/audit", { userId: "ADMIN" });
    assert.ok(audit.body.some((a) => a.action === "WOM_REQUESTED" && a.details.includes(createdCode)));
  });
});
