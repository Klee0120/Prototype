const { currentWeekMonday, shiftWeek } = require("../utils/week");

const thisWeek = currentWeekMonday();
const lastWeek = shiftWeek(thisWeek, -1);

function seed() {
  return {
    locations: [
      { code: "PRINCETON", name: "TLS Princeton" },
      { code: "GEORGETOWN", name: "NAPCK Georgetown" },
      { code: "CINCINNATI", name: "TLS Cincinnati" },
    ],

    technicians: [
      {
        id: "T1001",
        name: "Alex Rivera",
        pin: "1234",
        role: "tech",
        active: 1,
        homeLocationCode: "PRINCETON",
        email: "alex.rivera@example.com",
        phone: "609-555-0142",
        ukgId: "5945928",
        position: "Maintenance Technician",
      },
      {
        id: "T1002",
        name: "Jordan Lee",
        pin: "1234",
        role: "tech",
        active: 1,
        homeLocationCode: "GEORGETOWN",
        email: "jordan.lee@example.com",
        phone: "812-555-0198",
        ukgId: "6114371",
        position: "HVAC Maintenance Technician",
      },
      {
        id: "T1003",
        name: "Sam Patel",
        pin: "2345",
        role: "tech",
        active: 1,
        homeLocationCode: "CINCINNATI",
        email: "sam.patel@example.com",
        phone: "513-555-0176",
        ukgId: "6134285",
        position: "Maintenance Technician",
      },
      { id: "ADMIN", name: "Krista Lee", pin: "9999", role: "admin", active: 1, homeLocationCode: null },
    ],

    // Job WOMs are tied to a location and (optionally) a total budget the
    // technicians' hours draw down against. General/non-project time uses
    // the "ef" allocation type instead of a WOM; time off uses "timeoff".
    woms: [
      { code: "WOM-4471", description: "HVAC Replacement - Bldg 3", status: "open", locationCode: "PRINCETON", budgetHours: 120 },
      { code: "WOM-4502", description: "Electrical Panel Upgrade - Bldg 7", status: "open", locationCode: "PRINCETON", budgetHours: 60 },
      { code: "WOM-4610", description: "Plumbing Repair - Cafeteria", status: "open", locationCode: "GEORGETOWN", budgetHours: 40 },
      { code: "WOM-4390", description: "Roof Repair - Bldg 1", status: "closed", locationCode: "CINCINNATI", budgetHours: 80 },
    ],

    // Per-day UKG actual hours per technician per week — the source of
    // truth an admin enters after reviewing that tech's UKG timesheet.
    ukgHours: [
      { techId: "T1001", weekMonday: thisWeek, hours: { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8 } },
      { techId: "T1002", weekMonday: thisWeek, hours: { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 5.5 } },
      { techId: "T1003", weekMonday: thisWeek, hours: { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8, Sat: 4 } },
      { techId: "T1001", weekMonday: lastWeek, hours: { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8 } },
      { techId: "T1002", weekMonday: lastWeek, hours: { Mon: 8, Tue: 8, Wed: 8, Thu: 8, Fri: 8 } },
      { techId: "T1003", weekMonday: lastWeek, hours: { Mon: 8, Tue: 8, Wed: 8, Thu: 8 } },
    ],

    weeks: [
      {
        techId: "T1001",
        weekMonday: lastWeek,
        status: "approved",
        allocations: [
          { day: "Mon", type: "wom", locationCode: "PRINCETON", womCode: "WOM-4471", hours: 8 },
          { day: "Tue", type: "wom", locationCode: "PRINCETON", womCode: "WOM-4471", hours: 8 },
          { day: "Wed", type: "wom", locationCode: "PRINCETON", womCode: "WOM-4502", hours: 8 },
          { day: "Thu", type: "wom", locationCode: "PRINCETON", womCode: "WOM-4502", hours: 8 },
          { day: "Fri", type: "ef", locationCode: "PRINCETON", womCode: null, hours: 8 },
        ],
        submittedAt: thisWeek + "T09:00:00.000Z",
        reviewedAt: thisWeek + "T14:00:00.000Z",
        reviewedBy: "ADMIN",
        note: "",
      },
      {
        techId: "T1002",
        weekMonday: lastWeek,
        status: "approved",
        allocations: [
          { day: "Mon", type: "wom", locationCode: "GEORGETOWN", womCode: "WOM-4610", hours: 8 },
          { day: "Tue", type: "wom", locationCode: "GEORGETOWN", womCode: "WOM-4610", hours: 8 },
          { day: "Wed", type: "wom", locationCode: "GEORGETOWN", womCode: "WOM-4610", hours: 8 },
          { day: "Thu", type: "ef", locationCode: "GEORGETOWN", womCode: null, hours: 8 },
          { day: "Fri", type: "ef", locationCode: "GEORGETOWN", womCode: null, hours: 8 },
        ],
        submittedAt: thisWeek + "T09:10:00.000Z",
        reviewedAt: thisWeek + "T14:05:00.000Z",
        reviewedBy: "ADMIN",
        note: "",
      },
    ],

    auditLog: [
      {
        timestamp: thisWeek + "T14:05:00.000Z",
        actor: "ADMIN",
        action: "WEEK_APPROVED",
        details: `Approved week ${lastWeek} for T1001`,
      },
      {
        timestamp: thisWeek + "T14:06:00.000Z",
        actor: "ADMIN",
        action: "WEEK_APPROVED",
        details: `Approved week ${lastWeek} for T1002`,
      },
    ],
  };
}

module.exports = { seed, thisWeek, lastWeek };
