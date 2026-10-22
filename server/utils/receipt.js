// Same Reg/OT bucket calculation as public/js/views/techWeek.js's computeReceipt,
// duplicated here (CommonJS vs. browser ES module) so the admin Overview report
// can compute it server-side. Keep the two in sync if the OT rule changes.
const WEEKLY_OT_THRESHOLD = 40;

function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeReceipt(allocations) {
  const buckets = new Map();
  for (const a of allocations) {
    const hours = Number(a.hours || 0);
    if (hours <= 0) continue;
    let kind, code;
    if (a.type === "wom") {
      kind = "wom";
      code = a.womCode;
    } else if (a.type === "ef") {
      kind = "ef";
      code = a.locationCode;
    } else {
      kind = "timeoff";
      code = a.timeOffType;
    }
    const key = `${kind}:${code}`;
    if (!buckets.has(key)) buckets.set(key, { kind, code, hours: 0 });
    const b = buckets.get(key);
    b.hours = round2(b.hours + hours);
  }

  const bucketList = [...buckets.values()];
  const womBuckets = bucketList.filter((b) => b.kind === "wom");
  const efBuckets = bucketList.filter((b) => b.kind === "ef");
  const timeoffBuckets = bucketList.filter((b) => b.kind === "timeoff");

  const sumWom = round2(womBuckets.reduce((s, b) => s + b.hours, 0));
  const sumEf = round2(efBuckets.reduce((s, b) => s + b.hours, 0));
  const totalWorked = round2(sumWom + sumEf);
  const totalTimeOff = round2(timeoffBuckets.reduce((s, b) => s + b.hours, 0));

  const otTotal = round2(Math.max(0, totalWorked - WEEKLY_OT_THRESHOLD));
  const otFromWom = round2(Math.min(otTotal, sumWom));
  const otFromEf = round2(otTotal - otFromWom);

  function distribute(list, otPool, sumPool) {
    let remaining = otPool;
    list.forEach((b, i) => {
      let ot;
      if (sumPool <= 0) ot = 0;
      else if (i === list.length - 1) ot = remaining;
      else ot = round2((otPool * b.hours) / sumPool);
      remaining = round2(remaining - ot);
      b.ot = ot;
      b.reg = round2(b.hours - ot);
    });
  }
  distribute(womBuckets, otFromWom, sumWom);
  distribute(efBuckets, otFromEf, sumEf);
  timeoffBuckets.forEach((b) => {
    b.ot = 0;
    b.reg = b.hours;
  });

  const regularTotal = round2(bucketList.reduce((s, b) => s + b.reg, 0));

  return {
    totalWorked,
    totalTimeOff,
    otTotal,
    otFromWom,
    otFromEf,
    regularTotal,
    buckets: [...womBuckets, ...efBuckets, ...timeoffBuckets],
  };
}

module.exports = { computeReceipt, round2 };
