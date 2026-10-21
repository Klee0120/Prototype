const test = require("node:test");
const assert = require("node:assert/strict");
const { startServer } = require("./helpers");
const { DatabaseSync } = require("node:sqlite");

test("GL Screening: each reclass-review rule fires on the line it's meant to, and leaves a clean line alone", async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const db = require("../server/data/db");
  const raw = new DatabaseSync(process.env.LABOR_DB_PATH);
  t.after(() => raw.close());

  // A synthetic fiscal year nothing else in this file touches, same
  // reasoning as the Cell Phones test's own isolated FY -- getGlScreeningFlags
  // has no period-level default filter, so a shared year would pick up
  // rows from other tests too.
  const FY = 46;
  const PERIOD = 3;

  raw.prepare("INSERT INTO locations (code, name, ef_job_number, pps_job_number, wom_job_number, territory) VALUES (?, ?, ?, ?, ?, ?)").run(
    "GLSCREEN-SITE",
    "GL Screening Test Site",
    "EF-JOB-001",
    "PPS-JOB-001",
    "WOM-JOB-001",
    "Midwest"
  );

  db.importGlEntries(
    [
      // 1. Large amount -- otherwise clean.
      { glDate: "2026-03-01", objectAccount: "999000 - Gen~Misc", subsidiary: "99999999", amount: 9000, remark: "big one" },
      // 2. Calero -- flagged for manual iPad review regardless of amount/object code.
      { glDate: "2026-03-01", objectAccount: "647200 - Gen~Cell Phone", subsidiary: "99999999", amount: 38.21, nameAlpha: "CALERO SOFTWARE LLC", remark: "2059944582" },
      // 3. Allegis temp labor on 605300 -- the one rule with a deterministic suggested fix.
      { glDate: "2026-03-01", objectAccount: "605300 - Gen~Sub NonRecur Lab", subsidiary: "10010010", amount: 500, nameAlpha: "ALLEGIS GLOBAL SOLUTIONS" },
      // 3b. Allegis on 605400 too -- the rule's other listed object code.
      { glDate: "2026-03-01", objectAccount: "605400 - Gen~Sub NonRecur Lab", subsidiary: "10010010", amount: 500, nameAlpha: "ALLEGIS GLOBAL SOLUTIONS" },
      // 3c. Allegis on an unrelated object code -- should NOT flag (confirms the rule needs both name AND code).
      { glDate: "2026-03-01", objectAccount: "601000 - Gen~Labor", subsidiary: "20920000", amount: 500, nameAlpha: "ALLEGIS GLOBAL SOLUTIONS" },
      // 4. Concur not on subsidiary 10910000.
      { glDate: "2026-03-01", objectAccount: "620100 - Gen~Travel", subsidiary: "99999999", amount: 250, nameAlpha: "CONCUR TECHNOLOGIES" },
      // 4b. Concur already correctly on 10910000 -- should NOT flag.
      { glDate: "2026-03-01", objectAccount: "620100 - Gen~Travel", subsidiary: "10910000", amount: 250, nameAlpha: "CONCUR TECHNOLOGIES" },
      // 5. Labor (object 601000) on a subsidiary that isn't 20920000/10910000 --
      // this is the exact real-world pattern from Krista's own October findings
      // file (Payroll Labor Distribution landing on 10010010).
      { glDate: "2026-03-01", objectAccount: "601000 - Events~Labor", subsidiary: "10010010", amount: 376.2, nameAlpha: "Payroll Labor Distribution" },
      // 5b. Labor correctly on 20920000 -- should NOT flag.
      { glDate: "2026-03-01", objectAccount: "601000 - Events~Labor", subsidiary: "20920000", amount: 376.2, nameAlpha: "Payroll Labor Distribution" },
      // 5c. PPS-coded labor on its own valid PPS subsidiary -- should NOT flag
      // labor_subsidiary (PPS labor isn't held to the 20920000/10910000
      // standard; pps_subsidiary_mismatch is what checks PPS subsidiaries).
      { glDate: "2026-03-01", objectAccount: "601000 - Gen Jan~Labor", subsidiary: "15915000", amount: 900, nameAlpha: "Payroll Labor Distribution", businessUnit: "PPS-JOB-001" },
      // 5d. PPS-coded labor on a genuinely wrong (non-PPS) subsidiary -- should
      // flag pps_subsidiary_mismatch, but NOT labor_subsidiary (that standard
      // doesn't apply to a PPS job).
      { glDate: "2026-03-01", objectAccount: "601000 - Gen Jan~Labor", subsidiary: "99999999", amount: 901, nameAlpha: "Payroll Labor Distribution", businessUnit: "PPS-JOB-001" },
      // 6. WOM-coded (business unit = the location's own wom_job_number) with no subledger.
      { glDate: "2026-03-01", objectAccount: "605250 - Gen~Sub Recur Matl", subsidiary: "99999999", amount: 100, businessUnit: "WOM-JOB-001" },
      // 6b. Same WOM job number, but WITH a subledger -- should NOT flag rule 6.
      { glDate: "2026-03-01", objectAccount: "605250 - Gen~Sub Recur Matl", subsidiary: "99999999", amount: 100, businessUnit: "WOM-JOB-001", subledgerGl: "W-12345" },
      // 7. E&F-coded (business unit = ef_job_number) but STILL carries a WOM-style subledger -- the mixed-coding case.
      { glDate: "2026-03-01", objectAccount: "605250 - Gen~Sub Recur Matl", subsidiary: "99999999", amount: 100, businessUnit: "EF-JOB-001", subledgerGl: "W-99999" },
      // 8. Credit (negative amount) on a WOM job.
      { glDate: "2026-03-01", objectAccount: "605250 - Gen~Sub Recur Matl", subsidiary: "99999999", amount: -300, businessUnit: "WOM-JOB-001" },
      // 9. PPS-coded (business unit = pps_job_number) with a non-PPS (Yellow/E&F) subsidiary.
      { glDate: "2026-03-01", objectAccount: "605250 - Gen~Sub Recur Matl", subsidiary: "20920000", amount: 100, businessUnit: "PPS-JOB-001" },
      // 9b. PPS-coded with a real PPS (Green) subsidiary -- should NOT flag.
      { glDate: "2026-03-01", objectAccount: "605250 - Gen~Sub Recur Matl", subsidiary: "15915000", amount: 100, businessUnit: "PPS-JOB-001" },
      // A fully clean line -- small amount, no special vendor, no job-number coding, nothing to flag.
      { glDate: "2026-03-01", objectAccount: "610000 - Gen~Supplies", subsidiary: "99999999", amount: 42, nameAlpha: "OFFICE DEPOT" },
    ],
    PERIOD,
    FY,
    "ADMIN",
    "t-glscreening.xlsx"
  );

  const res = await server.call("GET", `/api/admin/gl/screening?fiscalYear=${FY}&periodNumber=${PERIOD}`, { userId: "ADMIN" });
  assert.equal(res.status, 200);
  const { items } = res.body;

  const byAmount = (amt, nameAlpha) => items.find((it) => it.amount === amt && (!nameAlpha || it.nameAlpha === nameAlpha));
  const ruleKeys = (it) => it.reasons.map((r) => r.ruleKey);

  await t.test("large_amount flags the 9000 line and nothing smaller", () => {
    const big = byAmount(9000);
    assert.ok(big, "the $9000 line should be flagged");
    assert.ok(ruleKeys(big).includes("large_amount"));
    const cleanLine = items.find((it) => it.nameAlpha === "OFFICE DEPOT");
    assert.equal(cleanLine, undefined, "a small, unremarkable line should never show up flagged");
  });

  await t.test("calero_ipad_review flags any Calero line regardless of amount", () => {
    const calero = byAmount(38.21);
    assert.ok(calero);
    assert.ok(ruleKeys(calero).includes("calero_ipad_review"));
  });

  await t.test("temp_labor_reclass fires on Allegis + 605300/605400 only, with the suggested target pre-filled", () => {
    const allegis605300 = items.find((it) => it.objectAccountCode === "605300" && it.nameAlpha === "ALLEGIS GLOBAL SOLUTIONS");
    const allegis605400 = items.find((it) => it.objectAccountCode === "605400" && it.nameAlpha === "ALLEGIS GLOBAL SOLUTIONS");
    assert.ok(allegis605300 && allegis605400, "both listed object codes should flag");
    for (const line of [allegis605300, allegis605400]) {
      const reason = line.reasons.find((r) => r.ruleKey === "temp_labor_reclass");
      assert.ok(reason);
      assert.equal(reason.suggestedToObjectCode, "601000");
    }
    const allegisWrongCode = items.find((it) => it.objectAccountCode === "601000" && it.nameAlpha === "ALLEGIS GLOBAL SOLUTIONS");
    assert.equal(allegisWrongCode, undefined, "Allegis on an object code outside 605300/605400 should not trigger this rule");
  });

  await t.test("concur_reclass fires only when the subsidiary isn't already 10910000", () => {
    const wrongSub = items.find((it) => it.nameAlpha === "CONCUR TECHNOLOGIES" && it.subsidiary === "99999999");
    const rightSub = items.find((it) => it.nameAlpha === "CONCUR TECHNOLOGIES" && it.subsidiary === "10910000");
    assert.ok(wrongSub, "Concur not on 10910000 should flag");
    assert.equal(wrongSub.reasons.find((r) => r.ruleKey === "concur_reclass").suggestedToSubsidiary, "10910000");
    assert.equal(rightSub, undefined, "Concur already on 10910000 should not flag");
  });

  await t.test("labor_subsidiary fires on object 601000 off 20920000/10910000 -- the exact real-world pattern from Krista's own findings", () => {
    const wrongSub = items.find((it) => it.objectAccountCode === "601000" && it.subsidiary === "10010010");
    const rightSub = items.find((it) => it.objectAccountCode === "601000" && it.subsidiary === "20920000");
    assert.ok(wrongSub);
    assert.ok(ruleKeys(wrongSub).includes("labor_subsidiary"));
    assert.equal(rightSub, undefined, "Labor already on a valid subsidiary should not flag");
  });

  await t.test("labor_subsidiary excludes PPS-coded labor -- PPS has its own valid subsidiary set, checked by pps_subsidiary_mismatch instead", () => {
    const ppsLaborOnValidPpsSub = items.find((it) => it.businessUnit === "PPS-JOB-001" && it.amount === 900);
    assert.equal(ppsLaborOnValidPpsSub, undefined, "PPS labor correctly coded to a real PPS subsidiary should not flag anything");

    const ppsLaborOnWrongSub = items.find((it) => it.businessUnit === "PPS-JOB-001" && it.amount === 901);
    assert.ok(ppsLaborOnWrongSub, "PPS labor on a genuinely wrong subsidiary should still flag");
    assert.ok(ruleKeys(ppsLaborOnWrongSub).includes("pps_subsidiary_mismatch"));
    assert.ok(!ruleKeys(ppsLaborOnWrongSub).includes("labor_subsidiary"), "but not under the labor_subsidiary standard, which doesn't apply to PPS jobs");
  });

  await t.test("wom_without_subledger fires on a WOM-job-coded line with no subledger, not when one's present", () => {
    const noSubledger = items.find((it) => it.businessUnit === "WOM-JOB-001" && it.amount === 100 && !it.subledgerGl);
    const withSubledger = items.find((it) => it.businessUnit === "WOM-JOB-001" && it.subledgerGl === "W-12345");
    assert.ok(noSubledger);
    assert.ok(ruleKeys(noSubledger).includes("wom_without_subledger"));
    assert.equal(withSubledger, undefined, "a WOM line that DOES carry its subledger should not flag this rule");
  });

  await t.test("ef_wom_mixed (high severity) fires when an E&F-coded line still carries a WOM-style subledger", () => {
    const mixed = items.find((it) => it.businessUnit === "EF-JOB-001");
    assert.ok(mixed);
    const reason = mixed.reasons.find((r) => r.ruleKey === "ef_wom_mixed");
    assert.ok(reason);
    assert.equal(reason.severity, "high");
  });

  await t.test("credit_wom_research fires on a negative amount coded to a WOM job", () => {
    const credit = items.find((it) => it.amount === -300);
    assert.ok(credit);
    assert.ok(ruleKeys(credit).includes("credit_wom_research"));
  });

  await t.test("pps_subsidiary_mismatch fires on a PPS job with a non-PPS (Yellow/E&F) subsidiary, not a real PPS one", () => {
    const wrongSub = items.find((it) => it.businessUnit === "PPS-JOB-001" && it.subsidiary === "20920000");
    const rightSub = items.find((it) => it.businessUnit === "PPS-JOB-001" && it.subsidiary === "15915000");
    assert.ok(wrongSub);
    assert.ok(ruleKeys(wrongSub).includes("pps_subsidiary_mismatch"));
    assert.equal(rightSub, undefined, "a PPS job on a real Green/PPS subsidiary should not flag");
  });

  await t.test("byRule aggregates count/total correctly", () => {
    const largeAmountAgg = res.body.byRule.find((r) => r.ruleKey === "large_amount");
    assert.equal(largeAmountAgg.count, 1);
    assert.equal(largeAmountAgg.total, 9000);
  });

  await t.test("a technician can't reach the screening route", async () => {
    const techRes = await server.call("GET", "/api/admin/gl/screening", { userId: "T1001" });
    assert.equal(techRes.status, 403);
  });
});

test("GL Screening: adding a flagged line to the Reclass list uses source=auto_flagged; the ordinary manual form still defaults to manual", async (t) => {
  const server = await startServer();
  t.after(() => server.close());

  const autoFlagged = await server.call("POST", "/api/admin/reclasses/items", {
    userId: "ADMIN",
    body: {
      fromJobNumber: "WOM-JOB-001",
      fromObjectCode: "605250",
      fromSubsidiary: "99999999",
      fromAmount: 100,
      vendor: "Test Vendor",
      comments: "GL Screening flagged: WOM-coded line missing its WOM subledger",
      source: "auto_flagged",
    },
  });
  assert.equal(autoFlagged.status, 201);
  assert.equal(autoFlagged.body.source, "auto_flagged");

  const manual = await server.call("POST", "/api/admin/reclasses/items", {
    userId: "ADMIN",
    body: { fromJobNumber: "WOM-JOB-001", comments: "typed in by hand" },
  });
  assert.equal(manual.status, 201);
  assert.equal(manual.body.source, "manual", "omitting source entirely should still default to manual");

  const bogusSource = await server.call("POST", "/api/admin/reclasses/items", {
    userId: "ADMIN",
    body: { fromJobNumber: "WOM-JOB-001", comments: "trying to inject a source", source: "something_else" },
  });
  assert.equal(bogusSource.status, 201);
  assert.equal(bogusSource.body.source, "manual", "an unrecognized source value should fall back to manual, not be trusted verbatim");
});
