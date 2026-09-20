const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("allocation: weekly hour validation and locking", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const meta = await server.call("GET", "/api/meta/current-week");
  const week = meta.body.weekMonday;

  await t.test("starts as an empty draft with the UKG target visible", async () => {
    const res = await server.call("GET", `/api/technicians/T1001/weeks/${week}`, { userId: "T1001" });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "draft");
    assert.equal(res.body.ukgHours, 40);
    assert.equal(res.body.allocatedHours, 0);
    assert.equal(res.body.locked, false);
  });

  await t.test("rejects an allocation against a closed WOM", async () => {
    const res = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", womCode: "WOM-4390", hours: 8 }] },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not open/);
  });

  await t.test("rejects an allocation against an unknown WOM", async () => {
    const res = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", womCode: "NOPE", hours: 8 }] },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Unknown WOM/);
  });

  await t.test("a technician cannot edit another technician's allocations", async () => {
    const res = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1002",
      body: { allocations: [] },
    });
    assert.equal(res.status, 403);
  });

  await t.test("blocks submit when allocated hours don't match UKG hours", async () => {
    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: {
        allocations: [
          { day: "Mon", womCode: "WOM-4471", hours: 8 },
          { day: "Tue", womCode: "WOM-4471", hours: 8 },
        ],
      },
    });
    assert.equal(put.status, 200);

    const submit = await server.call("POST", `/api/technicians/T1001/weeks/${week}/submit`, { userId: "T1001" });
    assert.equal(submit.status, 400);
    assert.equal(submit.body.allocatedHours, 16);
    assert.equal(submit.body.ukgHours, 40);
  });

  await t.test("allows submit once allocated hours exactly equal UKG hours", async () => {
    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: {
        allocations: [
          { day: "Mon", womCode: "WOM-4471", hours: 8 },
          { day: "Tue", womCode: "WOM-4471", hours: 8 },
          { day: "Wed", womCode: "WOM-4502", hours: 8 },
          { day: "Thu", womCode: "WOM-4502", hours: 8 },
          { day: "Fri", womCode: "GEN-ADMIN", hours: 8 },
        ],
      },
    });
    assert.equal(put.status, 200);

    const submit = await server.call("POST", `/api/technicians/T1001/weeks/${week}/submit`, { userId: "T1001" });
    assert.equal(submit.status, 200);
    assert.equal(submit.body.status, "submitted");
  });

  await t.test("locks the week from further edits once submitted", async () => {
    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: { allocations: [] },
    });
    assert.equal(put.status, 409);

    const get = await server.call("GET", `/api/technicians/T1001/weeks/${week}`, { userId: "T1001" });
    assert.equal(get.body.locked, true);
    assert.equal(get.body.status, "submitted");
  });

  await t.test("floating point hours within tolerance are accepted (e.g. a 37.5h week)", async () => {
    const put = await server.call("PUT", `/api/technicians/T1002/weeks/${week}/allocations`, {
      userId: "T1002",
      body: { allocations: [{ day: "Mon", womCode: "WOM-4610", hours: 37.5 }] },
    });
    assert.equal(put.status, 200);

    const submit = await server.call("POST", `/api/technicians/T1002/weeks/${week}/submit`, { userId: "T1002" });
    assert.equal(submit.status, 200);
  });
});
