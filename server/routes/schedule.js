const express = require("express");
const db = require("../data/db");
const { requireAuth } = require("../middleware/auth");
const { DAY_NAMES, mondayOf, datesForWeek, shiftWeek } = require("../utils/week");
const { presentAllocation } = require("../utils/allocation");

const router = express.Router();

// A calendar of WOM project work by actual date, across all technicians --
// deliberately WOM-only (no E&F, no time off), since this is meant to show
// what's scheduled out project-wise, not a general timesheet view. Open to
// any logged-in user, not admin-only, same reasoning as the rest of this
// route: anyone should be able to see what's already on the books before
// scheduling more. These are tentative dates -- a technician's own planned
// allocation for that day, not a locked commitment -- so every entry carries
// enough of the underlying WOM's own detail (status, pricing, budget) for
// the client to show on click without a second round trip, rather than
// implying more certainty than a day/hours split actually has.
router.get("/:month", requireAuth, (req, res) => {
  const { month } = req.params; // "YYYY-MM"
  const { location: locationFilter } = req.query;
  const [y, m] = month.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return res.status(400).json({ error: "month must be in YYYY-MM form" });

  const firstOfMonth = new Date(y, m - 1, 1);
  const lastOfMonth = new Date(y, m, 0);
  const gridStartMonday = mondayOf(firstOfMonth);
  const lastMonday = mondayOf(lastOfMonth);

  const womByCode = Object.fromEntries(db.listWoms().map((w) => [w.code, w]));
  const locationByCode = Object.fromEntries(db.listLocations().map((l) => [l.code, l]));
  const techs = db.listTechnicians().filter((t) => t.employment_status === "active");

  const byDate = {};
  let weekMonday = gridStartMonday;
  while (weekMonday <= lastMonday) {
    const dates = datesForWeek(weekMonday);
    for (const tech of techs) {
      const week = db.getWeek(tech.id, weekMonday);
      for (const raw of week.allocations) {
        const a = presentAllocation(raw);
        if (a.type !== "wom") continue;
        if (locationFilter && a.locationCode !== locationFilter) continue;
        const dateIso = dates[DAY_NAMES.indexOf(a.day)];
        if (!byDate[dateIso]) byDate[dateIso] = [];
        const w = womByCode[a.womCode];
        const loc = locationByCode[a.locationCode];
        byDate[dateIso].push({
          womCode: a.womCode,
          description: w ? w.description : "",
          techName: tech.name,
          hours: a.hours,
          locationCode: a.locationCode,
          locationName: loc ? loc.name : null,
          status: w ? w.status : null,
          budgetHours: w ? w.budget_hours : null,
          remainingHours: w ? w.remainingHours : null,
          subsidiaryCode: w ? w.subsidiary_code : null,
          maximoNumber: w ? w.maximo_number : null,
          estimatedPrice: w ? w.estimated_price : null,
          appliedPrice: w ? w.applied_price : null,
        });
      }
    }
    weekMonday = shiftWeek(weekMonday, 1);
  }

  res.json({ gridStart: gridStartMonday, gridEnd: datesForWeek(lastMonday)[6], byDate });
});

module.exports = router;
