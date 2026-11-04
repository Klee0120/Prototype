// Its own file, deliberately: offsiteBackup.js reads BACKUP_S3_* into
// module-level consts once, at require time -- same convention
// vendorPortalInvoiceDelivery.test.js already follows for mailer.js's
// SENDGRID_* vars. No server needed here; uploadObject is a pure
// function of its inputs plus a mocked global.fetch.
process.env.BACKUP_S3_ENDPOINT = "https://nyc3.digitaloceanspaces.com";
process.env.BACKUP_S3_BUCKET = "serviceworks-backups";
process.env.BACKUP_S3_REGION = "nyc3";
process.env.BACKUP_S3_ACCESS_KEY = "test-access-key";
process.env.BACKUP_S3_SECRET_KEY = "test-secret-key";

const test = require("node:test");
const assert = require("node:assert/strict");
const offsiteBackup = require("../server/utils/offsiteBackup");

test("offsiteBackup: isConfigured is true once every BACKUP_S3_* var is set", () => {
  assert.equal(offsiteBackup.isConfigured(), true);
});

test("offsiteBackup: uploadObject signs a correctly-shaped SigV4 PUT request", async (t) => {
  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const buffer = Buffer.from("pretend encrypted sqlite bytes");
  await offsiteBackup.uploadObject("store-2026-01-01.sqlite.enc", buffer);

  assert.equal(captured.url, "https://nyc3.digitaloceanspaces.com/serviceworks-backups/store-2026-01-01.sqlite.enc");
  assert.equal(captured.options.method, "PUT");
  assert.equal(captured.options.body, buffer);
  assert.match(captured.options.headers.Authorization, /^AWS4-HMAC-SHA256 Credential=test-access-key\/\d{8}\/nyc3\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.match(captured.options.headers["X-Amz-Date"], /^\d{8}T\d{6}Z$/);
  const crypto = require("crypto");
  assert.equal(captured.options.headers["X-Amz-Content-Sha256"], crypto.createHash("sha256").update(buffer).digest("hex"));
});

test("offsiteBackup: uploadObject honors BACKUP_S3_PREFIX when set", async (t) => {
  process.env.BACKUP_S3_PREFIX = "labor-allocation/";
  // offsiteBackup.js already read the un-prefixed env at require time in
  // this process, so re-require with the cache cleared to pick it up --
  // the simplest way to exercise the prefix branch without a 4th file.
  delete require.cache[require.resolve("../server/utils/offsiteBackup")];
  const prefixed = require("../server/utils/offsiteBackup");

  const originalFetch = global.fetch;
  let captured = null;
  global.fetch = async (url, options) => {
    captured = { url, options };
    return { ok: true, status: 200, statusText: "OK" };
  };
  t.after(() => {
    global.fetch = originalFetch;
    delete process.env.BACKUP_S3_PREFIX;
    delete require.cache[require.resolve("../server/utils/offsiteBackup")];
  });

  await prefixed.uploadObject("store-2026-01-01.sqlite.enc", Buffer.from("x"));
  assert.equal(captured.url, "https://nyc3.digitaloceanspaces.com/serviceworks-backups/labor-allocation/store-2026-01-01.sqlite.enc");
});

test("offsiteBackup: with a var missing, isConfigured is false and uploadObject refuses rather than silently no-op-ing", async (t) => {
  const savedKey = process.env.BACKUP_S3_ACCESS_KEY;
  delete process.env.BACKUP_S3_ACCESS_KEY;
  delete require.cache[require.resolve("../server/utils/offsiteBackup")];
  const unconfigured = require("../server/utils/offsiteBackup");
  t.after(() => {
    process.env.BACKUP_S3_ACCESS_KEY = savedKey;
    delete require.cache[require.resolve("../server/utils/offsiteBackup")];
  });

  assert.equal(unconfigured.isConfigured(), false);
  await assert.rejects(() => unconfigured.uploadObject("x.enc", Buffer.from("x")), /not configured/);
});

test("offsiteBackup: uploadObject throws (not just a rejected fetch) on a non-2xx response", async (t) => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403, statusText: "Forbidden", text: async () => "AccessDenied" });
  t.after(() => {
    global.fetch = originalFetch;
  });

  await assert.rejects(() => offsiteBackup.uploadObject("x.enc", Buffer.from("x")), /403/);
});
