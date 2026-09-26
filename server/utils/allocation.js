// Time-off rows are stored using the same columns as WOM rows (womCode
// holds the time-off type instead of a WOM code) to avoid a parallel table;
// translate that back to a clearer shape for API consumers.
function presentAllocation(a) {
  if (a.type === "timeoff") {
    return { day: a.day, type: "timeoff", timeOffType: a.womCode, hours: a.hours };
  }
  return a;
}

module.exports = { presentAllocation };
