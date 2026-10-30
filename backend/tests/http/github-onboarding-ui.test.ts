import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const assetRoot = new URL("../../src/http/admin/github/assets/", import.meta.url);

class FakeClassList {
  constructor(private readonly owner: FakeElement) {}
  toggle(name: string, force: boolean): void {
    const values = new Set(this.owner.className.split(/\s+/u).filter(Boolean));
    if (force) values.add(name); else values.delete(name);
    this.owner.className = [...values].join(" ");
  }
}

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Array<(event: FakeEvent) => unknown>>();
  readonly classList = new FakeClassList(this);
  className = "";
  textContent = "";
  value = "";
  returnValue = "";
  hidden = false;
  disabled = false;
  checked = false;
  type = "";
  open = false;

  get firstChild(): FakeElement | undefined { return this.children[0]; }
  appendChild(child: FakeElement): FakeElement { this.children.push(child); return child; }
  removeChild(child: FakeElement): void { this.children.splice(this.children.indexOf(child), 1); }
  addEventListener(name: string, listener: (event: FakeEvent) => unknown): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  dispatch(name: string, event: FakeEvent = new FakeEvent(this)): void {
    for (const listener of this.listeners.get(name) ?? []) listener(event);
  }
  closest(selector: string): FakeElement | undefined {
    return selector === "button[data-action]" && this.dataset.action ? this : undefined;
  }
  showModal(): void { this.open = true; }
  close(): void { this.open = false; this.dispatch("close"); }
  focus(): void {}
}

class FakeEvent {
  constructor(readonly target: FakeElement) {}
  preventDefault(): void {}
}

function createHarness(responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  const selectors = ["#login-panel", "#login-form", "#token", "#workspace", "#connection-dot",
    "#connection-label", "#app-summary", "#refresh-button", "#disconnect-button", "#notice",
    "#loading", "#empty-state", "#repository-list", "#confirm-dialog", "#confirm-repository",
    "#publisher-confirmation", "#confirm-action"];
  const nodes = new Map(selectors.map((selector) => [selector, new FakeElement()]));
  const requests: Array<{ path: string; options: Record<string, unknown> }> = [];
  const document = {
    querySelector(selector: string) { return nodes.get(selector); },
    createElement() { return new FakeElement(); },
  };
  const context = vm.createContext({
    document,
    Object,
    Number,
    JSON,
    Error,
    fetch: async (path: string, options: Record<string, unknown>) => {
      requests.push({ path, options });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return { ok: response.ok, status: response.status, json: async () => response.body };
    },
    localStorage: new Proxy({}, { get() { throw new Error("localStorage must not be used"); } }),
    sessionStorage: new Proxy({}, { get() { throw new Error("sessionStorage must not be used"); } }),
  });
  return { context, nodes, requests };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("admin UI keeps credentials in memory and disconnects without browser persistence", async () => {
  const source = await readFile(new URL("app.js", assetRoot), "utf8");
  const harness = createHarness([{ ok: true, status: 200, body: {
    app: { id: 1, slug: "review-app", name: "Review App" },
    repositories: [{ repository: "example/project", repositoryId: 2, installationId: 3,
      accountId: 4, account: "example", status: "active", binding: {
        id: "binding", state: "active", version: 2, generation: 1,
        providerAccessState: "verified", providerAccessVersion: 0,
      } }],
  } }]);
  vm.runInContext(source, harness.context);

  const token = harness.nodes.get("#token")!;
  token.value = "secret-admin-token";
  harness.nodes.get("#login-form")!.dispatch("submit");
  await flush();

  assert.equal(token.value, "");
  assert.equal(harness.nodes.get("#workspace")!.hidden, false);
  assert.equal(harness.requests.length, 1);
  assert.equal((harness.requests[0]!.options.headers as Record<string, string>).Authorization,
    "Bearer secret-admin-token");
  assert.doesNotMatch(visibleText(harness.nodes), /secret-admin-token/u);

  harness.nodes.get("#disconnect-button")!.dispatch("click");
  assert.equal(harness.nodes.get("#workspace")!.hidden, true);
  assert.equal(harness.nodes.get("#login-panel")!.hidden, false);
});

test("repository enrollment requires publisher confirmation and sends no provider identity fields", async () => {
  const source = await readFile(new URL("app.js", assetRoot), "utf8");
  const repository = { repository: "example/new-repo", repositoryId: 22, installationId: 33,
    accountId: 44, account: "example", status: "not_connected", binding: null };
  const harness = createHarness([
    { ok: true, status: 200, body: { app: { id: 1, slug: "review-app", name: "Review App" }, repositories: [repository] } },
    { ok: true, status: 200, body: { binding: { id: "new-binding", state: "active" } } },
    { ok: true, status: 200, body: { app: { id: 1, slug: "review-app", name: "Review App" },
      repositories: [{ ...repository, status: "active", binding: { id: "new-binding", state: "active" } }] } },
  ]);
  vm.runInContext(source, harness.context);
  harness.nodes.get("#token")!.value = "admin-token";
  harness.nodes.get("#login-form")!.dispatch("submit");
  await flush();

  const list = harness.nodes.get("#repository-list")!;
  const action = findByDataset(list, "action", "enroll");
  assert.ok(action);
  list.dispatch("click", new FakeEvent(action));
  assert.equal(harness.nodes.get("#confirm-dialog")!.open, true);
  assert.equal(harness.nodes.get("#confirm-action")!.disabled, true);

  const confirmation = harness.nodes.get("#publisher-confirmation")!;
  confirmation.checked = true;
  confirmation.dispatch("change");
  assert.equal(harness.nodes.get("#confirm-action")!.disabled, false);
  const dialog = harness.nodes.get("#confirm-dialog")!;
  dialog.returnValue = "default";
  dialog.close();
  await flush();

  assert.equal(harness.requests.length, 3);
  const enrollment = harness.requests[1]!;
  assert.equal(enrollment.path, "/api/admin/github/repositories");
  const body = JSON.parse(enrollment.options.body as string) as Record<string, unknown>;
  assert.deepEqual(body, { repository: "example/new-repo", confirmPublisherStopped: true });
  assert.equal("installationId" in body, false);
  assert.equal("repositoryId" in body, false);
  assert.equal("tenantId" in body, false);
});

test("revoked repository revalidation sends the optimistic access version", async () => {
  const source = await readFile(new URL("app.js", assetRoot), "utf8");
  const repository = { repository: "example/revoked", repositoryId: 22, installationId: 33,
    accountId: 44, account: "example", status: "revoked", binding: {
      id: "existing", state: "active", version: 4, generation: 2,
      providerAccessState: "revoked", providerAccessVersion: 7,
    } };
  const harness = createHarness([
    { ok: true, status: 200, body: { app: { id: 1, slug: "review-app", name: "Review App" }, repositories: [repository] } },
    { ok: true, status: 200, body: { binding: { ...repository.binding, providerAccessState: "verified" } } },
    { ok: true, status: 200, body: { app: { id: 1, slug: "review-app", name: "Review App" },
      repositories: [{ ...repository, status: "active" }] } },
  ]);
  vm.runInContext(source, harness.context);
  harness.nodes.get("#token")!.value = "admin-token";
  harness.nodes.get("#login-form")!.dispatch("submit");
  await flush();

  const list = harness.nodes.get("#repository-list")!;
  const action = findByDataset(list, "action", "revalidate");
  assert.ok(action);
  list.dispatch("click", new FakeEvent(action));
  harness.nodes.get("#publisher-confirmation")!.checked = true;
  harness.nodes.get("#publisher-confirmation")!.dispatch("change");
  harness.nodes.get("#confirm-dialog")!.returnValue = "default";
  harness.nodes.get("#confirm-dialog")!.close();
  await flush();

  assert.equal(harness.requests[1]!.path, "/api/admin/github/repositories/revalidate");
  assert.deepEqual(JSON.parse(harness.requests[1]!.options.body as string), {
    repository: "example/revoked",
    confirmPublisherStopped: true,
    expectedAccessVersion: 7,
  });
});

test("admin shell has no inline executable content or external resources", async () => {
  const html = await readFile(new URL("index.html", assetRoot), "utf8");
  const script = await readFile(new URL("app.js", assetRoot), "utf8");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/iu);
  assert.doesNotMatch(html, /<style\b/iu);
  assert.doesNotMatch(html, /https?:\/\//iu);
  assert.doesNotMatch(script, /localStorage|sessionStorage|innerHTML|document\.cookie/gu);
  assert.match(html, /确认当前仓库没有其他正在发布评审的旧实例/u);
});

function findByDataset(root: FakeElement, key: string, value: string): FakeElement | undefined {
  if (root.dataset[key] === value) return root;
  for (const child of root.children) {
    const found = findByDataset(child, key, value);
    if (found) return found;
  }
  return undefined;
}

function visibleText(nodes: Map<string, FakeElement>): string {
  const collect = (node: FakeElement): string => [node.textContent, ...node.children.map(collect)].join(" ");
  return [...nodes.values()].map(collect).join(" ");
}
