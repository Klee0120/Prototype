const test = require("node:test");
const assert = require("node:assert/strict");

const summarizerPath = require.resolve("../server/utils/aiSummarizer");

// aiSummarizer.js reads ANTHROPIC_API_KEY into a module-level const once,
// at require time -- same reasoning as mailer.test.js's freshMailer(): these
// tests toggle that env between cases, so each one clears the require
// cache and re-requires fresh.
function freshSummarizer() {
  delete require.cache[summarizerPath];
  return require(summarizerPath);
}

test("aiSummarizer: no-op (returns null, never throws) when not configured", async (t) => {
  delete process.env.ANTHROPIC_API_KEY;
  const summarizer = freshSummarizer();
  t.after(() => delete require.cache[summarizerPath]);

  assert.equal(summarizer.isConfigured(), false);
  const result = await summarizer.summarizeCorrespondence({ subject: "x", correspondent: "y", bodyText: "some real body text" });
  assert.equal(result, null);
});

test("aiSummarizer: returns null without calling out when there's no body text to summarize", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const summarizer = freshSummarizer();
  t.after(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete require.cache[summarizerPath];
  });

  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error("should never be called");
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await summarizer.summarizeCorrespondence({ subject: "x", correspondent: "y", bodyText: "" });
  assert.equal(result, null);
  assert.equal(called, false);
});

test("aiSummarizer: calls Anthropic's Messages API and returns the summary text when configured", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const summarizer = freshSummarizer();
  t.after(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete require.cache[summarizerPath];
  });

  const originalFetch = global.fetch;
  let capturedUrl = null;
  let capturedOptions = null;
  global.fetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return {
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "Vendor provided an updated COI." }] }),
    };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await summarizer.summarizeCorrespondence({
    subject: "COI renewal",
    correspondent: "Jane Vendor <jane@acmeplumbing.com>",
    bodyText: "Attached is our updated certificate of insurance.",
  });

  assert.equal(result, "Vendor provided an updated COI.");
  assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");
  assert.equal(capturedOptions.method, "POST");
  assert.equal(capturedOptions.headers["x-api-key"], "test-key");
  const body = JSON.parse(capturedOptions.body);
  assert.match(body.messages[0].content, /COI renewal/);
  assert.match(body.messages[0].content, /Attached is our updated certificate/);
});

test("aiSummarizer: returns null (never throws) when Anthropic responds with an error status", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const summarizer = freshSummarizer();
  t.after(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete require.cache[summarizerPath];
  });

  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => '{"error":"bad key"}' });
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await summarizer.summarizeCorrespondence({ subject: "x", correspondent: "y", bodyText: "real body text" });
  assert.equal(result, null);
});

test("aiSummarizer: returns null (never throws) when the request itself fails", async (t) => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const summarizer = freshSummarizer();
  t.after(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete require.cache[summarizerPath];
  });

  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("network down");
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  const result = await summarizer.summarizeCorrespondence({ subject: "x", correspondent: "y", bodyText: "real body text" });
  assert.equal(result, null);
});
