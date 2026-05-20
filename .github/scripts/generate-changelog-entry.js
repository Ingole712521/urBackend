const https = require("https");

const prSummary = process.argv[2] || "No PRs merged this week.";
const prCount = process.argv[3] || "0";

const prompt = `You are a technical writer for urBackend, an open-source Backend-as-a-Service platform.

Based on the following merged pull requests from the last 7 days, write a concise weekly changelog entry.

Merged PRs (${prCount} total):
${prSummary}

Instructions:
- Group changes under "Added", "Fixed", "Changed", or "Security" headings as appropriate
- Use bullet points for each change
- Keep each bullet point concise and developer-friendly
- If no PRs were merged, write "No changes this week."
- Do NOT include version numbers or dates (those are added separately)
- Do NOT add any preamble or explanation, just the changelog content

Example format:
### Added
- New feature description (#PR_NUMBER)

### Fixed
- Bug fix description (#PR_NUMBER)
`;

const payload = JSON.stringify({
  model: "openai/gpt-oss-120b",
  messages: [{ role: "user", content: prompt }],
  max_tokens: 1000,
  temperature: 0.3,
});

const options = {
  hostname: "api.groq.com",
  path: "/openai/v1/chat/completions",
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    "Content-Length": Buffer.byteLength(payload),
  },
};

const req = https.request(options, (res) => {
  let data = "";

  res.on("data", (chunk) => {
    data += chunk;
  });

  res.on("end", () => {
    try {
      const response = JSON.parse(data);

      if (response.error) {
        console.error("Groq API error:", response.error.message);
        process.exit(1);
      }

      const content = response.choices?.[0]?.message?.content;

      if (!content) {
        console.error("No content in response:", JSON.stringify(response));
        process.exit(1);
      }

      process.stdout.write(content.trim());
    } catch (err) {
      console.error("Failed to parse response:", err.message);
      console.error("Raw response:", data);
      process.exit(1);
    }
  });
});

req.on("error", (err) => {
  console.error("Request failed:", err.message);
  process.exit(1);
});

req.write(payload);
req.end();
