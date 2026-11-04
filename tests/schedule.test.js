const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");

test("schedule: WOM-only calendar by date", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const meta = await server.call("GET", "/api/meta/current-week");
  const week = meta.body.weekMonday;
  const [y, m] = week.split("-").map(Number);
  const month = `${y}-${String(m).padStart(2, "0")}`;

  await t.test("requires a logged-in session", async () => {
    const res = await server.call("GET", `/api/schedule/${month}`);
    assert.equal(res.status, 401);
  });

  await t.test("rejects a malformed month", async () => {
    const res = await server.call("GET", "/api/schedule/not-a-month", { userId: "T1002" });
    assert.equal(res.status, 400);
  });

  await t.test("a technician (not just admin) can view the calendar", async () => {
    const res = await server.call("GET", `/api/schedule/${month}`, { userId: "T1002" });
    assert.equal(res.status, 200);
    assert.ok(res.body.gridStart);
    assert.ok(res.body.gridEnd);
    assert.ok(typeof res.body.byDate === "object");
  });

  await t.test("shows only WOM allocations, never E&F or time off", async () => {
    const put = await server.call("PUT", `/api/technicians/T1001/weeks/${week}/allocations`, {
      userId: "ADMIN",
      body: {
        allocations: [
          { day: "Mon", type: "ef", locationCode: "PRINCETON", hours: 8 },
          { day: "Tue", type: "wom", locationCode: "PRINCETON", womCode: "WOM-4471", hours: 8 },
          { day: "Wed", type: "timeoff", timeOffType: "vacation", hours: 8 },
        ],
      },
    });
    assert.equal(put.status, 200);

    const res = await server.call("GET", `/api/schedule/${month}`, { userId: "T1002" });
    assert.equal(res.status, 200);

    const allEntries = Object.values(res.body.byDate).flat();
    assert.ok(allEntries.every((e) => typeof e.womCode === "string"));
    assert.ok(allEntries.some((e) => e.womCode === "WOM-4471" && e.techName === "Alex Rivera" && e.techId === "T1001" && e.hours === 8));

    // The Mon (E&F) and Wed (time off) allocations for T1001, specifically,
    // shouldn't show up as calendar entries on their own dates -- checked by
    // date rather than a blanket "no other 8h Alex Rivera entry anywhere",
    // since Alex legitimately has other seeded WOM work elsewhere in the
    // month that this test isn't about.
    const [wy, wm, wd] = week.split("-").map(Number);
    const mondayDate = new Date(wy, wm - 1, wd);
    const isoFor = (offset) => {
      const d = new Date(mondayDate.getTime());
      d.setDate(mondayDate.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    };
    assert.ok(!(res.body.byDate[isoFor(0)] || []).some((e) => e.techName === "Alex Rivera"));
    assert.ok(!(res.body.byDate[isoFor(2)] || []).some((e) => e.techName === "Alex Rivera"));
  });

  await t.test("entries land on the correct calendar date, not just a day name", async () => {
    const res = await server.call("GET", `/api/schedule/${month}`, { userId: "T1002" });
    const dates = week.split("-").map(Number);
    const monday = new Date(dates[0], dates[1] - 1, dates[2]);
    const tuesday = new Date(monday.getTime());
    tuesday.setDate(monday.getDate() + 1);
    const tuesdayIso = `${tuesday.getFullYear()}-${String(tuesday.getMonth() + 1).padStart(2, "0")}-${String(tuesday.getDate()).padStart(2, "0")}`;

    assert.ok(res.body.byDate[tuesdayIso]);
    assert.ok(res.body.byDate[tuesdayIso].some((e) => e.womCode === "WOM-4471"));
  });

  await t.test("each entry carries its own WOM's detail, for a click-to-see-more panel", async () => {
    const res = await server.call("GET", `/api/schedule/${month}`, { userId: "T1002" });
    const entry = Object.values(res.body.byDate)
      .flat()
      .find((e) => e.womCode === "WOM-4471");
    assert.ok(entry);
    assert.equal(entry.locationCode, "PRINCETON");
    assert.ok(entry.locationName);
    assert.equal(entry.status, "open");
    // budgetHours/remainingHours/estimatedPrice/appliedPrice ride along too
    // (null when the WOM doesn't have them), not just the bare code.
    assert.ok("budgetHours" in entry);
    assert.ok("estimatedPrice" in entry);
    assert.ok("maximoNumber" in entry);
    assert.equal(entry.description, "HVAC Replacement - Bldg 3");
  });

  await t.test("filtering by site only shows that site's WOM work", async () => {
    const put = await server.call("PUT", `/api/technicians/T1002/weeks/${week}/allocations`, {
      userId: "ADMIN",
      body: { allocations: [{ day: "Fri", type: "wom", locationCode: "GEORGETOWN", womCode: "WOM-4610", hours: 3 }] },
    });
    assert.equal(put.status, 200);

    const princeton = await server.call("GET", `/api/schedule/${month}?location=PRINCETON`, { userId: "T1002" });
    const princetonEntries = Object.values(princeton.body.byDate).flat();
    assert.ok(princetonEntries.every((e) => e.locationCode === "PRINCETON"));
    assert.ok(princetonEntries.some((e) => e.womCode === "WOM-4471"));

    const georgetown = await server.call("GET", `/api/schedule/${month}?location=GEORGETOWN`, { userId: "T1002" });
    const georgetownEntries = Object.values(georgetown.body.byDate).flat();
    assert.ok(georgetownEntries.every((e) => e.locationCode === "GEORGETOWN"));
    assert.ok(georgetownEntries.some((e) => e.womCode === "WOM-4610"));
    assert.ok(!georgetownEntries.some((e) => e.womCode === "WOM-4471"));
  });

  await t.test("an inactive technician's WOM work doesn't show up", async () => {
    const put = await server.call("PUT", `/api/technicians/T1003/weeks/${week}/allocations`, {
      userId: "ADMIN",
      body: {
        allocations: [{ day: "Thu", type: "wom", locationCode: "CINCINNATI", womCode: "WOM-4390", hours: 4 }],
      },
    });
    // WOM-4390 is seeded closed, so this may or may not succeed depending on
    // fixture state -- try a definitely-open one as a fallback for the point
    // of this test either way: inactive technicians are excluded.
    if (put.status !== 200) {
      await server.call("PUT", `/api/technicians/T1003/weeks/${week}/allocations`, {
        userId: "ADMIN",
        body: { allocations: [{ day: "Thu", type: "wom", locationCode: "CINCINNATI", womCode: "WOM-4471", hours: 4 }] },
      });
    }

    await server.call("PATCH", "/api/admin/technicians/T1003/employment-status", {
      userId: "ADMIN",
      body: { status: "inactive" },
    });

    const res = await server.call("GET", `/api/schedule/${month}`, { userId: "T1002" });
    const allEntries = Object.values(res.body.byDate).flat();
    assert.ok(!allEntries.some((e) => e.techName === "Sam Patel"));

    await server.call("PATCH", "/api/admin/technicians/T1003/employment-status", {
      userId: "ADMIN",
      body: { status: "active" },
    });
  });
});
