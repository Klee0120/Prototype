// Real AI summarization is opt-in via an environment variable -- if it
// isn't set, summarizeCorrespondence just returns null rather than
// pretending to produce something it can't. A correspondence entry always
// saves successfully whether or not this succeeds, same "never block the
// real action on this" rule server/utils/mailer.js already follows for
// email delivery.
//
// Calls Anthropic's Messages API directly over plain `fetch` (no SDK
// dependency, same pattern mailer.js uses for SendGrid's HTTP API) --
// this is the one place in the app that calls out to an LLM; every other
// "smart" document-handling feature (COI review, email parsing) is plain
// text extraction/regex, never a model call.
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// A fast/cheap model is the right fit here -- the output is one sentence,
// not a task that needs deep reasoning.
const MODEL = "claude-haiku-5-5";

function isConfigured() {
  return Boolean(ANTHROPIC_API_KEY);
}

// One plain-English sentence for a compliance admin's quick reference --
// what the vendor provided or asked for, and what (if anything) still
// needs to happen. Returns null (never throws) on any failure -- an admin
// filing real correspondence should never be blocked by this.
async function summarizeCorrespondence({ subject, correspondent, bodyText }) {
  if (!isConfigured()) return null;
  if (!bodyText || !bodyText.trim()) return null;

  const prompt = `Summarize this vendor correspondence email in one plain sentence for a compliance admin's quick reference -- what the vendor provided or asked for, and what (if anything) still needs to happen next. No preamble, no quotation marks, just the sentence.

Subject: ${subject || "(no subject)"}
From: ${correspondent || "(unknown sender)"}
Body:
${bodyText}`;

  try {
    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[aiSummarizer] Anthropic responded ${res.status}: ${errText}`);
      return null;
    }
    const data = await res.json();
    const text = (data.content || [])
      .map((block) => block.text || "")
      .join("")
      .trim();
    return text || null;
  } catch (err) {
    console.error(`[aiSummarizer] request failed: ${err.message}`);
    return null;
  }
}

module.exports = { isConfigured, summarizeCorrespondence };
