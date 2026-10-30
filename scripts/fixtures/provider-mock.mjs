import { createServer } from "node:http";

// Only used on the private network created by compose-smoke.mjs.
const origin = "http://provider-mock:8080";
const repository = "acme/smoke";
const base = "a".repeat(40), head = "b".repeat(40);
const files = [{ filename: "src/value.ts", status: "modified", additions: 1, deletions: 0,
  changes: 1, patch: "@@ -0,0 +1 @@\n+export const value = 1;" }];
const notes = { github: [], gitlab: [] };
const calls = [];
let modelCalls = 0;
const pull = { id: 42, number: 42, title: "Compose smoke", body: "Isolated fixture",
  user: { login: "alice" }, base: { ref: "main", sha: base }, head: { ref: "feature", sha: head },
  additions: 1, deletions: 0, changed_files: 1, draft: false, html_url: `${origin}/${repository}/pull/42` };
const merge = { id: 42, iid: 42, title: "Compose smoke", description: "Isolated fixture",
  author: { username: "alice" }, source_branch: "feature", target_branch: "main", draft: false,
  web_url: `${origin}/${repository}/-/merge_requests/42`, diff_refs: { base_sha: base, head_sha: head, start_sha: base } };

createServer(async (request, response) => {
  const url = new URL(request.url, origin), path = url.pathname, method = request.method;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* malformed request is rejected below */ }
  const json = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  if (path === "/stats") return json(200, { modelCalls, githubComments: notes.github.length,
    gitlabComments: notes.gitlab.length, calls });
  calls.push(`${method} ${path}`);
  if (method === "POST" && path === "/v1/chat/completions") {
    modelCalls++;
    return json(200, { id: `fixture-${modelCalls}`, object: "chat.completion", created: 1, model: "fixture-model",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({
        summary: "Isolated Compose review completed", riskLevel: "low", reviews: [], positives: [], actionItems: [],
      }) } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
  }
  if (method === "GET" && ["/user", "/api/v4/user"].includes(path)) return json(200, { id: 4343, login: "pr-agent", username: "pr-agent", type: "Bot" });
  if (method === "GET" && path === `/repos/${repository}`) return json(200, { id: 4242, full_name: repository });
  if (method === "GET" && path === "/api/v4/projects/4242") return json(200, { id: 4242, path_with_namespace: repository, web_url: `${origin}/${repository}` });
  if (method === "GET" && path === `/repos/${repository}/pulls/42`) return json(200, pull);
  if (method === "GET" && path === `/repos/${repository}/pulls/42/files`) return json(200, files);
  if (method === "GET" && path === `/repos/${repository}/compare/${base}...${head}`) return json(200, { files });
  if (method === "GET" && path === `/repos/${repository}/pulls/42/comments`) return json(200, []);
  if (method === "GET" && path === `/repos/${repository}/issues/42`) return json(200, { labels: [] });
  if (method === "GET" && path === "/api/v4/projects/4242/merge_requests/42") return json(200, merge);
  if (method === "GET" && path === "/api/v4/projects/4242/merge_requests/42/changes") return json(200, {
    ...merge, changes: files.map((file) => ({ old_path: file.filename, new_path: file.filename, diff: file.patch })) });
  for (const [platform, endpoint] of Object.entries({ github: `/repos/${repository}/issues/42/comments`,
    gitlab: "/api/v4/projects/4242/merge_requests/42/notes" })) {
    if (path !== endpoint) continue;
    if (method === "GET") return json(200, notes[platform]);
    if (method === "POST") {
      const note = { id: 9000 + notes[platform].length, body: body.body, user: { id: 4343 }, author: { id: 4343 } };
      notes[platform].push(note); return json(201, note);
    }
  }
  return json(404, { message: "fixture route not found" });
}).listen(8080, "0.0.0.0");
