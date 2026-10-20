import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { Store } from "../src/storage/store.js";
import { ProductEngine } from "../src/product/engine.js";
import { createProductServer } from "../src/server.js";
import type { DiscoveryDraft, Question } from "../src/discovery/discovery.js";
import { answerDiscoveryFixture } from "./product-fixture.js";
import { preparedField } from "./preparation-fixture.js";
import { prepareOmFixtureStages, prepareNativeLayers } from "./om-fixture.js";
import { enrichedGraph } from "./enriched-graph-fixture.js";
import { exampleGraph } from "./graph-fixture.js";
import { listOwnerQuestions } from "../src/om/owner-result.js";
import { readRoutes } from "../src/om/routes.js";
import { readOmInput } from "../src/om/input.js";
import { git, MODE_ROLE_COMMANDS, resolveRoleMode } from "../src/runtime/environment.js";
import { reference } from "../src/pipeline/contracts.js";

test("browser completes source→discovery→acceptance, survives reload and fits desktop/mobile", { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-browser-")); const store = new Store(join(root, "state.sqlite"));
  const engine = new ProductEngine(store); const server = createProductServer(engine);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(async () => { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/#token=${server.accessToken}`);
  await page.getByRole("button", { name: "Создать проект", exact: true }).click();
  await page.getByLabel("Название", { exact: true }).fill("Садовый помощник");
  await page.getByRole("button", { name: "Создать", exact: true }).click();
  await page.getByRole("heading", { name: "Садовый помощник", exact: true }).waitFor();
  await page.getByRole("tab", { name: "Источники", exact: true }).click();
  await page.getByLabel("Исходное поручение или документ").fill("Нужен помощник для планирования посадок.");
  await page.getByRole("button", { name: "Добавить документ", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Изменения сохранены" }).waitFor();
  await page.getByRole("tab", { name: "Обзор", exact: true }).click();
  await page.getByRole("button", { name: "Начать discovery", exact: true }).click();
  await page.getByRole("button", { name: "Проверить по источнику", exact: true }).click();
  await page.getByLabel("Ваше решение", { exact: true }).fill("Планировать посадки без потери заметок");
  await page.getByRole("button", { name: "Принять решение", exact: true }).click();
  const project = store.list<{ id: string }>("project")[0]!.value.id;
  const discovery = store.list<DiscoveryDraft>("discovery-draft").find(row => row.value.projectId === project
    && row.value.stage === "discovery")!;
  const source = store.list<{ projectId: string; content: string }>("source")
    .find(row => row.value.projectId === project)!;
  for (const id of discovery.value.questions) {
    const question = store.get<Question>(id)!;
    if (question.value.spec.kind === "design") answerDiscoveryFixture(engine, project,
      store.get<DiscoveryDraft>(discovery.id)!, question, preparedField(project, question.value.spec.field), source);
  }
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await page.getByRole("button", { name: "Собрать результат стадии", exact: true }).click();
  await page.getByRole("button", { name: "Принять результат", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Результат принят" }).waitFor();
  await page.reload();
  await page.locator(".stage-panel .section-heading .badge.accepted").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole("tab", { name: "Среда и роли", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать папку", exact: true }).click();
  await page.getByRole("dialog").getByRole("heading", { name: "Рабочая папка проекта" }).waitFor();
  await page.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.getByLabel("Корень Git-репозитория", { exact: true }).fill(root);
  await page.locator("fieldset").nth(0).getByLabel("Модель", { exact: true }).fill("ui-worker");
  await page.locator("fieldset").nth(1).getByLabel("Модель", { exact: true }).fill("ui-reviewer");
  const program = join(root, "ui-agent.mjs");
  writeFileSync(program, `import {readFileSync} from 'node:fs'; const r=JSON.parse(readFileSync(0,'utf8')); console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,text:'Проверенный ответ тестового исполнителя'}));`);
  await page.getByLabel("Собственный адаптер по протоколу OMG").check();
  await page.getByLabel("Команды implementer и reviewer", { exact: true }).fill(JSON.stringify({ implementer: { executable: process.execPath, args: [program] }, reviewer: { executable: process.execPath, args: [program] } }));
  await page.getByLabel("Команда полной проверки", { exact: true }).fill(process.execPath);
  await page.getByLabel("Аргументы команды (JSON-массив)", { exact: true }).fill('["--version"]');
  await page.getByRole("button", { name: "Сохранить среду и роли", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Изменения сохранены" }).waitFor();
  const configured = engine.environments.get(project), chatProgram = join(root, "ui-chat-agent.mjs");
  writeFileSync(chatProgram, `import {readFileSync} from 'node:fs'; const r=JSON.parse(readFileSync(0,'utf8')); console.log(JSON.stringify({protocol:r.protocol,requestId:r.requestId,text:'Режимная команда чата сохранена'}));`);
  const { projectId: _projectId, ...settings } = configured.value;
  engine.environments.configure(project, { ...settings,
    implementer: { ...settings.implementer, commandContract: MODE_ROLE_COMMANDS,
      modeCommands: { implement: settings.implementer.command, chat: { executable: process.execPath, args: [chatProgram] } } },
    reviewer: { ...settings.reviewer, commandContract: MODE_ROLE_COMMANDS,
      modeCommands: { review: settings.reviewer.command } } }, configured.revision);
  await page.reload(); await page.getByRole("tab", { name: "Среда и роли", exact: true }).click();
  await page.getByRole("button", { name: "Сохранить среду и роли", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Изменения сохранены" }).waitFor();
  const preserved = engine.environments.get(project);
  assert.equal(preserved.value.implementer.commandContract, MODE_ROLE_COMMANDS);
  assert.deepEqual(resolveRoleMode("implementer", preserved.value.implementer, "chat").command,
    { executable: process.execPath, args: [chatProgram] });
  await page.getByRole("tab", { name: "Чат", exact: true }).click();
  await page.getByLabel("Сообщение", { exact: true }).fill("Объясни состояние проекта");
  await page.getByRole("button", { name: "Отправить выбранной модели", exact: true }).click();
  const reply = page.locator(".bubble.assistant").filter({ hasText: "Режимная команда чата сохранена" });
  await reply.waitFor();
  assert.equal((await reply.innerText()).replace(/\s+/g, " "), "ui-worker Режимная команда чата сохранена");
  await page.reload(); await page.getByRole("tab", { name: "Среда и роли", exact: true }).click();
  assert.equal(await page.locator("fieldset").nth(0).getByLabel("Модель", { exact: true }).inputValue(), "ui-worker");
  assert.equal(await page.getByLabel("Собственный адаптер по протоколу OMG").isChecked(), true);
  await page.getByRole("tab", { name: "Обзор", exact: true }).click();
  const output = resolve(".omg/ui-checks"); mkdirSync(output, { recursive: true });
  await page.screenshot({ path: join(output, "desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByLabel("Выбор стадии", { exact: true }).selectOption("concept");
  await page.getByRole("heading", { name: "Концепция", exact: true }).waitFor();
  await page.screenshot({ path: join(output, "mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
});

test("browser labels fact, owner decision and model design by provenance and offers no manual design answer", { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-in1-ui-")), store = new Store(join(root, "state.sqlite"));
  const engine = new ProductEngine(store); engine.execute({ type: "create-project", project: "p", title: "Input labels" });
  const source = engine.discovery.evidence.document("p", "instruction", "Build the requested product", "text/plain", 0);
  const discovery = engine.prepare("p", "discovery");
  const questions = discovery.value.questions.map(id => store.get<Question>(id)!);
  const brief = questions.find(row => row.value.spec.field === "brief")!;
  const objective = questions.find(row => row.value.spec.field === "objective")!;
  const researchPlan = questions.find(row => row.value.spec.field === "researchPlan")!;
  engine.discovery.fact(brief.id, brief.revision, reference(source),
    { kind: "text-range", start: 0, end: source.value.content.length });
  engine.discovery.decision(objective.id, objective.revision, "local-caller", "Build the requested product");
  answerDiscoveryFixture(engine, "p", store.get<DiscoveryDraft>(discovery.id)!, researchPlan,
    preparedField("p", "researchPlan"), source);
  const plain = engine.discovery.create("p", "concept", "R0", "operation-map", [
    { field: "plainProposal", kind: "design", prompt: "Saved plain proposal", risk: "Proposal missing",
      schema: { type: "string", minLength: 1 } },
    { field: "pendingProposal", kind: "design", prompt: "Pending model proposal", risk: "Proposal missing",
      schema: { type: "string", minLength: 1 } },
  ]);
  const plainQuestion = store.get<Question>(plain.value.questions[0]!)!;
  engine.discovery.decision(plainQuestion.id, plainQuestion.revision, "local-caller", "A project proposal");
  const server = createProductServer(engine);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(async () => { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); rmSync(root, { recursive: true, force: true }); });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/#token=${server.accessToken}`);
  await page.getByRole("tab", { name: "Исследования", exact: true }).click();
  const article = (prompt: string) => page.locator("article.question").filter({ hasText: prompt }).first();
  assert.match(await article(brief.value.spec.prompt).locator(".eyebrow").innerText(), /ПОДТВЕРЖДАЕМЫЙ ФАКТ/);
  assert.match(await article(objective.value.spec.prompt).locator(".eyebrow").innerText(), /РЕШЕНИЕ ВЛАДЕЛЬЦА/);
  assert.match(await article(researchPlan.value.spec.prompt).locator(".eyebrow").innerText(), /ПРЕДЛОЖЕНИЕ МОДЕЛИ/);
  assert.match(await article(researchPlan.value.spec.prompt).innerText(), /Принято по независимой оценке исследования\./);
  assert.match(await article("Saved plain proposal").innerText(), /Зафиксировано проектное предложение\./);
  assert.match(await article("Saved plain proposal").locator(".eyebrow").innerText(), /ПРОЕКТНОЕ ПРЕДЛОЖЕНИЕ/);
  assert.doesNotMatch(await article("Saved plain proposal").locator(".eyebrow").innerText(), /МОДЕЛИ/);
  const pending = article("Pending model proposal");
  assert.match(await pending.locator(".eyebrow").innerText(), /ПРЕДЛОЖЕНИЕ МОДЕЛИ/);
  assert.match(await pending.innerText(), /Ответ даёт исследование стадии\./);
  assert.equal(await pending.locator("form").count(), 0);
  assert.equal(await pending.getByRole("button", { name: "Проверить по источнику" }).count(), 0);
});

test("browser compiles the accepted map and reloads the generated task dependencies", { timeout: 60_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "omg-plan-ui-")); const workspace = join(root, "repo"); mkdirSync(workspace);
  git(workspace, ["init", "-b", "main"]); writeFileSync(join(workspace, "README.md"), "Product input\n");
  git(workspace, ["add", "README.md"]); git(workspace, ["-c", "user.name=OMG Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  const store = new Store(join(root, "state.sqlite")); const engine = new ProductEngine(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const graph = enrichedGraph(exampleGraph("garden"), "garden");
  prepareOmFixtureStages(engine, "garden", graph); const command = { executable: process.execPath, args: ["--version"] };
  engine.environments.configure("garden", { workspace, implementer: { actor: "worker", model: "fixture", effort: "high", command },
    reviewer: { actor: "reviewer", model: "fixture", effort: "high", command }, fullCheck: command, timeoutMs: 1000, requestCapacityChars: 100_000 }, 0);
  prepareNativeLayers(engine, "garden", graph, "executed");
  assert.equal(store.list("phase").length, 0);
  assert.equal(store.get("om-feasibility:garden")?.kind, "feasibility");
  assert.equal(engine.pipeline.inspect("garden", "om-g2").state, "accepted");
  const server = createProductServer(engine);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(async () => { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const page = await browser.newPage();
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  let projected = 0;
  await page.route("**/api/project?*", async route => {
    const response = await route.fetch(), view = await response.json();
    // LG30 removes these projection fields. Do not let an old server shape mask a UI dependency.
    delete view.phases; delete view.feasibility; delete view.feasibilityGate;
    const ownerQuestions = listOwnerQuestions(store, "garden", { routes: readRoutes, input: readOmInput });
    assert.deepEqual(ownerQuestions, { ok: true, value: [] });
    await route.fulfill({ response, json: { ...view, ownerQuestions } });
    projected++;
  });
  await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/#token=${server.accessToken}`);
  await page.getByLabel("Выбор стадии", { exact: true }).selectOption("om-g2");
  await page.getByText("Нет вопросов, ожидающих решения владельца.", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Одноразовое приглашение", { exact: true }).count(), 0);
  assert.equal(await page.getByRole("button", { name: "Войти как владелец", exact: true }).count(), 0);
  assert.equal(await page.locator(".phase-grid, .phase, .stage-panel .research-group").count(), 0);
  for (const name of ["Открыть вопросы", "Зафиксировать уровень", "Завершить R0", "Завершить R1", "Завершить R2", "Проверить R3", "Собрать результат OM-G2"])
    assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, name);
  await page.getByLabel("Выбор стадии", { exact: true }).selectOption("compilation");
  await page.getByRole("button", { name: "Скомпилировать машинный план", exact: true }).click();
  await page.getByRole("heading", { name: "Задач в горизонте: 2", exact: true }).waitFor();
  assert.equal(await page.getByText("Предшественники: produce work", { exact: true }).count(), 1);
  await page.reload(); await page.getByLabel("Выбор стадии", { exact: true }).selectOption("compilation");
  await page.getByRole("heading", { name: "Задач в горизонте: 2", exact: true }).waitFor();
  assert.equal(await page.locator(".stage-panel .section-heading .badge.accepted").count(), 1);
  await page.getByText("Нет вопросов, ожидающих решения владельца.", { exact: true }).waitFor();
  assert.ok(projected >= 2, "The cold reload receives the narrowed projection too");
  assert.deepEqual(errors, []);
});
