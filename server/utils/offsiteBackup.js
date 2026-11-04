// Off-site copy of the nightly backup -- server/utils/backup.js's own
// snapshot lives in a folder on the *same disk* as the live app, so a
// droplet-level disk loss (or the droplet itself being destroyed) takes
// out the live database and every backup of it at once. This pushes the
// already-encrypted database backup to an S3-compatible bucket (AWS S3,
// DigitalOcean Spaces, MinIO, etc. -- any provider that speaks the S3 REST
// API) so a copy exists somewhere physically separate.
//
// No-op until every BACKUP_S3_* env var below is set -- same
// inactive-until-configured convention SendGrid/Anthropic keys already
// follow elsewhere in this app. backup.js's own local backup (and its
// encryption) runs and succeeds either way; this is additive, never a
// precondition for the local backup.
//
// Hand-rolled AWS Signature V4 PUT via Node's built-in fetch/crypto rather
// than pulling in the AWS SDK -- a single PUT a night doesn't need a
// multi-megabyte client library, and this project already avoids
// dependencies it can reasonably do without (see fileEncryption.js,
// password.js for the same call).
const crypto = require("crypto");

const ENDPOINT = process.env.BACKUP_S3_ENDPOINT || "";
const BUCKET = process.env.BACKUP_S3_BUCKET || "";
const REGION = process.env.BACKUP_S3_REGION || "us-east-1";
const ACCESS_KEY = process.env.BACKUP_S3_ACCESS_KEY || "";
const SECRET_KEY = process.env.BACKUP_S3_SECRET_KEY || "";
// Lets one bucket be shared with other data if that's ever useful --
// defaults to nothing, i.e. objects land at the bucket root.
const PREFIX = process.env.BACKUP_S3_PREFIX || "";

function isConfigured() {
  return Boolean(ENDPOINT && BUCKET && ACCESS_KEY && SECRET_KEY);
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function deriveSigningKey(secretKey, dateStamp, region) {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

// Uploads `buffer` to `${PREFIX}${key}` in the configured bucket, signed
// with SigV4. Path-style addressing (`endpoint/bucket/key`) rather than
// virtual-hosted-style -- works the same across every S3-compatible
// provider this might point at, not just AWS.
async function uploadObject(key, buffer, contentType = "application/octet-stream") {
  if (!isConfigured()) {
    throw new Error("Off-site backup storage is not configured (BACKUP_S3_* env vars missing)");
  }

  const objectKey = `${PREFIX}${key}`;
  const host = new URL(ENDPOINT).host;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(buffer);

  const canonicalUri = `/${BUCKET}/${objectKey}`;
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const credentialScope = `${dateStamp}/${REGION}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`;
  const signature = hmac(deriveSigningKey(SECRET_KEY, dateStamp, REGION), stringToSign).toString("hex");

  const authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const url = `${ENDPOINT.replace(/\/$/, "")}${canonicalUri}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "X-Amz-Date": amzDate,
      "X-Amz-Content-Sha256": payloadHash,
      Authorization: authorization,
      "Content-Type": contentType,
    },
    body: buffer,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Off-site backup upload failed: ${res.status} ${res.statusText} ${body}`.trim());
  }
}

module.exports = { isConfigured, uploadObject };
