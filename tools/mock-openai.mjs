/**
 * Minimal OpenAI-compatible server for testing the translation client.
 *
 * Speaks just enough of `/chat/completions` to exercise the plugin end to end:
 * JSON request parsing, the `{segments:[{i,t}]}` reply contract, token usage
 * reporting, and per-index failure injection so retry and fallback paths can be
 * observed without spending API credits.
 *
 * Usage: node tools/mock-openai.mjs [port]
 */

import http from "node:http";

const PORT = Number(process.argv[2] ?? 8765);
/** Number of segments to drop on the first request, to exercise retries. */
let dropNext = Number(process.env.MOCK_DROP ?? 0);
const seen = [];

const server = http.createServer((req, res) => {
  if (!req.url?.startsWith("/v1/chat/completions")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no route for ${req.url}` } }));
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `bad JSON: ${error.message}` } }));
      return;
    }

    const user = payload.messages?.find((m) => m.role === "user")?.content ?? "{}";
    let segments = [];
    try {
      segments = JSON.parse(user).segments ?? [];
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "user message was not JSON" } }));
      return;
    }

    seen.push({ model: payload.model, count: segments.length, temperature: payload.temperature });
    console.log(
      `request #${seen.length}: model=${payload.model} segments=${segments.length} ` +
        `temperature=${payload.temperature}`,
    );

    const replies = [];
    let dropped = 0;
    for (const segment of segments) {
      if (dropNext > 0) {
        dropNext--;
        dropped++;
        continue;
      }
      // Mark the reply so the test can tell it apart from the source, and prove
      // placeholders survive the round trip.
      replies.push({ i: segment.i, t: `【译】${segment.t}` });
    }
    if (dropped) {
      console.log(`  dropped ${dropped} segment(s) to exercise the retry path`);
    }

    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "mock-1",
        object: "chat.completion",
        model: payload.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: JSON.stringify({ segments: replies }) },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 120,
          total_tokens: 220,
        },
      }),
    );
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`mock OpenAI server listening on http://127.0.0.1:${PORT}/v1`);
});
