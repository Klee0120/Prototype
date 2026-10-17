const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

// The technician-facing vendor lookup (GET /api/vendors) is deliberately
// narrower than the admin list: a vendor merely showing up on a list a
// technician looks at reads as "this is fine to use," so it's gated on
// the real-world status fields (cwStatus/toyotaStatus/formsStatus) already
// imported for all 292 existing vendors -- NOT on the newer case-based
// onboardingStage tracker, which defaults every pre-existing vendor to
// "not_started" and would otherwise hide the entire vendor base techs
// already legitimately use today. A vendor explicitly denied during
// (re-)verification is still excluded regardless of its status fields.
test("vendor lookup (technician-facing): gated on real-world status, not the case tracker", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  async function makeVendor(name, overrides) {
    const res = await server.call("POST", "/api/admin/vendors", {
      userId: "ADMIN",
      body: { name, cwStatus: "active", toyotaStatus: "approved", formsStatus: "current", ...overrides },
    });
    return res.body.id;
  }

  const legacyId = await makeVendor("Legacy Established Vendor Co");
  // Never touched by the case tracker -- onboardingStage stays "not_started"
  // from the day-one migration default, same as all 292 real vendors.

  const inactiveId = await makeVendor("Inactive Vendor Co", { cwStatus: "inactive" });
  const notApprovedId = await makeVendor("Not Toyota Approved Co", { toyotaStatus: "not_approved" });
  const outdatedFormsId = await makeVendor("Outdated Forms Co", { formsStatus: "outdated" });

  const deniedDuringRecheckId = await makeVendor("Denied During Recheck Co");
  await server.call("POST", `/api/admin/vendors/${deniedDuringRecheckId}/requests`, {
    userId: "ADMIN",
    body: { requestType: "Onboarding - COI", status: "Denied" },
  });

  await t.test("a technician sees the legacy vendor even though it's Not Started in the case tracker", async () => {
    const res = await server.call("GET", "/api/vendors", { userId: "T1001" });
    assert.equal(res.status, 200);
    assert.ok(res.body.some((v) => v.id === legacyId));
  });

  await t.test("an inactive vendor is left out", async () => {
    const res = await server.call("GET", "/api/vendors", { userId: "T1001" });
    assert.ok(!res.body.some((v) => v.id === inactiveId));
  });

  await t.test("a Toyota-not-approved vendor is left out", async () => {
    const res = await server.call("GET", "/api/vendors", { userId: "T1001" });
    assert.ok(!res.body.some((v) => v.id === notApprovedId));
  });

  await t.test("a vendor with outdated forms is left out", async () => {
    const res = await server.call("GET", "/api/vendors", { userId: "T1001" });
    assert.ok(!res.body.some((v) => v.id === outdatedFormsId));
  });

  await t.test("a vendor denied during a case recheck is left out even though its status fields still say active/approved", async () => {
    const res = await server.call("GET", "/api/vendors", { userId: "T1001" });
    assert.ok(!res.body.some((v) => v.id === deniedDuringRecheckId));
  });

  await t.test("the returned shape is narrow -- no onboarding/compliance internals leak through", async () => {
    const res = await server.call("GET", "/api/vendors", { userId: "T1001" });
    const v = res.body.find((v) => v.id === legacyId);
    assert.deepEqual(Object.keys(v).sort(), ["email", "id", "lastInvoicedAt", "name", "onlineSourceUrl", "phone", "services"].sort());
    assert.equal(v.lastInvoicedAt, null, "a vendor with no invoiced WOMs yet should read null, not undefined or missing");
  });

  await t.test("an admin sees the same filtered list through this endpoint too", async () => {
    const res = await server.call("GET", "/api/vendors", { userId: "ADMIN" });
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((v) => v.id).sort(),
      [legacyId].sort()
    );
  });
});
