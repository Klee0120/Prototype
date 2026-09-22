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
// scheduling more.
router.get("/:month", requireAuth, (req, res) => {
  const { month } = req.params; // "YYYY-MM"
  const [y, m] = month.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) return res.status(400).json({ error: "month must be in YYYY-MM form" });

  const firstOfMonth = new Date(y, m - 1, 1);
  const lastOfMonth = new Date(y, m, 0);
  const gridStartMonday = mondayOf(firstOfMonth);
  const lastMonday = mondayOf(lastOfMonth);

  const womByCode = Object.fromEntries(db.listWoms().map((w) => [w.code, w]));
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
        const dateIso = dates[DAY_NAMES.indexOf(a.day)];
        if (!byDate[dateIso]) byDate[dateIso] = [];
        const w = womByCode[a.womCode];
        byDate[dateIso].push({
          womCode: a.womCode,
          description: w ? w.description : "",
          techName: tech.name,
          hours: a.hours,
        });
      }
    }
    weekMonday = shiftWeek(weekMonday, 1);
  }

  res.json({ gridStart: gridStartMonday, gridEnd: datesForWeek(lastMonday)[6], byDate });
});

module.exports = router;
