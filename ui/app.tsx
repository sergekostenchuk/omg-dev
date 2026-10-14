import { Children, cloneElement, isValidElement, useEffect, useId, useRef, useState, type ReactNode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { ProductEngine, Project } from "../src/product/engine.js";
import type { Revision } from "../src/storage/store.js";
import type { Stage } from "../src/pipeline/contracts.js";
import type { Graph } from "../src/graph/model.js";
import type { Environment } from "../src/runtime/environment.js";
import type { OwnerQuestionItem } from "../src/om/owner-result.js";
import "./app.css";
import { PlanPanel } from "./plan.js";
import { ExecutionPanel } from "./execution.js";

type View = ReturnType<ProductEngine['projection']>;
type Provider = { id: string; label: string; available: boolean; command: { executable: string; args: string[] }; models: { id: string; label: string }[] };
const labels: Record<Stage, string> = { discovery: "Дискавери", concept: "Концепция", "operation-map": "Операционная карта", specification: "ТЗ", features: "Фичи", "om-g2": "OM-G2", compilation: "Машинный план", execution: "Исполнение" };
const states: Record<string, string> = { missing: "Не начат", draft: "Черновик", blocked: "Нужны данные", accepted: "Принят", stale: "Пересмотр", open: "Открыт", answered: "Отвечен", unresolved: "Не разрешён" };
const tokenKey = `omg-session:${location.host}`;
const connectionToken = new URLSearchParams(location.hash.slice(1)).get("token");
if (connectionToken && /^[a-f0-9]{64}$/.test(connectionToken)) { sessionStorage.setItem(tokenKey, connectionToken); history.replaceState(null, "", location.pathname + location.search); }
const token = sessionStorage.getItem(tokenKey) ?? "";
async function api<T>(path: string, data?: unknown): Promise<T> {
  const response = await fetch(`/api/${path}`, { method: data === undefined ? "GET" : "POST",
    headers: { "X-OMG-Token": token, ...(data === undefined ? {} : { "Content-Type": "application/json" }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.message ?? result.error); return result as T;
}
const ref = (record: Revision<unknown>) => ({ id: record.id, revision: record.revision, hash: record.hash });
function Field({ label, children }: { label: string; children: ReactNode }) {
  const id = useId(); let assigned = false;
  const attach = (nodes: ReactNode): ReactNode => Children.map(nodes, child => {
    if (!isValidElement(child)) return child;
    const element = child as ReactElement<{ children?: ReactNode; id?: string; "aria-labelledby"?: string }>;
    if (!assigned && typeof element.type === "string" && ["input", "select", "textarea"].includes(element.type)) {
      assigned = true; return cloneElement(element, { id, "aria-labelledby": `${id}-label` });
    }
    return element.props.children ? cloneElement(element, {}, attach(element.props.children)) : element;
  });
  return <div className="field"><label id={`${id}-label`} htmlFor={id}>{label}</label>{attach(children)}</div>;
}
function Badge({ state }: { state: string }) { return <span className={`badge ${state}`}>{states[state] ?? state}</span>; }
function Modal({ title, close, children }: { title: string; close: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null); const titleId = useId();
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} aria-labelledby={titleId} onCancel={close}><header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Закрыть" onClick={close}>×</button></header>{children}</dialog>;
}
type Run = (action: () => Promise<unknown>, success?: string) => Promise<void>;
type Cmd = <T = unknown>(command: unknown) => Promise<T>;

function App() {
  const [projects, setProjects] = useState<Revision<Project>[]>([]); const [selected, setSelected] = useState(localStorage.getItem("omg-project") ?? "");
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const [view, setView] = useState<View | null>(null); const [tab, setTab] = useState("overview"); const [stage, setStage] = useState<Stage>("discovery");
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [creating, setCreating] = useState(false); const [title, setTitle] = useState(""); const [providers, setProviders] = useState<Provider[]>([]);
  const cmd: Cmd = command => api("command", command);
  const refresh = async (id = selected) => { setProjects(await api("projects")); if (id) { const next = await api<View>(`project?id=${encodeURIComponent(id)}`); if (selectedRef.current === id) setView(next); } };
  useEffect(() => { Promise.all([api<Revision<Project>[]>("projects"), api<Provider[]>("providers")]).then(([rows, options]) => {
    setProjects(rows); setProviders(options); if (!selected && rows[0]) setSelected(rows[0].value.id);
  }).catch(error => setNotice({ error: true, text: error.message })).finally(() => setLoading(false)); }, []);
  useEffect(() => {
    let active = true; setView(null);
    if (selected) { localStorage.setItem("omg-project", selected); setLoading(true); api<View>(`project?id=${encodeURIComponent(selected)}`).then(value => { if (active) setView(value); }).catch(error => { if (active) setNotice({ error: true, text: error.message }); }).finally(() => { if (active) setLoading(false); }); }
    return () => { active = false; };
  }, [selected]);
  const run: Run = async (action, success = "Изменения сохранены") => {
    setBusy(true); setNotice(null);
    try { await action(); await refresh(); setNotice({ error: false, text: success }); }
    catch (error) { await refresh().catch(() => {}); setNotice({ error: true, text: error instanceof Error ? error.message : "Не удалось выполнить действие" }); }
    finally { setBusy(false); }
  };
  const tabs = [["overview", "Обзор"], ["map", "Карта"], ["research", "Исследования"], ["sources", "Источники"], ["settings", "Среда и роли"], ["chat", "Чат"]];
  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><span className="brand-mark">O</span><strong>OMG</strong><small>PRODUCT ENGINE</small></div>
      <div className="project-picker"><label htmlFor="project">Проект</label><select id="project" value={selected} onChange={e => setSelected(e.target.value)}><option value="">Выберите проект</option>{projects.map(row => <option key={row.id} value={row.value.id}>{row.value.title}</option>)}</select><button className="secondary" onClick={() => setCreating(true)}>+ Новый проект</button></div>
      <div className="nav-label">КОНВЕЙЕР</div><nav aria-label="Стадии продукта">{view?.stages.map((item, index) => <button key={item.stage} className={`stage-link ${stage === item.stage && tab === "overview" ? "selected" : ""}`} onClick={() => { setStage(item.stage); setTab("overview"); }}><span className={`stage-number ${item.state}`}>{item.state === "accepted" ? "✓" : index + 1}</span><span>{labels[item.stage]}<small>{states[item.state]}</small></span></button>)}</nav>
      <div className="sidebar-footer"><span className="live-dot"/> SQLite · локальное состояние</div></aside>
    <main><header className="topbar"><div><div className="eyebrow">ЕДИНЫЙ КОНВЕЙЕР ПРОДУКТА</div><h1>{view?.project.value.title ?? "От идеи к работающему продукту"}</h1></div><button className="secondary" disabled={busy || loading} onClick={() => run(() => refresh(), "Состояние обновлено")}>Обновить</button></header>
      <div className="tabs" role="tablist" aria-label="Разделы проекта">{tabs.map(([id, text]) => <button role="tab" aria-selected={tab === id} key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id!)} disabled={!view}>{text}</button>)}</div>
      {notice && <div role={notice.error ? "alert" : "status"} className={`notice ${notice.error ? "error" : "success"}`}>{notice.text}<button className="icon-button" aria-label="Скрыть уведомление" onClick={() => setNotice(null)}>×</button></div>}
      {busy && <div className="working" role="status">Движок выполняет команду…</div>}
      {loading ? <div className="empty" role="status"><div className="spinner"/>Загрузка состояния…</div> : !view ? <div className="empty"><div className="empty-symbol">◇</div><h2>Начните с исходного поручения</h2><p>Создайте проект. Движок свяжет его карту, вопросы, доказательства и результаты в один конвейер.</p><button onClick={() => setCreating(true)}>Создать проект</button></div> : <div className="page-content">
        {tab === "overview" && <>{view.ownerQuestions && <OwnerPanel view={view} run={run} busy={busy}/>}<div className="summary-strip"><div><small>Принято стадий</small><strong>{view.stages.filter(s => s.state === "accepted").length}<span> / 8</span></strong></div><div><small>Узлов карты</small><strong>{view.graph?.value.nodes.length ?? 0}</strong></div><div><small>Открытых вопросов</small><strong>{view.questions.filter(q => q.value.status !== "answered").length}</strong></div><div><small>Проверяемых источников</small><strong>{view.sources.length}</strong></div></div><Field label="Выбор стадии"><select value={stage} onChange={event => setStage(event.target.value as Stage)}>{view.stages.map(item => <option key={item.stage} value={item.stage}>{labels[item.stage]} · {states[item.state]}</option>)}</select></Field><StagePanel view={view} stage={stage} cmd={cmd} run={run} busy={busy}/></>}
        {tab === "map" && <GraphPanel view={view} cmd={cmd} run={run} busy={busy}/>}
        {tab === "research" && <section><h2>Вопросы и основания решений</h2><p className="muted">Факты подтверждаются источниками. Цели и предпочтения фиксируются как решения владельца.</p>{view.questions.length === 0 ? <p className="empty-inline">Начните discovery выбранной стадии — вопросы появятся здесь.</p> : view.questions.map(q => <QuestionPanel key={`${q.id}:${q.revision}`} question={q} view={view} cmd={cmd} run={run} busy={busy}/>)}</section>}
        {tab === "sources" && <Sources view={view} cmd={cmd} run={run} busy={busy}/>}
        {tab === "settings" && <Settings key={view.environment?.revision ?? 0} view={view} providers={providers} cmd={cmd} run={run} busy={busy}/>}
        {tab === "chat" && <ChatPanel view={view} run={run} busy={busy}/>}
      </div>}
    </main>
    {creating && <Modal title="Новый продукт" close={() => setCreating(false)}><form onSubmit={e => { e.preventDefault(); const id = `project-${Date.now()}`; void run(async () => { await cmd({ type: "create-project", project: id, title }); setCreating(false); setTitle(""); setSelected(id); }, "Проект создан"); }}><Field label="Название"><input autoFocus required value={title} onChange={e => setTitle(e.target.value)}/></Field><p className="muted">Первый шаг — добавить исходное поручение и определить желаемый результат.</p><footer><button type="button" className="secondary" onClick={() => setCreating(false)}>Отмена</button><button disabled={busy || !title.trim()}>Создать</button></footer></form></Modal>}
  </div>;
}

function StagePanel({ view, stage, cmd, run, busy }: { view: View; stage: Stage; cmd: Cmd; run: Run; busy: boolean }) {
  const current = view.stages.find(item => item.stage === stage)!; const index = view.stages.indexOf(current); const ready = index === 0 || view.stages[index - 1]?.state === "accepted";
  const drafts = view.drafts.filter(item => item.value.stage === stage).sort((a,b) => (a.value.createdAt ?? 0) - (b.value.createdAt ?? 0)); const draft = drafts.at(-1);
  const upstream = index < 5; const project = view.project.value.id;
  return <section className="stage-panel"><div className="section-heading"><div><div className="eyebrow">СТАДИЯ {index + 1}</div><h2>{labels[stage]}</h2></div><Badge state={current.state}/></div>
    {current.findings.length > 0 && <div className="findings"><h3>Что требует внимания</h3><ul>{current.findings.map((finding, i) => <li key={i}>{finding.message}<small>{finding.code} · {finding.target}</small></li>)}</ul></div>}
    {upstream && <><div className="action-row"><button disabled={busy || !ready} title={!ready ? "Сначала примите предыдущую стадию" : ""} onClick={() => run(() => cmd({ type: "prepare-stage", project, stage }), "Вопросы подготовлены")}>{draft ? "Новый проход discovery" : "Начать discovery"}</button>{!ready && <span className="muted">Сначала примите предыдущую стадию.</span>}</div>
      {draft && <><div className="section-label">ТЕКУЩЕЕ ИССЛЕДОВАНИЕ</div>{draft.value.questions.map(id => { const question = view.questions.find(q => q.id === id); return question ? <QuestionPanel key={`${id}:${question.revision}`} question={question} view={view} cmd={cmd} run={run} busy={busy}/> : null; })}
        <div className="action-row">{stage === "operation-map" && <button className="secondary" disabled={busy} onClick={() => run(() => cmd({ type: "build-map", project, draftId: draft.id, expected: view.graph?.revision ?? 0 }), "Карта построена из пользовательского пути")}>Построить карту из пути</button>}
          <button disabled={busy || !ready} onClick={() => run(() => cmd({ type: "draft-stage", project, stage, draftId: draft.id, expected: current.artifact?.revision ?? 0 }), "Результат стадии собран")}>Собрать результат стадии</button></div></>}
    </>}
    {stage === "om-g2" && <RefinementPanel view={view} cmd={cmd} run={run} busy={busy}/>}
    {stage === "compilation" && <PlanPanel view={view} busy={busy} compile={() => { void run(() => cmd({ type: "compile", project }), "Машинный план скомпилирован и проверен"); }}/>} 
    {stage === "execution" && <ExecutionPanel view={view} command={cmd} refresh={() => run(async () => {}, "Состояние исполнения обновлено")}/>}
    {current.artifact && <><div className="artifact-bar"><div><strong>Версия {current.artifact.revision}</strong><small>Привязана к исходным данным и доказательствам</small></div><button disabled={busy || current.state !== "draft"} onClick={() => run(() => cmd({ type: "accept-stage", project, stage, expected: current.artifact!.revision }), "Результат принят")}>Принять результат</button></div><details><summary>Содержание и привязки</summary><pre>{JSON.stringify(current.artifact.value.content, null, 2)}</pre></details></>}
  </section>;
}

function QuestionPanel({ question, view, cmd, run, busy }: { question: View['questions'][number]; view: View; cmd: Cmd; run: Run; busy: boolean }) {
  const q = question.value; const [answer, setAnswer] = useState(""); const [sourceId, setSourceId] = useState(view.sources[0]?.id ?? ""); const [pointer, setPointer] = useState("");
  const source = view.sources.find(item => item.id === sourceId); const schema = q.spec.schema as { type?: string; items?: { type?: string } };
  const values = view.drafts.find(d => d.id === q.draftId)?.value.fields;
  const parseValue = () => schema.type === "array" && schema.items?.type === "string" ? answer.split("\n").map(line => line.trim()).filter(Boolean)
    : schema.type === "array" || schema.type === "object" ? JSON.parse(answer) : answer;
  const assessed = q.answer?.id.startsWith("research-answer:") === true;
  const label = q.spec.kind === "fact" ? "ПОДТВЕРЖДАЕМЫЙ ФАКТ"
    : q.spec.kind === "decision" ? "РЕШЕНИЕ ВЛАДЕЛЬЦА"
    : q.status === "answered" && !assessed ? "ПРОЕКТНОЕ ПРЕДЛОЖЕНИЕ" : "ПРЕДЛОЖЕНИЕ МОДЕЛИ";
  const note = question.assessment.state === "stale" ? "Основание или контекст ответа изменились — требуется пересмотр."
    : q.status === "answered" ? q.spec.kind === "fact" ? "Ответ проверен по привязанной версии источника."
      : q.spec.kind === "decision" ? "Зафиксировано решение владельца."
      : assessed ? "Принято по независимой оценке исследования." : "Зафиксировано проектное предложение."
    : q.spec.kind === "design" ? "Ответ даёт исследование стадии." : `Риск: ${q.spec.risk}`;
  return <article className="question"><div className="question-top"><span className="eyebrow">{q.level} · {label}</span><Badge state={question.assessment.state}/></div><h3>{q.spec.prompt}</h3><p className="muted">{note}</p>
    {q.status === "answered" ? <><div className="answer-value">{typeof values?.[q.spec.field] === "string" ? String(values[q.spec.field]) : JSON.stringify(values?.[q.spec.field], null, 2)}</div><button className="text-button" disabled={busy} onClick={() => run(() => cmd({ type: "reopen-question", question: question.id, expected: question.revision }), "Вопрос открыт для пересмотра")}>Пересмотреть ответ</button></>
      : q.spec.kind === "design" ? null
      : <form onSubmit={event => { event.preventDefault(); void run(() => q.spec.kind === "decision"
        ? cmd({ type: "answer-decision", question: question.id, expected: question.revision, value: parseValue() })
        : cmd({ type: "answer-fact", question: question.id, expected: question.revision, source: ref(source!), selector: source!.value.mediaType === "application/json" ? { kind: "json-pointer", pointer } : { kind: "text-range", start: 0, end: source!.value.content.length } }), "Ответ сохранён с основанием"); }}>
        {q.spec.kind === "decision" ? <Field label={schema.type === "array" && schema.items?.type === "string" ? "По одному пункту на строку" : schema.type === "array" || schema.type === "object" ? "Структурированный ответ (JSON)" : "Ваше решение"}><textarea required rows={3} value={answer} onChange={e => setAnswer(e.target.value)}/></Field>
          : <><Field label="Источник"><select required value={sourceId} onChange={e => setSourceId(e.target.value)}><option value="">Выберите источник</option>{view.sources.map(item => <option key={item.id} value={item.id}>{item.value.origin.location} · v{item.revision}</option>)}</select></Field>{source?.value.mediaType === "application/json" && <Field label="Путь к значению JSON, например /name (пусто — весь документ)"><input value={pointer} onChange={e => setPointer(e.target.value)}/></Field>}{!view.sources.length && <p className="muted">Добавьте материал в разделе «Источники».</p>}</>}
        <button disabled={busy || (q.spec.kind === "fact" ? !source : !answer.trim())}>{q.spec.kind === "fact" ? "Проверить по источнику" : "Принять решение"}</button>
      </form>}
  </article>;
}

function RefinementPanel({ view, cmd, run, busy }: { view: View; cmd: Cmd; run: Run; busy: boolean }) {
  const project = view.project.value.id;
  const currentR3 = view.feasibility?.value.ready === true && view.feasibilityGate?.findings.length === 0;
  return <div><p className="muted">Каждый уровень уточняет ту же карту. R3 проверяет репозиторий и среду до компиляции задач.</p><div className="phase-grid">{view.phases.map(item => <div className="phase" key={item.phase}><strong>{item.phase}</strong><Badge state={item.record ? item.gate.findings.length ? "stale" : "accepted" : "missing"}/>
    {item.phase.startsWith("R") ? <button className="secondary" disabled={busy} onClick={() => run(() => cmd({ type: "begin-research", project, level: item.phase }), "Исследование открыто")}>Открыть вопросы</button> : <button className="secondary" disabled={busy} onClick={() => run(() => cmd({ type: "seal-layer", project, level: Number(item.phase.slice(1)), expected: item.record?.revision ?? 0 }), "Уровень зафиксирован")}>Зафиксировать уровень</button>}</div>)}</div>
    {view.drafts.filter(d => d.value.stage === "om-g2").map(draft => <div key={draft.id} className="research-group"><h3>{draft.value.level}</h3>{draft.value.questions.map(id => { const q = view.questions.find(item => item.id === id); return q ? <QuestionPanel key={`${id}:${q.revision}`} question={q} view={view} cmd={cmd} run={run} busy={busy}/> : null; })}<button disabled={busy} onClick={() => run(() => cmd({ type: "finish-research", project, level: draft.value.level, draft: ref(draft), expected: view.phases.find(p => p.phase === draft.value.level)?.record?.revision ?? 0 }), "Исследование завершено")}>Завершить {draft.value.level}</button></div>)}
    <div className="action-row"><button disabled={busy || !view.environment} onClick={() => run(() => cmd({ type: "assess", project, expected: view.feasibility?.revision ?? 0 }), "Проверка R3 выполнена")}>Проверить R3</button>{!view.environment && <span className="muted">Сначала выберите рабочую папку и роли.</span>}</div>
    {view.feasibility && <div className="findings"><h3>R3: {currentR3 ? "проверка пройдена" : "требует внимания"}</h3>{[...view.feasibility.value.findings, ...(view.feasibilityGate?.findings ?? [])].map((f,i) => <p key={i}>{f.message} · {f.target}</p>)}<button disabled={busy || !currentR3} onClick={() => run(() => cmd({ type: "draft-om", project, feasibility: ref(view.feasibility!), expected: view.stages.find(s => s.stage === "om-g2")!.artifact?.revision ?? 0 }), "Результат OM-G2 собран")}>Собрать результат OM-G2</button></div>}
  </div>;
}

function GraphPanel({ view, cmd, run, busy }: { view: View; cmd: Cmd; run: Run; busy: boolean }) {
  const graph = view.graph?.value; const [level, setLevel] = useState(1); const [editing, setEditing] = useState(false);
  const [json, setJson] = useState(""); const [selected, setSelected] = useState(""); const [title, setTitle] = useState("");
  const kinds = ["product", "block", "operation", "work"];
  return <section><div className="section-heading"><div><h2>Одна карта, три уровня</h2><p className="muted">{graph ? `${graph.nodes.length} узлов · ${graph.connectors.length} коннекторов · версия ${view.graph!.revision}` : "Карту можно построить из исследования стадии или импортировать."}</p></div><button className="secondary" onClick={() => { setJson(graph ? JSON.stringify(graph, null, 2) : ""); setEditing(true); }}>{graph ? "Редактор структуры" : "Импорт карты"}</button></div>
    <div className="segmented" aria-label="Уровень карты">{[1,2,3].map(item => <button key={item} aria-pressed={level === item} className={level === item ? "selected" : ""} onClick={() => setLevel(item)}>L{item}</button>)}</div>
    {graph ? <div className="map-layout"><div className="map-nodes">{graph.nodes.filter(node => node.kind === kinds[level]).map(node => <button key={node.id} className={`map-node ${selected === node.id ? "selected" : ""}`} onClick={() => { setSelected(node.id); setTitle(node.title); }}><span className="eyebrow">{node.kind.toUpperCase()}</span><strong>{node.title}</strong><small>{node.outcome}</small><span>{graph.horizon.includes(node.id) ? "В текущем горизонте" : ""}</span></button>)}{!graph.nodes.some(n => n.kind === kinds[level]) && <div className="empty-inline">Этот уровень ещё не детализирован.</div>}</div>
      <aside className="inspector"><h3>{selected ? "Выбранный узел" : "Связи"}</h3>{selected && <form onSubmit={e => { e.preventDefault(); const next = structuredClone(graph); next.nodes.find(n => n.id === selected)!.title = title; void run(() => cmd({ type: "save-graph", project: view.project.value.id, graph: next, expected: view.graph!.revision })); }}><Field label="Название"><input value={title} onChange={e => setTitle(e.target.value)} required/></Field><button disabled={busy}>Сохранить узел</button></form>}{graph.connectors.map(connector => connector.bindings.filter(binding => binding.level === level).map((binding,i) => <div className="connection" key={`${connector.id}:${i}`}><strong>{graph.nodes.find(n => n.id === binding.producer.node)?.title}</strong><span>↓ {connector.artifact}</span>{binding.consumers.map(c => <strong key={c.node}>{graph.nodes.find(n => n.id === c.node)?.title}</strong>)}</div>))}</aside>
    </div> : <div className="empty-inline">Перейдите к стадии «Операционная карта», ответьте на вопросы и нажмите «Построить карту из пути».</div>}
    {view.graphGate.findings.length > 0 && graph && <div className="findings">{view.graphGate.findings.map((f,i) => <p key={i}>{f.message} · {f.target}</p>)}</div>}
    {editing && <Modal title="Структура операционной карты" close={() => setEditing(false)}><p className="muted">Движок проверит ссылки, контракты и границы. Принятые версии останутся в истории.</p><Field label="Карта JSON"><textarea className="code-editor" rows={18} value={json} onChange={e => setJson(e.target.value)}/></Field><footer><button className="secondary" onClick={() => setEditing(false)}>Отмена</button><button disabled={busy} onClick={() => run(async () => { await cmd({ type: "save-graph", project: view.project.value.id, expected: view.graph?.revision ?? 0, graph: JSON.parse(json) as Graph }); setEditing(false); })}>Проверить и сохранить</button></footer></Modal>}
  </section>;
}

function Sources({ view, cmd, run, busy }: { view: View; cmd: Cmd; run: Run; busy: boolean }) {
  const [name, setName] = useState("brief"); const [text, setText] = useState(""); const [media, setMedia] = useState("text/plain"); const [path, setPath] = useState("README.md");
  const existing = view.sources.find(source => source.id === `source:${view.project.value.id}:${name}`);
  return <section><h2>Источники и версии</h2><p className="muted">Изменение источника сохраняет старую версию и помечает зависимые результаты для пересмотра.</p><div className="two-columns"><div><Field label="Идентификатор источника"><input value={name} onChange={e => setName(e.target.value)} pattern="[A-Za-z0-9][A-Za-z0-9._-]*"/></Field><Field label="Формат"><select value={media} onChange={e => setMedia(e.target.value)}><option value="text/plain">Текст</option><option value="application/json">JSON</option></select></Field><Field label="Исходное поручение или документ"><textarea rows={8} value={text} onChange={e => setText(e.target.value)}/></Field><button disabled={busy || !text.trim()} onClick={() => run(() => cmd({ type: "source-document", project: view.project.value.id, id: name, text, media, expected: existing?.revision ?? 0 }))}>{existing ? "Сохранить новую версию" : "Добавить документ"}</button>
      <div className="divider"/><h3>Файл из рабочей папки</h3><Field label="Относительный путь"><input value={path} onChange={e => setPath(e.target.value)}/></Field><button className="secondary" disabled={busy || !view.environment} onClick={() => run(() => cmd({ type: "source-file", project: view.project.value.id, id: name, path, media, expected: existing?.revision ?? 0 }))}>Прочитать файл</button></div>
      <div>{view.sources.length === 0 ? <p className="empty-inline">Источников пока нет.</p> : view.sources.map(source => <details className="source" key={source.id}><summary><strong>{source.value.origin.location}</strong><Badge state={`v${source.revision}`}/></summary><p className="muted">{source.value.origin.kind === "file" ? "Файл рабочей папки" : "Документ владельца"}</p><pre>{source.value.content}</pre><small className="hash">{source.value.sha256}</small></details>)}</div></div></section>;
}

function FolderPicker({ close, choose }: { close: () => void; choose: (path: string) => void }) {
  const [listing, setListing] = useState<{ path: string; parent: string; directories: { name: string; path: string }[] } | null>(null); const [error, setError] = useState("");
  const load = (path?: string) => api<typeof listing>(`directories${path ? `?path=${encodeURIComponent(path)}` : ""}`).then(setListing).catch(error => setError(error.message));
  useEffect(() => { void load(); }, []);
  return <Modal title="Рабочая папка проекта" close={close}>{error && <p role="alert">{error}</p>}{listing ? <><div className="folder-location"><button className="secondary" onClick={() => load(listing.parent)}>↑</button><span>{listing.path}</span></div><div className="folder-list">{listing.directories.map(folder => <button className="folder" key={folder.path} onClick={() => load(folder.path)}>▱ {folder.name}</button>)}{listing.directories.length === 0 && <p className="muted">Вложенных папок нет.</p>}</div><footer><button onClick={() => choose(listing.path)}>Выбрать эту папку</button></footer></> : <p role="status">Чтение папок…</p>}</Modal>;
}

function Settings({ view, providers, cmd, run, busy }: { view: View; providers: Provider[]; cmd: Cmd; run: Run; busy: boolean }) {
  const initial = view.environment?.value; const provider = providers[0]; const defaultModel = provider?.models[0]?.id ?? "";
  const [workspace, setWorkspace] = useState(initial?.workspace ?? ""); const [folders, setFolders] = useState(false);
  const [worker, setWorker] = useState(initial?.implementer.model ?? defaultModel); const [reviewer, setReviewer] = useState(initial?.reviewer.model ?? defaultModel);
  const [workerEffort, setWorkerEffort] = useState(initial?.implementer.effort ?? "high"); const [reviewEffort, setReviewEffort] = useState(initial?.reviewer.effort ?? "high");
  const [check, setCheck] = useState(initial?.fullCheck.executable ?? "npm"); const [args, setArgs] = useState(JSON.stringify(initial?.fullCheck.args ?? ["test"]));
  const [custom, setCustom] = useState(JSON.stringify(initial ? { implementer: initial.implementer.command, reviewer: initial.reviewer.command } : null, null, 2));
  const sameCommand = (left: { executable: string; args: string[] } | undefined, right: { executable: string; args: string[] } | undefined) => Boolean(left && right && left.executable === right.executable && JSON.stringify(left.args) === JSON.stringify(right.args));
  const [advanced, setAdvanced] = useState(Boolean(initial && (!sameCommand(initial.implementer.command, provider?.command) || !sameCommand(initial.reviewer.command, provider?.command))));
  const modelField = (label: string, value: string, update: (value: string) => void) => <Field label={label}><input list="models" required value={value} onChange={e => update(e.target.value)} placeholder="Идентификатор модели"/></Field>;
  const effortField = (value: string, update: (value: string) => void) => <Field label="Усилие"><select value={value} onChange={e => update(e.target.value)}>{["low","medium","high","xhigh","max","ultra"].map(level => <option key={level}>{level}</option>)}</select></Field>;
  return <section><h2>Среда и роли</h2><p className="muted">Выбор сохраняется в движке. Смена совместимой модели сохраняет устройство карты и стадий.</p><form onSubmit={e => { e.preventDefault(); void run(() => {
    const commands = advanced ? JSON.parse(custom) : { implementer: provider?.command, reviewer: provider?.command };
    const environment: Omit<Environment, "projectId"> = { workspace,
      implementer: { actor: initial?.implementer.actor ?? "implementation-worker", model: worker, effort: workerEffort, command: commands.implementer },
      reviewer: { actor: initial?.reviewer.actor ?? "independent-reviewer", model: reviewer, effort: reviewEffort, command: commands.reviewer }, fullCheck: { executable: check, args: JSON.parse(args) }, timeoutMs: initial?.timeoutMs ?? 600_000 };
    return cmd({ type: "configure", project: view.project.value.id, expected: view.environment?.revision ?? 0, environment });
  }); }}><Field label="Корень Git-репозитория"><div className="input-action"><input required value={workspace} onChange={e => setWorkspace(e.target.value)} placeholder="Выберите рабочую папку"/><button type="button" className="secondary" onClick={() => setFolders(true)}>Выбрать папку</button></div></Field>
    <div className="provider-status">{provider?.available ? "● Codex CLI доступен" : "Codex CLI не найден. Можно подключить собственный адаптер."}</div><datalist id="models">{provider?.models.map(model => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
    <div className="two-columns"><fieldset><legend>Исполнитель</legend>{modelField("Модель", worker, setWorker)}{effortField(workerEffort, setWorkerEffort)}</fieldset><fieldset><legend>Независимый ревьюер</legend>{modelField("Модель", reviewer, setReviewer)}{effortField(reviewEffort, setReviewEffort)}</fieldset></div>
    <div className="two-columns"><Field label="Команда полной проверки"><input value={check} onChange={e => setCheck(e.target.value)} required/></Field><Field label="Аргументы команды (JSON-массив)"><input value={args} onChange={e => setArgs(e.target.value)} required/></Field></div>
    <label className="checkbox"><input type="checkbox" checked={advanced} onChange={e => setAdvanced(e.target.checked)}/>Собственный адаптер по протоколу OMG</label>{advanced && <Field label="Команды implementer и reviewer"><textarea className="code-editor" rows={7} value={custom} onChange={e => setCustom(e.target.value)}/></Field>}
    <button disabled={busy || (!advanced && !provider?.available)}>Сохранить среду и роли</button></form>{folders && <FolderPicker close={() => setFolders(false)} choose={path => { setWorkspace(path); setFolders(false); }}/>}</section>;
}

function ChatPanel({ view, run, busy }: { view: View; run: Run; busy: boolean }) {
  const [message, setMessage] = useState(""); const [sending, setSending] = useState(false);
  const send = async () => {
    setSending(true);
    try {
      const result = await api<{ value: { status: string; error: string | null } }>("chat", { project: view.project.value.id, message });
      if (result.value.status === "failed") throw new Error(`Ответ модели не получен: ${result.value.error}`);
      setMessage(""); await run(async () => {}, `Ответ получен: ${view.project.value.title}`);
    } catch (error) { await run(async () => { throw error; }); }
    finally { setSending(false); }
  };
  return <section><h2>Чат о продукте</h2><p className="muted">{view.environment ? `Модель: ${view.environment.value.implementer.model}. Чат использует выбранного исполнителя в режиме чтения.` : "Выберите среду и модель в разделе «Среда и роли»."}</p><div className="chat-history">{view.chat.length === 0 && <div className="empty-inline">Обсудите требования, карту или причину закрытого перехода.</div>}{view.chat.map(turn => <div className="chat-turn" key={turn.id}><div className="bubble user"><small>Вы</small>{turn.value.message}</div><div className={`bubble assistant ${turn.value.status === "failed" ? "failed" : ""}`}><small>{turn.value.model}</small>{turn.value.status === "completed" ? turn.value.text : turn.value.status === "running" ? "Ожидание ответа…" : `Ответ не получен: ${turn.value.error}`}</div></div>)}</div>{sending && <p role="status" className="muted">Модель готовит ответ. Остальные разделы доступны.</p>}<form className="chat-composer" onSubmit={e => { e.preventDefault(); void send(); }}><Field label="Сообщение"><textarea rows={3} value={message} onChange={e => setMessage(e.target.value)} placeholder="Например: какие вопросы ещё мешают перейти к следующей стадии?"/></Field><button disabled={busy || sending || !view.environment || !message.trim()}>Отправить выбранной модели</button></form></section>;
}

/** H2.0: owner authority is a separate session (invitation → HttpOnly cookie on /api/owner) — the product token never answers owner questions. */
function OwnerPanel({ view, run, busy }: { view: View; run: Run; busy: boolean }) {
  const project = view.project.value.id;
  const [invitation, setInvitation] = useState(""); const [session, setSession] = useState<{ session: { id: string }; expiresAt: number } | null>(null);
  const listed = view.ownerQuestions; const items = listed && listed.ok ? listed.value : [];
  const pending = items.filter(item => !item.answered);
  return <section className="stage-panel owner-panel"><div className="section-heading"><div><div className="eyebrow">РЕШЕНИЯ ВЛАДЕЛЬЦА</div><h2>Вопросы операционной карты</h2></div>{session && <Badge state="open"/>}</div>
    {listed && !listed.ok && <p className="muted">Список вопросов владельца недоступен: {listed.refusal.message}</p>}
    {!session ? <>
      <p className="muted">Ответы на вопросы маршрута «владелец» подписываются отдельной сессией. Выпустите приглашение командой <code>npm start -- owner-invite .omg/state.sqlite {project}</code> и введите показанный секрет — он виден один раз.</p>
      <form onSubmit={e => { e.preventDefault(); void run(async () => { setSession(await api("owner/session", { project, invitation })); setInvitation(""); }, "Сессия владельца открыта на 30 минут"); }}>
        <Field label="Одноразовое приглашение"><input required value={invitation} onChange={e => setInvitation(e.target.value)} autoComplete="off"/></Field>
        <button disabled={busy || !invitation.trim()}>Войти как владелец</button></form></> : <>
      <p className="muted">Сессия владельца <code>{session.session.id.slice(0, 40)}…</code> действует до {new Date(session.expiresAt).toLocaleTimeString()} без продления.</p>
      {pending.length === 0 && <p className="empty-inline">Нет вопросов, ожидающих решения владельца.</p>}
      {pending.map(item => <OwnerAnswerForm key={item.address} item={item} project={project} run={run} busy={busy}/>)}
      {items.filter(item => item.answered).map(item => <article className="question" key={item.address}><div className="question-top"><span className="eyebrow">РЕШЕНИЕ ВЛАДЕЛЬЦА</span><Badge state="answered"/></div><h3>{item.question.question.text}</h3><p className="muted">Ответ зафиксирован записью {item.answered!.id} rev.{item.answered!.revision}.</p></article>)}
      <div className="action-row"><button className="secondary" disabled={busy} onClick={() => run(async () => { await api("owner/logout", {}); setSession(null); }, "Сессия владельца закрыта")}>Выйти из сессии владельца</button></div></>}
  </section>;
}

function OwnerAnswerForm({ item, project, run, busy }: { item: OwnerQuestionItem; project: string; run: Run; busy: boolean }) {
  const [value, setValue] = useState(""); const [basis, setBasis] = useState("");
  const parseValue = () => { try { return JSON.parse(value); } catch { return value; } };
  return <article className="question"><div className="question-top"><span className="eyebrow">РЕШЕНИЕ ВЛАДЕЛЬЦА · {item.question.route.field}</span><Badge state="open"/></div>
    <h3>{item.question.question.text}</h3><p className="muted">Вопрос {item.question.question.id} · пробел {item.question.route.gap} · поле {item.question.route.target}</p>
    <form onSubmit={e => { e.preventDefault(); void run(() => api("owner/decision", { project, routes: item.question.routes, gap: item.question.gap, value: parseValue(), basis }), "Решение владельца записано"); }}>
      <Field label="Ваше решение (JSON — для структурного значения)"><textarea required rows={3} value={value} onChange={e => setValue(e.target.value)}/></Field>
      <Field label="Основание решения"><textarea required rows={2} value={basis} onChange={e => setBasis(e.target.value)}/></Field>
      <button disabled={busy || !value.trim() || !basis.trim()}>Записать решение владельца</button></form></article>;
}

createRoot(document.getElementById("root")!).render(<App/>);
