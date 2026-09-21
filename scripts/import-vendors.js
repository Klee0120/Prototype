#!/usr/bin/env node
// One-time bulk import of vendor records into the live database.
//
// Usage:
//   node scripts/import-vendors.js path/to/vendors.json
//
// The JSON file is an array of objects shaped like the vendor fields the
// app itself uses (name, jdeVendorNumber, cwStatus, toyotaStatus,
// formsStatus, rawStatusText, poEmail, invoicedPreviously,
// successfulInvoiceRecords, successfulSinceDate, midwestSitesSeen,
// services, trackerWorkExamples, coverageOutsideMidwest, phone, email,
// onlineSourceUrl, notes) -- only "name" is required, everything else is
// optional. cwStatus/toyotaStatus/formsStatus default to "unknown" if
// omitted or not one of the app's recognized values.
//
// Safe to re-run: a vendor already on file (matched by name, or by JDE
// vendor # when both have one) is updated in place instead of duplicated.

const fs = require("fs");
const path = require("path");
const db = require("../server/data/db");

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/import-vendors.js path/to/vendors.json");
  process.exit(1);
}

const raw = fs.readFileSync(path.resolve(inputPath), "utf8");
const records = JSON.parse(raw);
if (!Array.isArray(records)) {
  console.error("Expected the JSON file to contain an array of vendor records.");
  process.exit(1);
}

const existing = db.listVendors();
const byJde = new Map(existing.filter((v) => v.jdeVendorNumber).map((v) => [v.jdeVendorNumber, v]));
const byName = new Map(existing.map((v) => [v.name.toLowerCase(), v]));

let created = 0;
let updated = 0;
let skipped = 0;

for (const record of records) {
  if (!record.name || !String(record.name).trim()) {
    skipped++;
    continue;
  }
  const fields = {
    ...record,
    cwStatus: db.CW_STATUSES.includes(record.cwStatus) ? record.cwStatus : "unknown",
    toyotaStatus: db.TOYOTA_STATUSES.includes(record.toyotaStatus) ? record.toyotaStatus : "unknown",
    formsStatus: db.FORMS_STATUSES.includes(record.formsStatus) ? record.formsStatus : "unknown",
  };

  const match = (fields.jdeVendorNumber && byJde.get(fields.jdeVendorNumber)) || byName.get(fields.name.toLowerCase());
  if (match) {
    db.updateVendor(match.id, fields);
    updated++;
  } else {
    db.createVendor(fields);
    created++;
  }
}

console.log(`Vendor import complete: ${created} created, ${updated} updated, ${skipped} skipped (missing name).`);
