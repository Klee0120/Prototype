const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("allocation: per-day hour validation, splits, and locking", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const meta = await server.call("GET", "/api/meta/current-week");
  const week = meta.body.weekMonday;

  await t.test("starts as an empty draft with the per-day UKG targets visible", async () => {
    const res = await server.call("GET", `/api/technicians/T1001/weeks/${week}`, { userId: "T1001" });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "draft");
    assert.equal(res.body.ukgHoursByDay.Mon, 8);
    assert.equal(res.body.ukgTotal, 40);
    assert.equal(res.body.allocatedTotal, 0);
    assert.equal(res.body.locked, false);
  });

  await t.test("rejects a WOM-type split against a closed WOM", async () => {
    const res = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", type: "wom", locationCode: "CINCINNATI", womCode: "WOM-4390", hours: 8 }] },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /not open/);
  });

  await t.test("rejects a split against an unknown WOM", async () => {
    const res = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", type: "wom", locationCode: "PRINCETON", womCode: "NOPE", hours: 8 }] },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Unknown WOM/);
  });

  await t.test("rejects a WOM split whose location doesn't match the WOM's own location", async () => {
    const res = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", type: "wom", locationCode: "GEORGETOWN", womCode: "WOM-4471", hours: 8 }] },
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /does not belong to location/);
  });

  await t.test("a technician cannot edit another technician's allocations", async () => {
    const res = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1002",
      body: { allocations: [] },
    });
    assert.equal(res.status, 403);
  });

  await t.test("blocks submit when any day's allocated hours don't match that day's UKG hours", async () => {
    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: {
        allocations: [
          { day: "Mon", type: "ef", locationCode: "PRINCETON", hours: 8 },
          { day: "Tue", type: "ef", locationCode: "PRINCETON", hours: 3 },
        ],
      },
    });
    assert.equal(put.status, 200);

    const submit = await server.call("POST", `/api/technicians/T1001/weeks/${week}/submit`, { userId: "T1001" });
    assert.equal(submit.status, 400);
    const tueMismatch = submit.body.mismatches.find((m) => m.day === "Tue");
    assert.equal(tueMismatch.allocated, 3);
    assert.equal(tueMismatch.ukgHours, 8);
  });

  await t.test("allows splitting a day between E&F and a WOM project, plus time off, once every day balances", async () => {
    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "T1001",
      body: {
        allocations: [
          { day: "Mon", type: "ef", locationCode: "PRINCETON", hours: 6 },
          { day: "Mon", type: "wom", locationCode: "PRINCETON", womCode: "WOM-4471", hours: 2 },
          { day: "Tue", type: "wom", locationCode: "PRINCETON", womCode: "WOM-4471", hours: 8 },
          { day: "Wed", type: "timeoff", timeOffType: "vacation", hours: 8 },
          { day: "Thu", type: "ef", locationCode: "PRINCETON", hours: 8 },
          { day: "Fri", type: "ef", locationCode: "PRINCETON", hours: 8 },
        ],
      },
    });
    assert.equal(put.status, 200);

    const get = await server.call("GET", `/api/technicians/T1001/weeks/${week}`, { userId: "T1001" });
    assert.equal(get.body.allocatedByDay.Mon, 8);
    const wed = get.body.allocations.find((a) => a.day === "Wed");
    assert.equal(wed.type, "timeoff");
    assert.equal(wed.timeOffType, "vacation");

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

  await t.test("rejects an invalid time off type", async () => {
    const put = await server.call("PUT", `/api/technicians/T1002/weeks/${week}/allocations`, {
      userId: "T1002",
      body: { allocations: [{ day: "Mon", type: "timeoff", timeOffType: "nope", hours: 8 }] },
    });
    assert.equal(put.status, 400);
    assert.match(put.body.error, /time off type/);
  });

  await t.test("floating point hours within tolerance are accepted (e.g. a 5.5h Friday)", async () => {
    const put = await server.call("PUT", `/api/technicians/T1002/weeks/${week}/allocations`, {
      userId: "T1002",
      body: {
        allocations: [
          { day: "Mon", type: "ef", locationCode: "GEORGETOWN", hours: 8 },
          { day: "Tue", type: "ef", locationCode: "GEORGETOWN", hours: 8 },
          { day: "Wed", type: "ef", locationCode: "GEORGETOWN", hours: 8 },
          { day: "Thu", type: "ef", locationCode: "GEORGETOWN", hours: 8 },
          { day: "Fri", type: "ef", locationCode: "GEORGETOWN", hours: 5.5 },
        ],
      },
    });
    assert.equal(put.status, 200);

    const submit = await server.call("POST", `/api/technicians/T1002/weeks/${week}/submit`, { userId: "T1002" });
    assert.equal(submit.status, 200);
  });
});
