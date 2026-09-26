const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");
const week = require("../server/utils/week");

test("week window: classifyWeekForTech / getOpenWeekMonday (pure logic)", async (t) => {
  t.after(() => week.setTestNow(null));

  await t.test("Thursday through Sunday: this week is open", () => {
    for (const [y, m, d] of [
      [2026, 9, 17], // Thu
      [2026, 9, 18], // Fri
      [2026, 9, 19], // Sat
      [2026, 9, 20], // Sun
    ]) {
      const now = week.businessNowFromParts(y, m, d, 10, 0);
      assert.equal(week.getOpenWeekMonday(now), "2026-09-14");
      assert.equal(week.classifyWeekForTech("2026-09-14", now), "open");
      assert.equal(week.classifyWeekForTech("2026-09-07", now), "past");
      assert.equal(week.classifyWeekForTech("2026-09-21", now), "future");
    }
  });

  await t.test("Monday before noon: last week's window is still open", () => {
    const now = week.businessNowFromParts(2026, 9, 21, 9, 0);
    assert.equal(week.getOpenWeekMonday(now), "2026-09-14");
    assert.equal(week.classifyWeekForTech("2026-09-14", now), "open");
    assert.equal(week.classifyWeekForTech("2026-09-07", now), "past");
    assert.equal(week.classifyWeekForTech("2026-09-21", now), "future");
  });

  await t.test("Monday at/after noon, Tuesday, Wednesday: the gap -- nothing is open", () => {
    for (const [y, m, d, h] of [
      [2026, 9, 21, 12], // Mon noon exactly
      [2026, 9, 21, 15], // Mon afternoon
      [2026, 9, 22, 10], // Tue
      [2026, 9, 23, 10], // Wed
    ]) {
      const now = week.businessNowFromParts(y, m, d, h, 0);
      assert.equal(week.getOpenWeekMonday(now), null);
      assert.equal(week.classifyWeekForTech("2026-09-14", now), "past");
      assert.equal(week.classifyWeekForTech("2026-09-21", now), "future");
      assert.equal(week.classifyWeekForTech("2026-09-28", now), "future");
    }
  });
});

test("week window: route enforcement for technicians vs admin", async (t) => {
  const server = await startServer();
  t.after(() => {
    server.close();
    week.setTestNow(null);
  });

  // Fixed, safely-past dates (all Mondays, 7 days apart) rather than dates
  // near "today" -- seed data's thisWeek/lastWeek roll forward with the
  // real calendar, so a literal close to today will eventually collide
  // with one of those (as happened here once already). 2024-01-08 etc.
  // will never collide with "today" in this app's lifetime.
  const OPEN_WEEK = "2024-01-08";
  const PAST_WEEK = "2024-01-01";
  const FUTURE_WEEK = "2024-01-15";

  // Pin "now" to Thursday of the open week's window.
  week.setTestNow(week.businessNowFromParts(2024, 1, 11, 10, 0));

  await t.test("technician has full access to the open week", async () => {
    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${OPEN_WEEK}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", type: "ef", locationCode: "PRINCETON", hours: 8 }] },
    });
    assert.equal(put.status, 200);

    const get = await server.call("GET", `/api/technicians/T1001/weeks/${OPEN_WEEK}`, { userId: "T1001" });
    assert.equal(get.body.editMode, "full");
  });

  await t.test("technician cannot touch a past week at all", async () => {
    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${PAST_WEEK}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", type: "ef", locationCode: "PRINCETON", hours: 8 }] },
    });
    assert.equal(put.status, 409);

    const get = await server.call("GET", `/api/technicians/T1001/weeks/${PAST_WEEK}`, { userId: "T1001" });
    assert.equal(get.status, 200); // read-only viewing is still fine
    assert.equal(get.body.editMode, "locked");
  });

  await t.test("technician can only pre-enter time off on a future week, and cannot submit it", async () => {
    const badPut = await server.call("PUT", `/api/technicians/T1001/weeks/${FUTURE_WEEK}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", type: "ef", locationCode: "PRINCETON", hours: 8 }] },
    });
    assert.equal(badPut.status, 400);

    const goodPut = await server.call("PUT", `/api/technicians/T1001/weeks/${FUTURE_WEEK}/allocations`, {
      userId: "T1001",
      body: { allocations: [{ day: "Mon", type: "timeoff", timeOffType: "vacation", hours: 8 }] },
    });
    assert.equal(goodPut.status, 200);

    const submit = await server.call("POST", `/api/technicians/T1001/weeks/${FUTURE_WEEK}/submit`, { userId: "T1001" });
    assert.equal(submit.status, 409);

    const get = await server.call("GET", `/api/technicians/T1001/weeks/${FUTURE_WEEK}`, { userId: "T1001" });
    assert.equal(get.body.editMode, "timeoff-only");
    assert.equal(get.body.allocations[0].type, "timeoff");
  });

  await t.test("admin is never restricted by the window", async () => {
    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${PAST_WEEK}/allocations`, {
      userId: "ADMIN",
      body: { allocations: [{ day: "Mon", type: "ef", locationCode: "PRINCETON", hours: 8 }] },
    });
    assert.equal(put.status, 200);

    const futurePut = await server.call("PUT", `/api/technicians/T1001/weeks/${FUTURE_WEEK}/allocations`, {
      userId: "ADMIN",
      body: { allocations: [{ day: "Tue", type: "wom", locationCode: "PRINCETON", womCode: "WOM-4471", hours: 8 }] },
    });
    assert.equal(futurePut.status, 200);
  });

  await t.test("a rejected week is always fully editable for the technician, regardless of the window", async () => {
    // Move T1002's PAST_WEEK to rejected via a full submit+reject cycle.
    const fullAlloc = ["Mon", "Tue", "Wed", "Thu", "Fri"].map((day) => ({ day, type: "ef", locationCode: "GEORGETOWN", hours: 8 }));
    await server.call("PUT", `/api/technicians/T1002/weeks/${PAST_WEEK}/allocations`, {
      userId: "ADMIN",
      body: { allocations: fullAlloc },
    });
    // UKG hours default to 8/day Mon-Fri in seed only for "thisWeek"/"lastWeek"; set them explicitly here.
    await server.call("PUT", `/api/admin/weeks/T1002/${PAST_WEEK}/ukg-hours`, {
      userId: "ADMIN",
      body: { hours: { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8 } },
    });
    const submit = await server.call("POST", `/api/technicians/T1002/weeks/${PAST_WEEK}/submit`, { userId: "ADMIN" });
    assert.equal(submit.status, 200);

    const reject = await server.call("POST", `/api/admin/weeks/T1002/${PAST_WEEK}/reject`, { userId: "ADMIN" });
    assert.equal(reject.status, 200);

    const get = await server.call("GET", `/api/technicians/T1002/weeks/${PAST_WEEK}`, { userId: "T1002" });
    assert.equal(get.body.status, "rejected");
    assert.equal(get.body.editMode, "full");

    const put = await server.call("PUT", `/api/technicians/T1002/weeks/${PAST_WEEK}/allocations`, {
      userId: "T1002",
      body: { allocations: fullAlloc },
    });
    assert.equal(put.status, 200);
  });
});
