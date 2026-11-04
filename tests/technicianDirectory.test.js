const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

// A deliberately thin coworker directory -- see GET /api/technicians/directory
// in server/routes/technicians.js. Any logged-in technician (not just admin)
// can see who else is on the roster and where they're based, but nothing an
// admin's own Roster view shows (hire date, UKG ID, forms, devices...), and
// nothing an id to click into. In its own file (not tests/roster.test.js) so
// it gets its own throwaway DB -- roster.test.js resets T1001's PIN partway
// through its own run, and every test file in this suite shares one sqlite
// file for the whole process (see tests/helpers.js).
test("technicians: coworker directory (tech-safe, name + location only)", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  await t.test("a technician can see the directory -- name and location only, nothing else", async () => {
    const res = await server.call("GET", "/api/technicians/directory", { userId: "T1001" });
    assert.equal(res.status, 200);
    const alex = res.body.find((r) => r.name === "Alex Rivera");
    assert.ok(alex);
    assert.equal(alex.locationName, "TLS Princeton");
    assert.deepEqual(Object.keys(alex).sort(), ["locationName", "name"]);
  });

  await t.test("admin accounts never show up -- this is a coworker list, not the full roster", async () => {
    const res = await server.call("GET", "/api/technicians/directory", { userId: "T1001" });
    assert.ok(!res.body.some((r) => r.name === "Krista Lee"));
  });

  await t.test("a terminated technician drops off once their status changes", async () => {
    const before = await server.call("GET", "/api/technicians/directory", { userId: "T1001" });
    assert.ok(before.body.some((r) => r.name === "Jordan Lee"));

    await server.call("PATCH", "/api/admin/technicians/T1002/employment-status", { userId: "ADMIN", body: { status: "terminated" } });

    const after = await server.call("GET", "/api/technicians/directory", { userId: "T1001" });
    assert.ok(!after.body.some((r) => r.name === "Jordan Lee"));
  });

  await t.test("an admin can load it too -- it's just not admin-only", async () => {
    const res = await server.call("GET", "/api/technicians/directory", { userId: "ADMIN" });
    assert.equal(res.status, 200);
  });
});
