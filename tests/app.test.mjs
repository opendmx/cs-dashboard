import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import http from "node:http";
import { once } from "node:events";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);

function createApp(respond = () => ({ codespaces: [], total_count: 0 })) {
  const elements = new Map();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) {
    elements.set(match[1], {
      value: "", innerHTML: "", textContent: "", disabled: false, hidden: false,
      style: {}, handlers: {},
      addEventListener(event, handler) { this.handlers[event] = handler; }
    });
  }
  const requests = [];
  const confirmations = [];
  const resizeObservers = [];
  const context = vm.createContext({
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; resizeObservers.push(this); }
      observe() {}
    },
    document: {
      getElementById: (id) => {
        assert.ok(elements.has(id), `Missing HTML element ${id}`);
        return elements.get(id);
      },
      querySelectorAll: (selector) => selector === "button" ? [...elements.values()] : []
    },
    window: { confirm: (message) => { confirmations.push(message); return true; } },
    URL, Intl, Date,
    fetch: async (url, options) => {
      requests.push({ url, options });
      const data = await respond(url, options);
      return data instanceof Response ? data : Response.json(data);
    }
  });
  vm.runInContext(scripts[1], context);
  return {
    context, elements, requests, confirmations, resizeObservers,
    run: (code) => vm.runInContext(code, context),
    element: (id) => elements.get(id),
    async trigger(id, event = "click") {
      await elements.get(id).handlers[event]({ preventDefault() {} });
    },
    async connect(org = "octodemo") {
      elements.get("orgInput").value = org;
      elements.get("tokenInput").value = "test-only-placeholder";
      await this.trigger("connectForm", "submit");
    }
  };
}

test("static site has no runtime dependencies and works at a Pages subpath", async () => {
  assert.equal(scripts.length, 2);
  for (const script of scripts) new vm.Script(script);
  assert.doesNotMatch(html, /<(?:script|link)[^>]+(?:src|href)=/);
  assert.doesNotMatch(html, /localStorage|sessionStorage|document\.cookie/);
  assert.match(html, /connect-src https:\/\/api\.github\.com/);
  assert.match(html, /\[hidden\]\s*\{\s*display:\s*none !important/);
  const server = http.createServer((request, response) => {
    if (request.url === "/codespaces-admin/") {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end(html);
    } else {
      response.writeHead(404);
      response.end();
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/codespaces-admin/`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), html);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("top and bottom scrollbars synchronize and resize for both tables", () => {
  const app = createApp();
  for (const [index, topId, wrapId, spacerId] of [
    [0, "spaceScrollTop", "tableWrap", "spaceScrollSpacer"],
    [1, "memberScrollTop", "memberTableWrap", "memberScrollSpacer"]
  ]) {
    const top = app.element(topId), wrap = app.element(wrapId);
    wrap.scrollWidth = 6400;
    wrap.scrollLeft = 0;
    app.resizeObservers[index].callback();
    assert.equal(app.element(spacerId).style.width, "6400px");
    assert.equal(top.scrollLeft, 0);
    top.scrollLeft = 1000;
    top.handlers.scroll();
    assert.equal(wrap.scrollLeft, 1000);
    wrap.scrollLeft = 2400;
    wrap.handlers.scroll();
    assert.equal(top.scrollLeft, 2400);
    wrap.scrollWidth = 7200;
    app.resizeObservers[index].callback();
    assert.equal(app.element(spacerId).style.width, "7200px");
    assert.equal(top.scrollLeft, 2400);
  }
});

test("connect uses direct versioned GitHub requests without cookies or redirects", async () => {
  const app = createApp();
  await app.connect();
  assert.equal(app.requests[0].url, "https://api.github.com/orgs/octodemo/codespaces?per_page=100&page=1");
  const { options } = app.requests[0];
  assert.equal(options.headers["X-GitHub-Api-Version"], "2026-03-10");
  assert.equal(options.headers.Accept, "application/vnd.github+json");
  assert.equal(options.headers.Authorization, "Bearer test-only-placeholder");
  assert.equal(options.credentials, "omit");
  assert.equal(options.cache, "no-store");
  assert.equal(options.redirect, "error");
  assert.equal(app.element("tokenInput").value, "");
  assert.equal(app.element("orgInput").disabled, true);
  assert.equal(app.element("connectBtn").disabled, true);
  assert.equal(app.run("state.connected"), true);
});

test("all inventory pages are loaded before rendering", async () => {
  const app = createApp((url) => ({
    codespaces: Array.from({ length: url.endsWith("page=1") ? 100 : 2 }, (_, id) => ({
      name: `space-${id}`, owner: { login: "octocat" }, state: "Shutdown"
    })),
    total_count: 102
  }));
  await app.connect();
  assert.equal(app.requests.length, 2);
  assert.match(app.requests[1].url, /page=2$/);
  assert.equal(app.run("state.codespaces.length"), 102);
  assert.equal(app.element("totalStat").textContent, 102);
});

test("partial and malformed inventories are not passed off as complete success", async () => {
  const partial = createApp(() => ({ codespaces: [], total_count: 66 }));
  await partial.connect();
  assert.match(partial.element("notice").textContent, /66 total.*0 were loaded/);
  const malformed = createApp(() => ({ message: "unexpected" }));
  await malformed.connect();
  assert.match(malformed.element("notice").textContent, /unexpected Codespaces response/);
  assert.equal(malformed.run("state.token"), "");
  assert.equal(malformed.run("state.connected"), false);
});

test("50-result API pages do not truncate a 100-Codespace organization or member list", async () => {
  const app = createApp((url) => {
    const page = Number(new URL(url).searchParams.get("page"));
    return {
      total_count: 100,
      codespaces: Array.from({ length: 50 }, (_, index) => ({
        name: `space-${(page - 1) * 50 + index + 1}`,
        owner: { login: "octocat" }, state: "Available"
      }))
    };
  });
  await app.connect();
  assert.equal(app.requests.length, 2);
  assert.equal(app.run("state.codespaces.length"), 100);
  assert.equal((app.element("spaceRows").innerHTML.match(/<tr>/g) || []).length, 100);
  assert.match(app.element("spaceRows").innerHTML, /space-100/);
  app.element("memberInput").value = "octocat";
  await app.trigger("memberLookupBtn");
  assert.equal(app.requests.length, 4);
  assert.equal((app.element("memberRows").innerHTML.match(/<tr>/g) || []).length, 100);
  assert.match(app.element("memberRows").innerHTML, /space-100/);
  for (const request of app.requests) assert.equal(new URL(request.url).searchParams.get("per_page"), "100");
});

test("pagination ends on an empty page and reports an incomplete inventory", async () => {
  const app = createApp((url) => ({
    total_count: 100,
    codespaces: url.endsWith("page=1") ? Array.from({ length: 50 }, (_, index) => ({
      name: `space-${index}`, owner: { login: "octocat" }, state: "Shutdown"
    })) : []
  }));
  await app.connect();
  assert.equal(app.requests.length, 2);
  assert.equal(app.run("state.codespaces.length"), 50);
  assert.match(app.element("notice").textContent, /100 total.*50 were loaded/);
});

test("disconnect clears every organization view and allows a clean switch", async () => {
  const app = createApp();
  await app.connect();
  app.element("memberRows").innerHTML = "old-organization-space";
  app.element("memberResultWrap").hidden = false;
  await app.trigger("disconnectBtn");
  assert.equal(app.run("state.token"), "");
  assert.equal(app.run("state.org"), "");
  assert.equal(app.element("memberRows").innerHTML, "");
  assert.equal(app.element("memberResultWrap").hidden, true);
  assert.equal(app.element("orgInput").disabled, false);
  await app.connect("another-org");
  assert.match(app.requests.at(-1).url, /\/orgs\/another-org\//);
});

test("failed connection discards credentials and reports API permission guidance", async () => {
  const app = createApp(() => Response.json({ message: "Not Found" }, { status: 404 }));
  await app.connect("unavailable-org");
  assert.equal(app.run("state.token"), "");
  assert.equal(app.run("state.connected"), false);
  assert.equal(app.element("dashboard").style.display, "none");
  assert.match(app.element("notice").textContent, /unavailable-org.*404.*admin:org/);
  assert.equal(app.element("connectBtn").disabled, false);
});

test("network errors are visible and do not leave a connected dashboard", async () => {
  const app = createApp(() => { throw new TypeError("Failed to fetch"); });
  await app.connect();
  assert.match(app.element("notice").textContent, /network\/CORS restrictions/);
  assert.equal(app.run("state.connected"), false);
});

test("all API paths are constrained to the active organization", async () => {
  const app = createApp();
  await app.connect();
  await assert.rejects(app.run('api("/orgs/another-org/codespaces")'), /Connect to an organization/);
  assert.equal(app.requests.length, 1);
});

test("member lookup is organization-scoped and stale member data is cleared on failure", async () => {
  let fail = false;
  const app = createApp((url) => {
    if (url.includes("/members/") && fail) return Response.json({ message: "Not Found" }, { status: 404 });
    return { codespaces: [], total_count: 0 };
  });
  await app.connect();
  app.element("memberInput").value = "octocat";
  await app.trigger("memberLookupBtn");
  assert.match(app.requests.at(-1).url, /\/orgs\/octodemo\/members\/octocat\/codespaces\?/);
  app.element("memberRows").innerHTML = "stale";
  fail = true;
  await app.trigger("memberLookupBtn");
  assert.equal(app.element("memberRows").innerHTML, "");
  assert.equal(app.element("memberResultWrap").hidden, true);
  assert.match(app.element("notice").textContent, /Could not list/);
});

test("selected-member policy sends the required complete selected_usernames list", async () => {
  const app = createApp((url, options) => options.method ? new Response(null, { status: 204 }) : { codespaces: [], total_count: 0 });
  await app.connect();
  app.element("visibilitySelect").value = "selected_members";
  await app.trigger("visibilityForm", "submit");
  assert.equal(app.requests.length, 1);
  assert.match(app.element("notice").textContent, /valid GitHub username/);
  app.element("policyUsersInput").value = "octocat, monalisa octocat";
  await app.trigger("visibilityForm", "submit");
  const request = app.requests.at(-1);
  assert.equal(request.options.method, "PUT");
  assert.equal(request.url, "https://api.github.com/orgs/octodemo/codespaces/access");
  assert.deepEqual(JSON.parse(request.options.body), { visibility: "selected_members", selected_usernames: ["octocat", "monalisa"] });
});

test("add and remove billing access send the documented methods and bodies", async () => {
  const app = createApp((url, options) => options.method ? new Response(null, { status: 204 }) : { codespaces: [], total_count: 0 });
  await app.connect();
  for (const [id, method] of [["addUsersBtn", "POST"], ["removeUsersBtn", "DELETE"]]) {
    app.element("usernamesInput").value = "octocat, monalisa";
    await app.trigger(id);
    assert.equal(app.requests.at(-1).options.method, method);
    assert.match(app.requests.at(-1).url, /\/orgs\/octodemo\/codespaces\/access\/selected_users$/);
    assert.deepEqual(JSON.parse(app.requests.at(-1).options.body), { selected_usernames: ["octocat", "monalisa"] });
  }
});

test("stop and delete require confirmation and preserve asynchronous acceptance messages", async () => {
  const app = createApp((url, options) => options.method === "DELETE" ? Response.json({}, { status: 202 }) : { codespaces: [], total_count: 0 });
  await app.connect();
  await app.run('performSpaceAction("stop", "octocat", "test-space")');
  assert.equal(app.requests[1].url, "https://api.github.com/orgs/octodemo/members/octocat/codespaces/test-space/stop");
  assert.equal(app.requests[1].options.method, "POST");
  assert.match(app.element("notice").textContent, /Stop request accepted/);
  await app.run('performSpaceAction("delete", "octocat", "test-space")');
  assert.equal(app.requests[3].url, "https://api.github.com/orgs/octodemo/members/octocat/codespaces/test-space");
  assert.equal(app.requests[3].options.method, "DELETE");
  assert.match(app.element("notice").textContent, /Deletion request accepted/);
  assert.match(app.confirmations.at(-1), /octodemo.*Uncommitted or unpushed work may be lost/);
  const count = app.requests.length;
  app.context.window.confirm = () => false;
  await app.run('performSpaceAction("delete", "octocat", "test-space")');
  assert.equal(app.requests.length, count);
});

test("busy state blocks overlapping mutations", async () => {
  const app = createApp();
  await app.connect();
  app.run("setBusy(true)");
  await app.run('performSpaceAction("delete", "octocat", "test-space")');
  assert.equal(app.requests.length, 1);
  assert.equal(app.element("disconnectBtn").disabled, true);
});

test("untrusted repository URL schemes are not rendered as executable links", () => {
  const app = createApp();
  assert.equal(app.run('safeRepositoryUrl("javascript:alert(1)")'), "");
  assert.equal(app.run('safeRepositoryUrl("https://example.com/repo")'), "");
  assert.equal(app.run('safeRepositoryUrl("https://github.com/octodemo/repo")'), "https://github.com/octodemo/repo");
});

test("Pages workflow publishes only public files and runs the tests first", async () => {
  const workflow = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");
  assert.match(workflow, /node --test tests\/app\.test\.mjs/);
  assert.match(workflow, /cp index\.html \.nojekyll _site\//);
  assert.match(workflow, /path: _site/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
  await readFile(new URL("../.nojekyll", import.meta.url));
});

const tableFixture = [
  { name: "space-2", display_name: "Alpha", owner: { login: "zoe" }, repository: { full_name: "org/zeta" }, state: "Available", machine: { cpus: 2, memory_in_bytes: 8 * 1024 ** 3, storage_in_bytes: 32 * 1024 ** 3 }, last_used_at: "2026-10-02T12:00:00Z" },
  { name: "space-10", display_name: "Beta", owner: { login: "amy" }, repository: { full_name: "org/alpha" }, state: "Shutdown", machine: { cpus: 16, memory_in_bytes: 64 * 1024 ** 3, storage_in_bytes: 128 * 1024 ** 3 }, last_used_at: "2026-09-20T12:00:00Z" },
  { name: "space-1", display_name: "Gamma", owner: { login: "max" }, repository: { full_name: "org/middle" }, state: "Failed", machine: null, last_used_at: null }
];

test("refresh reuses the token and preserves filters and sorting, including after failure", async () => {
  let fail = false;
  const app = createApp(() => fail ? Response.json({ message: "Unavailable" }, { status: 503 }) : { codespaces: tableFixture, total_count: 3 });
  await app.connect();
  app.run('tables.spaces.filters.owner = "zoe"; tables.spaces.sortKey = "cpus"; tables.spaces.direction = -1;');
  await app.trigger("refreshBtn");
  assert.equal(app.requests.length, 2);
  assert.equal(app.requests[1].options.headers.Authorization, "Bearer test-only-placeholder");
  assert.equal(app.element("connectForm").hidden, true);
  assert.equal(app.element("connectionHint").hidden, false);
  assert.equal(app.run("tables.spaces.filters.owner"), "zoe");
  assert.equal(app.run("tables.spaces.direction"), -1);
  assert.match(app.element("activityText").textContent, /Last updated/);
  assert.match(app.element("spaceRows").innerHTML, /Alpha/);
  assert.doesNotMatch(app.element("spaceRows").innerHTML, /Beta/);
  fail = true;
  await app.trigger("refreshBtn");
  assert.equal(app.run("state.connected"), true);
  assert.equal(app.run("state.token"), "test-only-placeholder");
  assert.match(app.element("notice").textContent, /503/);
  fail = false;
  await app.trigger("refreshBtn");
  assert.equal(app.requests.length, 4);
  assert.equal(app.run("state.connected"), true);
});

test("every column in both tables has a sort control and filter", () => {
  const app = createApp();
  for (const id of ["spaceHead", "memberHead"]) {
    const head = app.element(id).innerHTML;
    for (const key of ["name", "owner", "repository", "state", "cpus", "memory", "storage", "os", "region", "branch", "devcontainer", "prebuild", "actions"]) {
      assert.ok(head.includes(`data-sort="${key}"`));
      assert.ok(head.includes(`data-filter="${key}"`));
    }
    assert.match(head, /data-sort="lastUsed"/);
    assert.match(head, /data-filter="from"/);
    assert.match(head, /data-filter="to"/);
  }
});

test("all columns sort both directions, with numeric sizes, chronological dates and missing values last", () => {
  const app = createApp();
  app.context.fixture = tableFixture;
  const orders = {
    name: ["Alpha", "Beta", "Gamma"], owner: ["Beta", "Gamma", "Alpha"],
    repository: ["Beta", "Gamma", "Alpha"], state: ["Alpha", "Gamma", "Beta"],
    cpus: ["Alpha", "Beta", "Gamma"], memory: ["Alpha", "Beta", "Gamma"],
    storage: ["Alpha", "Beta", "Gamma"], lastUsed: ["Beta", "Alpha", "Gamma"],
    actions: ["Beta", "Gamma", "Alpha"]
  };
  for (const kind of ["spaces", "member"]) {
    for (const [key, expected] of Object.entries(orders)) {
      app.run(`tables.${kind}.sortKey = "${key}"; tables.${kind}.direction = 1;`);
      assert.deepEqual(Array.from(app.run(`visibleRows(fixture, "${kind}").map(c => c.display_name)`)), expected);
      app.run(`tables.${kind}.direction = -1;`);
      const reverse = Array.from(app.run(`visibleRows(fixture, "${kind}").map(c => c.display_name)`));
      if (["cpus", "memory", "storage", "lastUsed"].includes(key)) {
        assert.deepEqual(reverse, [expected[1], expected[0], "Gamma"]);
      } else if (key === "actions") {
        assert.deepEqual(reverse, ["Alpha", "Beta", "Gamma"]);
      } else assert.deepEqual(reverse, [...expected].reverse());
    }
  }
});

test("column filters combine independently with search, date ranges and exact machine sizes", () => {
  const app = createApp();
  app.context.fixture = tableFixture;
  for (const kind of ["spaces", "member"]) {
    const filters = [
      ["name", "SPACE-2", "Alpha"], ["owner", "AMY", "Beta"],
      ["repository", "MIDDLE", "Gamma"], ["state", "shutdown", "Beta"],
      ["cpus", "16", "Beta"], ["memory", "8", "Alpha"],
      ["storage", "128", "Beta"], ["actions", "stop", "Alpha"]
    ];
    for (const [key, value, expected] of filters) {
      app.run(`tables.${kind}.filters = ${JSON.stringify({ [key]: value })};`);
      assert.deepEqual(Array.from(app.run(`visibleRows(fixture, "${kind}").map(c => c.display_name)`)), [expected]);
    }
    app.run(`tables.${kind}.filters = { owner: "zoe", cpus: "2", from: "2026-10-02", to: "2026-10-02" };`);
    assert.equal(app.run(`visibleRows(fixture, "${kind}", "alpha").length`), 1);
    assert.equal(app.run(`visibleRows(fixture, "${kind}", "beta").length`), 0);
    app.run(`tables.${kind}.filters = { from: "2026-10-03", to: "2026-10-01" };`);
    assert.equal(app.run(`visibleRows(fixture, "${kind}").length`), 0);
    app.run(`tables.${kind}.filters = { memory: "6" };`);
    assert.equal(app.run(`visibleRows(fixture, "${kind}").length`), 0);
  }
});

test("column header clicks toggle sort direction and input filters update without replacing inputs", async () => {
  const app = createApp(() => ({ codespaces: tableFixture, total_count: 3 }));
  await app.connect();
  const sortEvent = { target: { closest: () => ({ dataset: { sort: "cpus" } }) } };
  app.element("spaceHead").handlers.click(sortEvent);
  assert.equal(app.run("tables.spaces.direction"), 1);
  assert.match(app.element("spaceHead").innerHTML, /aria-sort="ascending"/);
  app.element("spaceHead").handlers.click(sortEvent);
  assert.equal(app.run("tables.spaces.direction"), -1);
  const oldHead = app.element("spaceHead").innerHTML;
  app.element("spaceHead").handlers.input({ target: { dataset: { filter: "owner" }, value: "amy" } });
  assert.equal(app.element("spaceHead").innerHTML, oldHead);
  assert.match(app.element("spaceRows").innerHTML, /Beta/);
  assert.doesNotMatch(app.element("spaceRows").innerHTML, /Alpha/);
  await app.trigger("clearSpaceFiltersBtn");
  assert.equal(app.run("Object.keys(tables.spaces.filters).length"), 0);
  assert.equal(app.run("tables.spaces.direction"), -1);
});

test("machine sizes render as separate cells in inventory and member results, with correct units", () => {
  const app = createApp();
  app.context.fixture = tableFixture;
  for (const compact of [false, true]) {
    app.run(`drawRows(fixture, $("${compact ? "memberRows" : "spaceRows"}"), ${compact})`);
    const rows = app.element(compact ? "memberRows" : "spaceRows").innerHTML;
    assert.equal((rows.match(/<td(?:\s|>)/g) || []).length, app.run("columns.length") * tableFixture.length);
    assert.match(rows, /class="machine">2<\/td>\s*<td class="machine">8<\/td>\s*<td class="machine">32<\/td>/);
    assert.match(rows, /class="machine">16<\/td>\s*<td class="machine">64<\/td>\s*<td class="machine">128<\/td>/);
    assert.match(rows, /class="machine">—<\/td>/);
  }
});

test("environment properties are rendered, sortable and filterable in both inventories", () => {
  const app = createApp();
  app.context.fixture = [
    { name: "alpha", machine: { operating_system: "linux" }, location: "WestEurope", git_status: { ref: "main" }, devcontainer_path: ".devcontainer/devcontainer.json", prebuild: false },
    { name: "beta", machine: { operating_system: "windows" }, location: "EastUs", git_status: { ref: "feature" }, devcontainer_path: ".devcontainer/custom.json", prebuild: true }
  ];
  for (const kind of ["spaces", "member"]) {
    for (const [key, filter, expected] of [
      ["os", "LINUX", "alpha"], ["region", "east", "beta"], ["branch", "main", "alpha"],
      ["devcontainer", "custom", "beta"], ["prebuild", "yes", "beta"]
    ]) {
      app.run(`tables.${kind}.filters = ${JSON.stringify({ [key]: filter })}`);
      assert.deepEqual(Array.from(app.run(`visibleRows(fixture, "${kind}").map(c => c.name)`)), [expected]);
      app.run(`tables.${kind}.filters = {}; tables.${kind}.sortKey = "${key}"; tables.${kind}.direction = 1;`);
      const ascending = Array.from(app.run(`visibleRows(fixture, "${kind}").map(c => c.name)`));
      app.run(`tables.${kind}.direction = -1`);
      assert.deepEqual(Array.from(app.run(`visibleRows(fixture, "${kind}").map(c => c.name)`)), ascending.reverse());
    }
    app.run(`drawRows(fixture, $("${kind === "member" ? "memberRows" : "spaceRows"}"), ${kind === "member"})`);
    const markup = app.element(kind === "member" ? "memberRows" : "spaceRows").innerHTML;
    assert.match(markup, /WestEurope/);
    assert.match(markup, /\.devcontainer\/devcontainer.json/);
    assert.doesNotMatch(markup, /Not exposed by API|Base image/);
  }
});

test("former details render as individual columns, preserving missing values, false, zero and escaping", () => {
  const app = createApp();
  app.context.fixture = { name: "<script>bad</script>", id: 42, idle_timeout_minutes: 0, prebuild: false, git_status: { has_uncommitted_changes: false, ahead: 0 }, billable_owner: { login: "octodemo" } };
  app.run('drawRows([fixture], $("spaceRows"), false)');
  const markup = app.element("spaceRows").innerHTML;
  assert.match(markup, /&lt;script&gt;bad&lt;\/script&gt;/);
  assert.doesNotMatch(markup, /<script>/);
  const values = Array.from(app.run('columns.map(column => column.text(fixture))'));
  const keys = Array.from(app.run('columns.map(column => column.key)'));
  const cell = (key) => values[keys.indexOf(key)];
  assert.equal(cell("idleTimeout"), "0");
  assert.equal(cell("uncommitted"), "No");
  assert.equal(cell("unpushed"), "Not provided");
  assert.equal(cell("billableOwner"), "octodemo");
  assert.doesNotMatch(markup, /<details/);
  assert.equal(app.run("booleanProperty(fixture.prebuild)"), "No");
  assert.equal(app.run("booleanProperty(null)"), "Not provided");
});

test("all former details have sortable and filterable columns in both tables", () => {
  const app = createApp();
  const expected = ["id", "billableOwner", "machineType", "machineDescription", "created", "updated", "idleTimeout", "retention", "retentionExpires", "uncommitted", "unpushed", "ahead", "behind", "pending", "disabledReason", "prebuildAvailability"];
  for (const id of ["spaceHead", "memberHead"]) {
    for (const key of expected) {
      assert.ok(app.element(id).innerHTML.includes(`data-sort="${key}"`), key);
      assert.ok(app.element(id).innerHTML.includes(`data-filter="${key}${["created", "updated", "retentionExpires"].includes(key) ? "From" : ""}"`), key);
    }
  }
  assert.equal(app.run("columns.length"), 30);
});

test("former numeric and date details sort using typed values, with independent filters", () => {
  const app = createApp();
  app.context.fixture = [
    { name: "first", id: 2, idle_timeout_minutes: 2, retention_period_minutes: 20, created_at: "2026-09-01T12:00:00Z", updated_at: "2026-10-20T12:00:00Z", retention_expires_at: "2026-12-01T12:00:00Z", git_status: { ahead: 2, behind: 2 } },
    { name: "second", id: 10, idle_timeout_minutes: 10, retention_period_minutes: 100, created_at: "2026-10-01T12:00:00Z", updated_at: "2026-10-01T12:00:00Z", retention_expires_at: "2026-11-01T12:00:00Z", git_status: { ahead: 10, behind: 10 } },
    { name: "missing" }
  ];
  for (const kind of ["spaces", "member"]) {
    for (const key of ["id", "idleTimeout", "retention", "ahead", "behind", "created", "updated", "retentionExpires"]) {
      app.run(`tables.${kind}.sortKey = "${key}"; tables.${kind}.direction = 1`);
      const ascending = Array.from(app.run(`visibleRows(fixture, "${kind}").map(c => c.name)`));
      assert.equal(ascending.at(-1), "missing");
      app.run(`tables.${kind}.direction = -1`);
      assert.deepEqual(Array.from(app.run(`visibleRows(fixture, "${kind}").map(c => c.name)`)), [ascending[1], ascending[0], "missing"]);
    }
    app.run(`tables.${kind}.filters = { createdFrom: "2026-09-01", createdTo: "2026-09-01", updatedFrom: "2026-10-20", retentionExpiresTo: "2026-12-01", ahead: "2" }`);
    assert.deepEqual(Array.from(app.run(`visibleRows(fixture, "${kind}").map(c => c.name)`)), ["first"]);
    app.run(`tables.${kind}.filters.createdTo = "2026-08-01"`);
    assert.equal(app.run(`visibleRows(fixture, "${kind}").length`), 0);
  }
});
