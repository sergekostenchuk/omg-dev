# Требования для входа в стадию OM (карта) из предыдущих стадий

Источник: набор kept/dropped из проверки по worktree `v3-runner-cost-step2` (read-only). Пути ниже — относительно корня worktree. Сокращения: OM=`packages/plan-compiler/operation-map-g2.mjs`, OM2=`…/operation-map-g2-v2.mjs`, OM3=`…/operation-map-g2-v3.mjs`, EG3=`…/execution-graph-g2-v3.mjs`, RF=`…/refinement-g2-v1.mjs`, CLI=`…/g2-cli.mjs`, S1=`contracts/operation-map-g2.schema.json`, S2=`contracts/operation-map-g2.v2.schema.json`, SSS=`contracts/operation-map-source-set-g2.v3.schema.json`, RQS=`contracts/research-question-set-g2.v1.schema.json`, RAS=`contracts/research-answer-set-g2.v1.schema.json`, R3S=`contracts/r3-feasibility-result-g2.v1.schema.json`, C=`OM-NEW-CONTEXT/NEW-CONCEPTION-OM.md`, MAP=`OM-NEW-CONTEXT/OPERATION-MAP-G2.json`.

## 0. Что владельцу важно знать сразу

- В концепции (C §6, строки 263-284) стадии называются только B04 → R0 → L1(B05) → R1 → L2(B06) → R2 → L3(B07/B08) → R3 → «TASK-PLAN + Operation Graph Compiler». Слов «discovery», «specification», «feature_preparation», «task_plan_builder», «operational_map_itself» в C нет (grep 0). Ниже группы названы по заданию владельца, реальная стадия указана в скобках.
- Проверено сейчас (python по MAP): evidence_refs — 40 записей, kinds {concept, operation_map, product_test, task_plan}; для двух из семи обязательных v1-путей записей НЕТ: `OM-NEW-CONTEXT/BOOTSTRAP-OPERATION-BINDING.json` и `packages/plan-compiler/test/validate-operation-map-g2-cli.test.mjs`. По правилу OM:250-256 это `evidence_ref_unknown`. Одновременно v1-схема допускает kind `operation_binding` (S1:460-463), а v3-код его не знает (OM3:188-189) — расхождение не сведено.
- ports никогда не авторились: у всех 192 узлов `ports=[]`, ни один endpoint не задаёт port_ref (проверка ports-never-authored); инвариант L2 «каждый L1 connector уточнён до port» (C §10) не выполнен.
- Из кодов §18 (C:1441-1503) ~19 нигде в `packages/plan-compiler` не реализованы (см. Опровергнуто → validator-implemented-vs-concept-codes).
- Большинство «опровергнутых» пунктов опровергнуты только по ярлыку стадии-производителя; сам механизм там подтверждён построчно — это отмечено тегом [АТР].

Формат строки: **Сдать** | **Отказ** | **Улики**.

---

## 1. Концепция (B04 Accepted Product Concept)

### Все уровни

1.1 **Документ концепции с запечатанными байтами.** Файл `OM-NEW-CONTEXT/NEW-CONCEPTION-OM.md`, sha256 записан в evidence_refs как `EVIDENCE-OMG2-CONCEPT` (kind concept, status accepted); карта несёт `concept_ref{path, sha256, sections}`, sha равен evidence. R0 не переприниает смысл, а нормализует.
| Отказ: `concept_ref_unknown` ($concept_ref, concept_matches_evidence) → concept_owner; `evidence_ref_unknown`/`source_drift` → evidence_owner.
| Улики: OM:258 (сверка concept_ref.sha256 с EVIDENCE-OMG2-CONCEPT); OM3:184-186 «evidenceByPath.get(graph.concept_ref?.path) … "concept_ref_unknown"»; C:266 «B04 Accepted Product Concept»; C:300 «Нормализовать принятый Product Concept … без повторного принятия смысла»; C:337 «1. accepted Product Concept;»; C:1027 «"concept_ref": {}»; C:1324 «graph/concept/research refs;»; C:1445 «concept_ref_unknown».

1.2 **Адресуемые секции C01..C34.** `concept_ref.sections` — ровно 34 элемента {id `^C(0[1-9]|[12][0-9]|3[0-4])$`, number 1..34, title непустой}; каждый `node.implements[]` ⊆ этих id. Явной фразы «id секций стабильны» в C нет — вывод из формата поля и инварианта L1 «каждая секция покрыта либо имеет exemption» (C §8).
| Отказ: `schema_invalid` (S2:134-135 minItems/maxItems 34; S2:120 pattern); `concept_ref_unknown` (node, implements_ref_resolves) → concept_owner.
| Улики: OM:247 (sectionIds из concept_ref.sections); OM:264 «for (const ref of node.implements ?? []) if (!sectionIds.has(ref)) … "implements_ref_resolves"» (проверено grep); OM3:211,219; S2:118-136; C:1077 «"implements": ["concept-section-id"]».

### L1

1.3 **Обещание восстановления.** Концепт/R0 фиксируют: обещает ли продукт восстановление и кто выполняет recovery — иначе инвариант L1 неразрешим.
| Отказ: код не назван; ближайший §18 `recovery_carrier_missing` (C:1466).
| Улики: C:387 «recovery path существует, если продукт обещает восстановление;»; C:307 «- Кто выполняет recovery?».

---

## 2. Дискавери — факты исследований (реальные стадии R0 / R1 / R2)

### R0 → L1

2.1 **Существующий продукт при migration/redesign** (источник 5 R0) либо зафиксированная причина неприменимости — иначе journey «migration/backward compatibility» непроверяем.
| Отказ: код не назван.
| Улики: C:341 «5. существующий продукт при migration/redesign.»; C:328 «- migration/backward compatibility;»; C:333 «Неприменимость фиксируется причиной…».

### R1 → L2

2.2 **Инвентарь границ:** authority, durable state, logical writers, rollback-единицы — для `boundaries{authority_ref, durable_state_ref, writer_ref, rollback_ref}` узлов; writer_ref = logical sole writer (не файл/агент/worktree); AU не агрегирует конфликтующие boundaries. Производит R1 (§9, «Authority/Writer Map»).
| Отказ: `acceptance_authority_conflict`, `acceptance_durable_boundary_conflict`, `acceptance_rollback_conflict`, `writer_conflict` (C:1477-1478); R3 `authority_boundary_missing`, `rollback_boundary_missing` (R3S:320-321).
| Улики: C:225-226 «Exclusive authority… не агент и не файл»; C:1305-1310; C:1313-1316 «Acceptance Unit не может агрегировать conflicting boundaries. writer_ref всегда указывает logical sole writer…»; C:1334.

2.3 **Неизвестный факт → вопрос в R2, не догадка** (инвариант L2).
| Отказ: инвариант C:649; «inference не становится фактом» C:994.
| Улики: C:649 «неизвестный факт отправлен в R2, а не заполнен догадкой.»; C:653 «- R2 question generator;»; C:985-994 (алгоритм вопроса).

### R2 → L3

2.4 **Точные code-факты активной вертикали:** `code_refs[] {path (относительный, без ..), access read|write, symbol?, status present|proposed}` для каждого l3_root (≥1); `endpoint.code_ref` совпадает с code_refs узла по path (+symbol). Валидатор существование path на диске НЕ проверяет — факт «какой код и кто пишет» добывает R2 (§11), записывается на L3 (§12 шаг 4, C:~785). Текущая карта: 1161 записей (write 1148 / read 13; present 59 / proposed 1102), `symbol` не авторился ни разу.
| Отказ: `active_l3_code_ref_missing` (endpoint_code_ref_resolves OM:282; l3_root_has_code_scope OM:465; OM3:421 current_unit_executable_and_test_bound) → l3_integration_owner; `path_missing`/`symbol_missing` из §18 в валидаторе НЕ реализованы.
| Улики: OM:282; OM:465; S1:199-209 «codeRef required [path, access]; access enum [read, write]; status enum [present, proposed]»; MAP /nodes/5/code_refs/0; MAP /nodes/11/code_refs/0 «"path": "contracts/operation-map-g2.schema.json", "status": "present"».

### Кросс-уровневый механизм вопросов/ответов (R0–R3)

2.5 **Вопрос создаётся только на невыводимый gap:** validator следующего уровня находит gap → compiler проверяет выводимость → если выводимо, вопроса нет; форма — 11 полей (question_id, research_stage, target_ref, required_field, question, risk_or_invariant, expected_result, decision_unlocked, source_kind ∈ {accepted_product_decision, repository_evidence, runtime_evidence, external_primary_docs, user_research, owner_decision}, evidence_requirement, consumer_ref); без consumer — не создаётся. Конфликт источников: accepted product decision задаёт смысл; production source — реализацию; расхождение = implementation gap; test без live production path не доказывает; WIP не evidence; external docs по версии; inference маркирован.
| Отказ: `derived_field_conflict` при ручном выводимом поле (C:1371); Field-reader principle (C:1375).
| Улики: C:985-987 «1. Validator следующего уровня обнаруживает gap. 2. Compiler проверяет, нельзя ли поле вывести. 3. Если можно — вопрос не создаётся.»; C:959-969; C:988 «4. Иначе создаётся typed question с consumer.»; C:975; C:1001-1006.

2.6 **Форма вопроса в инструменте** (`derive-research-questions-v3`): stdin — канонический JSON {schema_version "task-plan-pro.research-question-derivation-input-g2/v1", diagnostic_envelope_bytes_base64, planning_execution_graph_bytes_base64}; envelope {diagnostics[], schema_version "…operation-map-diagnostic-g2/v1", status "invalid"}; диагностика — ровно {code research_gap_R0..R3, evidence (JSON pointer в target, не производное поле: /id, корневые contract_catalog_ref/graph_id/graph_revision/predecessor_ref/schema_version), invariant, returns_to (узел), target (объект карты)}; один вопрос на target+field.
| Отказ: `join_input_foreign` (closed_typed_derivation_join | canonical_standard_diagnostic_envelope | closed_research_diagnostic), `schema_invalid` (typed_research_gap_R0_to_R3), `unknown_ref`, `consumer_missing`, `duplicate_id` (one_question_per_target_field).
| Улики: CLI:489-493; RF:641-642; RF:238-252 «/^research_gap_(R[0-3])$/u»; RF:44-52 «DERIVED_ROOT_FIELDS … SOURCE_KIND_BY_STAGE R0: owner_decision, R1: accepted_product_decision, R2: repository_evidence, R3: runtime_evidence».

2.7 **Ответ (answer set, вход `compile-refinement-v3`):** self-hash `answer_set_id = "research-answer-set-g2-v1:sha256:"+answer_set_sha256`; `canonical_question_set_bytes_base64` (внутри canonical_planning_bytes_base64); `question_set_ref == {question_set_id, question_set_sha256}` встроенного набора; `evidence[] {evidence_ref уникален, source_kind, sha256, repository_ref}` — для repository_evidence полный {path, commit_oid == expectedParent, tree_oid == дерево parent, object_type "blob", git_object_id == blob-oid байт, sha256 == sha байт == item.sha256}, для остальных `null`; каждое evidence потребляется ответом; `answers[] {question_id ∈ questions, уникален, status answered|unresolved|conflicting, evidence_refs[]}`: answered → value и ≥1 evidence; unresolved/conflicting → без value; conflicting → ≥2 evidence. Стадии смешанные R0–R3 (repository_evidence — вопросы R2).
| Отказ: `join_input_foreign` (answer_set_self_hash_exact | embedded_question_set_ref_exact | answer_question_resolves_in_exact_set), `source_drift`, `duplicate_id`, `research_evidence_foreign` (repository_evidence_exact_parent_tree_blob_sha | nonrepository_evidence_has_no_repository_authority | every_evidence_record_is_consumed_by_an_answer | *_has_no_accepted_value), `research_evidence_insufficient`, `schema_invalid`; JSON Schema oneOf.
| Улики: RF:297-305; RF:323-327 «ref.commit_oid !== input.expectedParent || ref.tree_oid !== tree || ref.object_type !== "blob" …»; RF:342-345; RF:350-352; CLI:802; RAS:105-108 «required [question_id, status, evidence_refs] … enum [answered, unresolved, conflicting]»; RAS:117-134.

2.8 **Применение ответа к карте:** source_kind каждого evidence == source_kind вопроса; target и pointer существуют в исходной карте и в successor; ни target, ни родитель/значение, ни value не содержат `ANCHOR-OMG2-R3-FEASIBILITY`; новое значение отличается от старого; между target_ref и consumer_ref есть прямое ребро или общий коннектор, сохраняющийся после правки; HEAD == expectedParent и дерево неизменно после чтения evidence.
| Отказ: `research_evidence_foreign` (evidence_source_kind_matches_question), `join_input_stale` (target_and_pointer_unchanged_since_question_issue; $expected_parent parent_stable_through_evidence_read), `anchor_activation_forbidden`, `research_evidence_insufficient` (answered_refinement_changes_target_value), `consumer_missing`.
| Улики: RF:533-534; RF:540-541; RF:544-545 «question.target_ref === R3_ANCHOR || containsAnchor(…)»; RF:550-554; RF:568-570; RF:514-515.

---

## 3. Владелец (решения/подписи)

3.1 **Owner decisions — второй источник R0**, и только для human-owned meaning, authority/security/data changes, plan deviation, irreversible action, spending, secrets/access. Вопрос без решения остаётся unresolved → R3 `unresolved_research`.
| Улики: C:338 «2. owner decisions;»; C:996 «Owner decision требуется только для human-owned meaning, authority/security/data changes, plan…»; C:994; C:918.

3.2 **Пороги профиля дистанции** (`warning_threshold`, `active_l3_error_threshold`) — единственные свободные числа профиля; канон концепции 1/1 (bootstrap-инвариант «active L3 consumer в той же или следующей direct unit»), решение ратифицировано вместе с концепцией (P-011). Отдельной подписи под картой не требуется; отклонение от 1 — новое решение с обоснованием. Полное описание поля — п. 4.18.
| Улики: C:1186,1189 (warning_threshold 1 / active_l3_error_threshold 1); C:570,573; C:580 «active L3 consumer должен быть в той же или следующей direct unit.»; C:2186 (P-011); C:1330 «- integration-distance profiles;» (авторское).

3.3 **Политика ревью** — один глобальный `review_policy_ref`, разрешаемый в `catalog.review_policies[]`; каждая политика — ровно ключи {id, schema_version, reviewer_independence_rule (строки), default_finding_routes (record с CODE_DEFECT, PLAN_DEFECT), finding_class_vocabulary ⊇ CODE_DEFECT, review_admission_vocabulary ⊇ READY, review_verdict_vocabulary ⊇ PASS, forbidden_process_ceremony[]}. ReviewManifest и ReviewSubject-требования — вычисляемые. В kept стадия названа «owner»/«specification» — в C такой стадии нет; в коде маршрут `review_policy_owner`.
| Отказ: `schema_invalid` ($.catalog.review_policies[i]); `review_policy_missing` (OM3:175); `review_contract_missing`, `review_manifest_incomplete`, `review_subject_binding_incomplete` (C:1502-1503).
| Улики: OM3:140 «["default_finding_routes", "finding_class_vocabulary", "forbidden_process_ceremony", "id", "review_admission_vocabulary", "review_verdict_vocabulary", "reviewer_independence_rule", "schema_version"]»; OM3:175 «policy.id === graph.review_policy_ref … "review_policy_missing"»; C:1041; C:1337 «one global review policy ref for non-derivable rules;»; C:1368; C:258-259.

---

## 4. Сама стадия карты — авторские поля (L1/B05, L2/B06, L3/B07-B08)

### Все уровни

4.1 **Идентичность графа:** `schema_version` ровно "task-plan-pro.operation-map-g2/v1" (v2-схема — "/v2"); `graph_id` по $defs.id `^[A-Za-z][A-Za-z0-9._:-]*(?:-[A-Za-z0-9._:-]+)*$`; `graph_revision` непустая. Уходят в handle `graph_ref` и сверяются с встроенными байтами.
| Отказ: `schema_invalid` ($.schema_version); v2 `join_input_foreign` (portable_graph_identity_exact).
| Улики: OM:241 «if (graph.schema_version !== OPERATION_MAP_G2_SCHEMA) … "schema_invalid", "$.schema_version"»; OM:500-505 (graph_ref); OM2:223-224; S1:87-91.

4.2 **predecessor_ref:** schema_version const "task-plan-pro.operation-map-predecessor-g2/v1", kind ∈ {genesis, operation_map}; genesis → ровно 2 ключа. Схема НЕ требует graph_id/graph_revision/graph_sha256 даже при operation_map (условного правила нет); v2 rolling требует kind=operation_map и graph_sha256 (строка); для successor graph_sha256 считает refinement механически.
| Отказ: `schema_invalid` (predecessor_schema_exact | genesis_has_no_graph_identity); v2 `stale_graph_hash` (rolling_graph_has_exact_predecessor).
| Улики: OM:242-243; OM2:275-277 «predecessor_ref?.kind !== "operation_map" || typeof predecessorSha !== "string"»; S1:103-114; S2:106-113 «required [kind, schema_version]»; RF:434-445.

4.3 **Граф проходит JSON-схему, найденную в каталоге по schema_version** (closed object, required, enum, pattern, minLength/minItems/maxItems/uniqueItems). Шаблон `path` в схеме карты слабее, чем в source-set/question/answer/refinement: обратный слеш и буква диска пройдут карту, но не source-set.
| Отказ: `schema_invalid` (validateSchemaG2V2), стоп OM3:169.
| Улики: OM3:168-169 «validateSchemaG2V2(graph, graphSchema, …); if (diagnostics.length) return null;»; OM2:85-115; S2:101 vs SSS:18.

4.4 **Каталог контрактов** (вход карты; стадия в C не названа; в коде — `contract_owner`): файл по `contract_catalog_ref.path` в source set, канонический JSON {schema_version "task-plan-pro.operation-map-contract-catalog-g2/v1", catalog_id, catalog_version "v1", entries[], review_policies[]}; entry {id, version, schema_ref, schema_sha256}, пара id/version уникальна, байты схемы по schema_ref (до `#`) есть, sha == schema_sha256; множество "id/version" — единственный источник `contract_ref` артефактов/коннекторов/якорей и `schema_version` join-контрактов/профилей; в графе `contract_catalog_ref{artifact_ref, catalog_id, catalog_version, path, sha256}` совпадает с каталогом.
| Отказ: `schema_invalid` ($catalog: exact_canonical_catalog_bytes | catalog_entries_and_policies_arrays); `contract_ref_missing` (catalog_schema_hash_exact | graph_declared_catalog_identity_exact | graph_schema_resolves_from_catalog); `duplicate_id` → contract_owner.
| Улики: OM:171-189; OM:479 «if (catalogText !== canonicalJsonBytesG2(catalog)) … "exact_canonical_catalog_bytes"»; OM3:134-136; OM3:141-143.

4.5 **evidence_refs:** {id, kind ∈ {concept, operation_map, task_plan, operation_binding, product_test}, path, sha256 hex64, status ∈ {accepted, active, sleeping}}; v1: записи для всех 7 путей `OPERATION_MAP_G2_SOURCE_PATHS` с sha реальных байт; обязательные id EVIDENCE-OMG2-CONCEPT, EVIDENCE-OMG2-MAP; kind=product_test — цели `positive_test_id`/`research_refs`; v3: path уникален, в source set запись с ролью "evidence" и тем же sha, kind ∈ {concept, operation_map, task_plan, product_test}. Файлы-источники должны быть заморожены до карты. Факт по MAP — см. п. 0.
| Отказ: `evidence_ref_unknown` (authoritative_source_evidence_present | known_evidence_kind), `source_drift` (authoritative_source_hash_exact | graph_evidence_hash_exact) → evidence_owner; `duplicate_id` (evidence_path_unique).
| Улики: OM:11-19 «OPERATION_MAP_G2_SOURCE_PATHS = … 7 путей»; OM:250-256; S1:460-463; OM3:179; OM3:182 «!source.roles.includes("evidence") || source.sha256 !== evidence.sha256 … "source_drift"»; OM3:188-189; C:1324.

4.6 **map_ref** {path == "OM-NEW-CONTEXT/Operation-Map-of-NEW-OM.md", sha256 == EVIDENCE-OMG2-MAP, map_id (id), map_revision (непустая)}.
| Отказ: `evidence_ref_unknown` ($.map_ref, map_identity_matches_evidence) → graph_author.
| Улики: OM:259; MAP /map_ref «"map_id": "OMG2-BOOTSTRAP-BUILD", "map_revision": "planning-b04-refinement-0.9.1", "path": "OM-NEW-CONTEXT/Operation-Map-of-NEW-OM.md"»; S1:143 (required).

4.7 **Узлы — иерархия и ссылки:** `parent_id` null только у l1_root (kind=product), иначе существующий узел; цепочка ациклична; каждый узел достижим до l1_root («ровно один корень» — следствие orphan_node, отдельной проверки нет). `outcome_ref` — null либо id узла/артефакта (наличие не проверяется; в MAP null у 2/5 акторов, 4/5 систем, gate, 3 операций OP-B07-AFFECTED-*, 3 WP WP-M11-027-*). `test_contract_refs[]` → product_test_contracts; `join_contract_refs[]` → join_contracts, и объявленный join обязан иметь consumer_ref == этот узел. Иерархия — только parent_id, без ручных contains-рёбер.
| Отказ: `parent_missing` (OM:262), `hierarchy_cycle` (OM:299-306), `orphan_node` (OM:305), `invalid_horizon_root` (OM:298), `unknown_ref` (OM:263), `product_test_contract_missing` (OM3:221), `join_contract_missing` (OM3:222).
| Улики: OM:262 «node.parent_id !== null && !index.nodes.has(node.parent_id) … "parent_missing"»; OM:299-306; OM:263; OM:266-267; OM:433-443; OM3:217-222; MAP /nodes/179/outcome_ref «null (WP-M11-027-RUNNER-COST)»; C:1300.

4.8 **boundaries каждого узла:** {authority_ref (id), durable_state_ref (string|null), state_classification ∈ {reconstructible_derived_bytes_no_durable_write, durable, external, not_applicable}, writer_ref (id), rollback_ref (id)}; для каждого ребра realizes boundaries AU-предка source (byte-equal канонический JSON) == boundaries target; резолв authority/writer/rollback не проверяется — только равенство. Авторится на L2 (§10 «Boundary и writer semantics»).
| Отказ: `schema_invalid` (S2:178-186); `acceptance_boundary_conflict` (realized_boundary_matches_unit); `work_packet_requires_independent_acceptance` (C:1479); R3 `authority_boundary_missing`/`rollback_boundary_missing`.
| Улики: S2:178-186 «required [authority_ref, durable_state_ref, state_classification, writer_ref, rollback_ref]»; OM3:342-344 «boundary(unit.boundaries) !== boundary(target.boundaries) … "acceptance_boundary_conflict"»; C:540-547; C:1313; R3S:320-321.

4.9 **ports:** {id, direction ∈ {in,out}, contract_ref непустой}; любой `endpoint.port_ref` обязан быть в ports узла. Факт: ports=[] у всех 192 узлов, port_ref не задан ни в одном endpoint (см. п. 0).
| Отказ: `connector_endpoint_missing` (endpoint_port_resolves).
| Улики: OM:281 «endpoint?.port_ref && !endpointNode?.ports?.some(…) … "connector_endpoint_missing"»; S1:192 «required [id, direction, contract_ref]»; C:1081; C §10 шаг 5.

4.10 **Validated handle — выход стадии карты**, который следующие стадии передают неизменным: v1 — ровно 7 ключей {schema_version, brand "validated-operation-map-g2", graph_ref, contract_catalog_ref, integration_profile_ref, validator {id "taskplan.operation-map-g2-validator", version "1.0.0"}, validated_handle_sha256}; v2 — 9 ключей (+canonical_graph_bytes_base64, current_horizon{l1_root, l2_roots, l3_roots, sha256}), brand "…-v2", версия "2.0.0"; compile-*-v3 принимают handle через stdin и пересчитывают от expected parent.
| Отказ: `join_input_foreign` (closed_v2_handle_shape | portable_graph_decodes | portable_graph_identity_exact | handle_recomputed_from_exact_parent | canonical_stdin_bytes), `join_input_stale` (horizon_matches_embedded_graph), `join_input_missing` (stdin_nonempty).
| Улики: OM:526-545 «exactKeys(handle, ["schema_version", "brand", "graph_ref", "contract_catalog_ref", "integration_profile_ref", "validator", "validated_handle_sha256"])»; OM2:197-203; OM2:232-235; CLI:461-466; EG3:702-704.

### L1 (B05, весь продукт)

4.11 **Выход L1, читаемый R1-генератором вопросов и L2-декомпозером:** блоки с input/output, sole producer, first consumer, success/failure-переходами, `returns_to`, стабильными connector/anchor ID; нет изолированных блоков; каждый non-terminal artifact имеет producer и consumer либо stable wake contract. L1 авторится без paths/symbols/test files/task ID.
| Отказ: `producer_missing`, `consumer_missing`, `orphan_node`, `connector_endpoint_missing` (C:1450-1456); `anchor_missing` (C:1471).
| Улики: C:378 «5. Определить input/output, sole producer, first consumer, success/failure transitions и returns_to.»; C:379 «6. Создать stable connector и anchor IDs.»; C:388; C:396 «- R1 question generator;».

4.12 **artifacts (≥1):** закрытый объект {id, kind (свободный словарь, $ref id; в MAP 52 уникальных из 54), purpose, contract_ref ∈ каталог, durability ∈ {durable_source, durable_draft, durable_versioned, versioned, immutable, reconstructible, evidence, recoverable, capability}, terminality ∈ {terminal, non_terminal}, external_source (строго boolean), sensitivity ∈ {public, project_internal, restricted}}; артефакт с external_source=false обязан иметь ≥1 коннектор с artifact_ref на него; обязателен ART-OMG2-CONTRACT-CATALOG.
| Отказ: `producer_missing` (OM:340), `external_source_unclassified` (OM:341), `contract_ref_missing` (OM:269), `schema_invalid` (enum).
| Улики: OM:340 «!artifact.external_source && !(artifactConnectors.get(artifact.id)?.length) … "producer_missing"»; S1:244,247; MAP /artifacts/0 «"contract_ref": "task-plan-pro.artifact-g2/v1", "durability": "durable_draft", "external_source": false, "kind": "operation_map"»; MAP /artifacts/1; MAP /artifacts/22.

4.13 **connectors (≥1):** закрытый {id, artifact_ref → artifact, contract_ref ∈ каталог, bindings[≥1], wake_test_contract_ref string|null, returns_to_ref → узел (куда возвращается отказ)}. Семантика артефакта/контракта не меняется между уровнями; смена семантики = новый id. В MAP: 59 коннекторов, 249 привязок (1–14 на коннектор), contract_ref всегда task-plan-pro.connector-g2/v1.
| Отказ: `unknown_ref` (artifact_ref_resolves), `contract_ref_missing` (connector_contract_resolves) → contract_owner, `failure_return_missing` (returns_to_ref_resolves).
| Улики: OM:270-273; S1:287 «required [id, artifact_ref, contract_ref, bindings, wake_test_contract_ref, returns_to_ref]»; OM3:293-295; C:1143-1145.

4.14 **Привязки коннектора:** {level ∈ {L1,L2,L3}, producer{node_ref, port_ref?, code_ref?}, consumers[≥1], activation{mode ∈ {immediate, at_anchor}, anchor_ref?}, test_contract_refs → PTC}; все node_ref резолвятся; при at_anchor — anchor_ref ∈ anchors И у коннектора wake_test_contract_ref ∈ tests И returns_to_ref («полный спящий контракт», проверяется на коннектор). В MAP: immediate 225 / at_anchor 24; 13 коннекторов с wake-ref ⇔ 13 с at_anchor; использованы 8 якорей из 10.
| Отказ: `schema_invalid` (known_refinement_level), `connector_endpoint_missing`, `consumer_missing`, `product_test_contract_missing` (binding_test_ref_resolves), `anchor_missing`, `future_dependency_unanchored`.
| Улики: OM:274-286; OM:336 «at_anchor && (!connector.wake_test_contract_ref || !index.tests.has(…) || !connector.returns_to_ref) … "future_dependency_unanchored"» (проверено grep); OM:314; S1:275; OM3:300-304.

4.15 **Уточнение по уровням и ацикличность:** каждая L2-привязка уточняет L1-привязку того же коннектора, каждая L3 — L2 (refines = цепочка parent_id ИЛИ ребро realizes; producer и каждый consumer нижнего уровня refines верхний); immediate L1 с endpoint под B01/B02/B03 (id зашиты) требует ≥1 L2, immediate L2 под B01..B03 — ≥1 L3 (карта обязана содержать узлы B01, B02, B03); v2/v3: юниты, реализующие L2-роли, обязаны сохраняться в immediate L3 (current_l2_roles_preserved_at_l3); на каждом уровне граф immediate-привязок ацикличен (самопетли игнорируются), один producer.node_ref на уровень коннектора; отношение refines ограничено (≤1024 узлов, глубина ≤128).
| Отказ: `connector_refinement_gap` (L2_endpoints_refine_L1 | L3_endpoints_refine_L2), `active_refinement_missing` (active_l1_has_l2_refinement | active_l2_has_l3_refinement | current_l2_roles_preserved_at_l3), `hierarchy_cycle` (connectors:<level>), `multiple_sole_producers` (one_semantic_producer_per_level), `refinement_cycle` ($graph).
| Улики: OM:309-323; OM:325-326 «["B01", "B02", "B03"].some((rootRef) => refines(endpoint.node_ref, rootRef)) && !(byLevel.get("L2") ?? []).length … "active_refinement_missing"» (проверено grep); OM2:172-183; OM3:306-309; OM3:311-319; OM:343-363; OM3:323-336; C:1165-1166; C:1461.

4.16 **edges:** {id, relation ∈ {on_success, on_failure, returns_to, validates, accepted_by, implements, realizes, requires}, source_ref, target_ref → узлы}; массив может быть пустым; валидатор читает только realizes (уточнение и границы), requires (target→source) и on_success (source→target) как граф AU для дистанции; прочие relation игнорируются. В MAP: 158 рёбер — realizes 97, requires 53, on_success 8.
| Отказ: `unknown_ref` (edge_endpoints_resolve).
| Улики: S2:452-455 «required [id, relation, source_ref, target_ref] … enum [on_success, on_failure, returns_to, validates, accepted_by, implements, realizes, requires]»; OM3:231; OM3:246-247; OM3:366-367; C:1333.

### L2 (B06, текущий блок)

4.17 **Subblocks и L2-концы:** subblock с одной coherent responsibility, typed ports, boundaries; L2-концы коннекторов лежат внутри L1-концов (producer/consumers с port_ref).
| Отказ: `endpoint_outside_parent` (в operation-map-g2*.mjs не найден), `connector_endpoint_missing`, `connector_refinement_gap`.
| Улики: C:190 «Модульная часть блока с одной coherent responsibility, ограниченными ports и понятными boundaries.»; C:1149-1150; C:1165-1166 «L2 endpoints находятся внутри L1 endpoints; L3 endpoints находятся внутри L2;»; C:1461.

4.18 **integration_distance_profiles:** ровно профиль id "PROFILE-OMG2-ACTIVE-L3-V1", profile_version "v1", schema_version "task-plan-pro.integration-distance-profile-g2/v1", edge_set "load_bearing_connectors", distance_unit "acceptance_unit", warning_threshold (int ≥0), warning_comparison "greater_than_or_equal", warning_effect "diagnostic_only", active_l3_error_threshold (int ≥0), error_comparison "greater_than", error_effect "decomposition_required", sleeping_contract_exemption "complete_at_anchor_contract_only"; входит в handle (id, profile_version, sha256). Авторское поле L2 (§10 шаг 10); пороги — п. 3.2.
| Отказ: `integration_distance_profile_missing` (active_profile_present) → topology_owner; `schema_invalid` (const); `join_input_foreign` при id/version ≠ PROFILE-OMG2-ACTIVE-L3-V1/v1.
| Улики: OM:404-405 «index.profiles.get("PROFILE-OMG2-ACTIVE-L3-V1"); if (!profile) … "integration_distance_profile_missing"» (проверено grep); OM:537-538; S1:309-331; C:235-236; C:1184-1192; C:1416-1418; C:1496-1497.

4.19 **anchors (≥1):** {id, kind ∈ {integration, bootstrap_source}, contract_ref ∈ каталог, owner_node_ref → узел, outcome_ref → узел|артефакт} — стабильная семантическая точка активации/сборки, не task ID; создаются на L2 (§10 шаг 7), ID резервируются на L1.
| Отказ: `schema_invalid` (S2:54 minItems 1; S2:300 required); `anchor_contract_missing`, `anchor_resolution_missing` (OM:289-290); `anchor_missing`, `anchor_resolution_conflict`, `anchor_semantic_drift` (C:1471-1472; последние два не реализованы).
| Улики: S2:300-303 «required [id, kind, contract_ref, owner_node_ref, outcome_ref] … enum [integration, bootstrap_source]»; C:202 «Стабильная семантическая точка активации или сборки, не зависящая от task ID.»; C:1264-1268; C:1329; C:533-534.

4.20 **join_contracts:** {schema_version const "task-plan-pro.join-contract-g2/v1" ∈ каталог, id, consumer_ref → узел, returns_to_ref → узел, inputs[{connector_ref существует, artifact_ref и contract_ref == полям коннектора, multiplicity "exactly_one"}], missing_outcome="join_input_missing", extra_outcome="join_input_extra", foreign_outcome="join_input_foreign", stale_outcome="join_input_stale", duplicate_outcome="join_input_duplicate"}; обязателен при ≥3 direct load-bearing inputs, при 2 — если нужны typed multiplicity/failure rules. В MAP: 4 контракта, 16 входов, все exactly_one.
| Отказ: `join_contract_missing` (OM3:388; OM:436; C:599), `join_input_mismatch` (OM3:391; OM:439), `typed_absence_missing` (OM3:393).
| Улики: OM3:388; OM3:391 «connector.artifact_ref !== input.artifact_ref || connector.contract_ref !== input.contract_ref || input.multiplicity !== "exactly_one" … "join_input_mismatch"»; OM3:393; MAP /join_contracts/0; C:533; C:597-599 «Три и более direct inputs без такого контракта дают join_contract_missing.»; C:1484-1486.

### L3 (B07/B08, ближайшая вертикаль)

4.21 **Узлы acceptance_unit / work_packet:** AU — минимальная единица с одним observable outcome, которую можно принять, закоммитить и использовать для разблокировки downstream; WP — внутренний bounded slice одной AU без отдельного принятия (не закрывает dependency, не выпускает TaskCommit); если packet требует независимого commit/rollback/scheduling — это отдельная AU. Группировка — по критериям §12 (строки 792-808) над авторскими boundaries; фразы «требует знания кода» в C нет.
| Отказ: `acceptance_outcome_conflict`, `work_packet_requires_independent_acceptance`.
| Улики: C:206-207 «Минимальная единица, после которой один observable outcome можно принять, закоммитить…»; C:211-212 «Внутренняя bounded implementation slice одной Acceptance Unit. Не является отдельной единицей принятия.»; C:1056-1057; C:1479.

4.22 **declared_write_ownership_transfers:** если один path имеет access=write у >1 AU — обязан существовать transfer {schema_version "task-plan-pro.write-ownership-transfer-g2/v1", id, path, from_acceptance_unit_ref ≠ to_acceptance_unit_ref (оба AU), transfer_condition "finalized_producer_seal", expected_base_ref непустой, exclusive true}. Решение принимается на L3 (§12 шаг 7), не «до карты». В MAP: 226 переносов, 53 из них в AU-OMG2-AFFECTED-RUN-GATE-001.
| Отказ: `write_ownership_overlap` (shared_write_has_exclusive_ordered_transfer) → l3_integration_owner; `write_ownership_transfer_missing`.
| Улики: OM:444-452 «for (const [path, owners] of writeOwners) if (new Set(owners).size > 1) { … item.exclusive === true … "write_ownership_overlap"»; S1:363-380; C:784; C:829-846.

4.23 **product_test_contracts (≥1):** 11 полей {schema_version "task-plan-pro.product-test-contract-g2/v1", id, applies_to → узел, given[≥1], when, then[≥1], forbidden_side_effects[], production_entrypoint{kind ∈ {route, server, cli, product_caller}, ref}, positive_test_id, counterfactual_pairs[{connector_ref, mutation ∈ {remove, revoke, substitute}, positive_test_id, expected_failure_code_or_outcome}], activation_status ∈ {active, sleeping}}; active → positive_test_id == id evidence с kind=product_test (тест существует как файл с sha), ≥1 пара, pair.positive_test_id == contract.positive_test_id; sleeping (wake-контракты якорей) — без этих требований. Полей production_risk / fixture_constraints / единичного counterfactual нет — риск прозой в then/forbidden_side_effects; словарь forbidden_side_effects не проверяется. В MAP: 52 (active 45 / sleeping 7), applies_to AU 47 / block 4 / actor 1, kind cli 20 / product_caller 32 (route/server не использованы; ref также вида "bootstrap/source-binding", "future/era-cutover").
| Отказ: `product_test_contract_missing` (applies_to_resolves, OM:456), `positive_product_test_missing` (active_positive_test_evidence_present), `counterfactual_pair_missing` (active_product_test_has_counterfactual | counterfactual_uses_same_positive_test), `schema_invalid`.
| Улики: OM:454-460 «positiveTests = … item.kind === "product_test" … "positive_product_test_missing" … "counterfactual_pair_missing"»; S1:401-421; S1:384-393; MAP /product_test_contracts/0; MAP /product_test_contracts/1 («activation_status: sleeping … counterfactual_pairs: []»); C:787 (§12 шаг 9); C:1336.

4.24 **Нагрузочные коннекторы и первый живой потребитель** (вычисляемая проверка над авторской топологией): каждый connector_ref из counterfactual_pairs обязан существовать; иметь ≥1 L3 immediate-привязку ЛИБО at_anchor-привязку с валидным wake_test_contract_ref; для каждой L3 immediate — AU producer и AU каждого consumer достижимы по рёбрам requires/on_success, кратчайшая дистанция ≤ active_l3_error_threshold.
| Отказ: `unknown_ref` (counterfactual_connector_resolves), `first_live_consumer_missing` (load_bearing_connector_has_live_or_complete_sleeping_consumer | consumer_reachable_in_au_graph) → graph_author, `integration_debt_exceeded` (active_l3_distance_within_profile, effect=decomposition_required) → l3_decomposition_owner.
| Улики: OM:418-422; OM:428-430 «distance === null … "consumer_reachable_in_au_graph" … distance > profile.active_l3_error_threshold … "integration_debt_exceeded"»; C:1171-1174; C:1365.

---

## 5. Что вычисляется картой/компилятором само и от стадий НЕ требуется

Авторская запись любого из этих полей — `derived_field_conflict` (C:1371; в operation-map-g2*.mjs не реализован, реализован в execution-graph-g2-v3.mjs:267); лишнее поле на корне карты режет `additionalProperties:false` (S2:6).
- children / block membership; task produces/consumes; direct dependencies/unblocks; topological order; Work Packet membership; anchor→task resolution; wake obligations; joins (resolved); correction targets; rollback unit; resolved write-ownership transfers; first live consumer, consumer distance, integration debt; parallelism; test manifest; review manifest и review-subject requirements; decomposition findings — C:1354-1369 «children/block membership; task produces/consumes; direct dependencies/unblocks; topological order; … decomposition findings.».
- level узла — выводится из hierarchy/refinement horizon, не дублируется без reader — C:1087.
- load-bearing статус коннектора — dependency closure от declared outcome/acceptance claim — C:1171-1174 (реализация: объединение connector_ref из counterfactual_pairs, OM:406-407).
- applicability тестов (`required | not_applicable`) — compiler из boundaries/connector semantics; автор не пишет not_applicable — C:1252-1253.
- Scheduler читает compiled output, не Markdown — C:1436.
- Для successor-карты: `predecessor_ref.graph_sha256` (RF:434-445), `graph_revision = исходная+"+refinement-"+16 hex` (RF:439); в question set — `source_graph_ref`, `validated_graph_handle_ref` копируются из handle (RF:168-178); `question_id = "RQ-"+sha256` черновика (RF:238-252).
- Проекция карты в handle (graph_ref, contract_catalog_ref, integration_profile_ref, current_horizon.sha256) — OM:500-505, OM2:232-235.

---

## 6. Справочно: требования последующих стадий (потребители карты) — НЕ вход в карту

- **TASK-PLAN хранит только** operationGraphRef (graph ID, revision, SHA-256) и operation_nodes[]; шаг 11 L3 связывает AU со scheduler `code task`; остальное выводит compiler — C:790 «11. Связать Acceptance Unit с существующей scheduler code task.»; C:866; C:1350. Стадии «task_plan_builder» в C нет (grep 0).
- **Binding-файл** (--binding) в source set на expected parent, канонический JSON, схема task-plan-operation-binding-g2.v3; лишние поля входа компилятора — отказ до чтения — EG3:698-699; EG3:714-722; EG3:793-794 (`join_input_extra`, `join_input_foreign` $bindingPath).
- **binding.plan_source** {path, sha256, generated_path, generated_sha256}: path/sha в source set; generated_sha256 → source_binding.generated_plan_sha256, на resolved-пути сверяется — EG3:191-193; EG3:114,125; EG3:727-728; EG3:647-648 (`foreign_plan_binding`, `resolved_execution_graph_invalid`).
- **task_bindings[]**: task_id/acceptance_unit_ref уникальны; множество acceptance_unit_ref == refinement_horizon.l3_roots; unit kind=acceptance_unit; при узле AU-OMG2-OPERATION-MAP-TASK-DERIVATION-001 title == unit.title; write_paths == code_refs(write).path; test_paths ⊆ write_paths; journey_path ∈ write_paths; operation_nodes == target realizes-рёбер юнита и его WP — EG3:155-156; EG3:199-200; EG3:202,211; EG3:215-217; EG3:429-437 (`foreign_plan_binding`, `duplicate_id`, `write_scope_conflict`, `unbound_operation_node`).
- **predecessor_seals[]** {task_id, acceptance_unit_ref, connector_ref, commit_oid, tree_oid}: не пересекаются с текущими; resolveCommitTree(commit_oid)==tree_oid и commit — предок parent; каждая печать потребляется зависимостью или transfer; внешний producer нагрузочного L3-коннектора обязан иметь печать — EG3:159-160; EG3:580-584; EG3:522-525; EG3:249; EG3:412-414 (`join_input_duplicate`, `join_input_stale`, `producer_seal_missing`). Стадия «feature_preparation» в C не подтверждена.
- **Тестовые байты** (compile-execution-v3): каждый test_path и journey_path читается как обычный файл, иначе sha в манифесте = "0"×64 — EG3:295-299; CLI:598-600 (`source_drift`, candidate_test_regular_bytes_available).
- **derive-task-card-v3:** узел --acceptance-unit существует, kind acceptance_unit; title → task_card.title; type "code", finalizers [] — EG3:816-822; EG3:902-909 (`task_card_node_missing`, `task_card_node_kind_invalid`); в данных корректировка этого пункта — заглушка «test», принята исходная формулировка. Ровно один прямой WP с id `^WP-((BOOT|M\d+)-\d{3})-` → task_id и scope_authority `canonical_task_plan_card_{taskId}_{slug}_001` — EG3:52-54; EG3:61-67; EG3:827-835 (`task_card_task_identity_invalid`). write_paths = code_refs(write); ровно один `tests/journeys/v3/{taskId}/*.json` → journey; все --test-path ∈ write_paths, уникальны, ≥1; класс ∈ {exclusive, own_dirs, pure} — EG3:836-846; EG3:855-863; CLI:295-296. Существующий binding из коммита expected parent читается через readCommitEntry; юнит/task_id не заняты чужими — EG3:886-901; EG3:910-928 (`join_input_missing`, `task_binding_occupied`).
- **Refinement читает каталог v2** `contracts/operation-map-contract-catalog-g2.v2.json` {catalog_id "CATALOG-OMG2-CONTROL-V2", catalog_version "v2", entries[], review_policies[], schema_version}; sha схем по schema_ref; successor concept_ref/map_ref/evidence_refs пути — в parent source set с ролью evidence — RF:429-432; RF:398-404; RF:406-410 (`contract_ref_missing`, `source_missing`, `source_drift`).
- **Refinement result** (schema refinement-result-g2/v1): self-hash "refinement-result-g2-v1:sha256:"; status refined|unresolved_research; applied_refinements[]; successor_graph при refined (schema operation-map-g2/v2); source_binding{answer_set_ref, canonical_answer_set_bytes_base64, contract_catalog_ref, engine_ref{id,sha256,version}, expected_parent, planning_ref, question_set_ref, source_graph_ref, validated_graph_handle_ref}; verify перевыполняет compile и требует побайтового совпадения — RF:480-496; RF:587-599; RF:681-686; RF:439 (`join_input_foreign` result_self_hash_exact, `derived_field_conflict` entire_result_live_replayed, `join_input_extra`, `source_drift`).
- **compile-feasibility-v3:** --binding обязателен; stdin {schema_version "task-plan-pro.r3-feasibility-input-g2/v1", planning_execution_graph_bytes_base64, refinement_result_bytes_base64, runtime_capability_inventory}; + feasibilityResultSchemaBytes и схемы refinement — CLI:520-530; CLI:832-841; CLI:691-696 (`join_input_foreign`, `join_input_missing`); внутренние правила R3 — в `r3-feasibility-g2.mjs`, не читан.

---

## 7. Опровергнуто

Теги: [АТР] механизм подтверждён, снята только атрибуция стадии; [ФАКТ] ошибка в формулировке/числах; [КОД] код делает не то, что заявлено; [УЛИКИ] ссылки неверны/неполны; [ЗАГЛ] причина в данных не указана; [СПОРНО] основание отклонения противоречит подтверждённым kept-уликам.

- graph-canonical-bytes — [АТР] канон. байты, closed_object, 19 полей, minItems:1 подтверждены (OM, S1); «operational_map_itself» — в коде returns_to=graph_author (OM:49), в §6 стадии нет.
- concept-ref-34-sections — [АТР] sha/34 секции подтверждены; «concept» не стадия §6 — concept_ref авторит L1/B05.
- map-ref — [АТР+ФАКТ] OM:259 верен; map_ref/map_id/map_revision в C не упомянуты, скелет §15 без map_ref.
- contract-catalog-ref-and-artifact — [АТР] проверка верна; стадии «specification» в C нет.
- review-policy — [ФАКТ] структура верна, но schema_invalid для review_policies уходит graph_author (OM:49,104), а не review_policy_owner (тот только для duplicate_id OM:194 и review_contract_missing OM:461).
- node-13-mandatory-fields — [ФАКТ] схема/код требуют 13 полей, но канонический Node §15 (C:1068-1085) — 12, без join_contract_refs; «joins» в §16 — вычисляемое.
- boundaries-object — [АТР] семантика (a)/(b) верна (OM:389-403); «owner» не стадия — L2/L3; schema_invalid → graph_author, не l3_owner.
- refinement-horizon — [АТР+УЛИКИ] базовые проверки верны (OM:297,307-308,462-465); v2-правила реально в OM2:139-170 (не процитированы); «feature_preparation» нет в §6.
- node-research-refs — [АТР] OM:265 верен (evidence_ref_unknown → evidence_owner); «discovery» — не стадия.
- node-test-and-join-refs — [КОД] резолв верен, но «ровно один join на потребителя» не проверяется: joinsByConsumer — Map, второй join с тем же consumer_ref молча перезаписывает (duplicate_id только по id, OM:207).
- artifacts — [АТР] схема/коды верны; стадия — L1 (§8 п.5).
- anchors — [АТР] S2:300, OM:289-290 верны; стадия — L2 (§10 п.7), ID на L1.
- edges — [ФАКТ] realizes применяется и к L2→L1, и к L3→L2 (OM:309-317), не только L3→L2.
- join-contracts — [АТР] S1:343-362, OM:436-441 верны; стадия — L2; «joins» §16 — другая (вычисляемая) сущность.
- write-ownership-transfers — [АТР] OM:447-453, S1:363-380 верны; «feature_preparation» нет; решение — на L3 (§12 шаг 7), не «до карты».
- validator-external-inputs — [ФАКТ] набор входов верен, но схемы канон не проверяются (только JSON+sha); «task_plan_builder» не обоснован.
- source_set_verified — [АТР] OM3:484,505 верны; source set — вход compiler (§17 шаг 1), не стадия карты.
- source_set_no_binding — [ФАКТ] условие инвертировано: join_input_extra при binding_path !== null; null — проходное.
- graph_file_present_canonical — [АТР] OM3:74-75,161,445 верны; returns_to по умолчанию canonical_graph_owner (OM3:21).
- graph_catalog_ref_and_schema_version — [ФАКТ] predecessor_ref.graph_sha256 не required; contract_catalog_ref в C не упомянут.
- catalog_identity_exact — [АТР] OM3:146-147 верны; «specification» нет в §6.
- catalog_entries_resolve — [АТР+УЛИКИ] OM3:145-166 верны; тезис «contractRefs для всех contract_ref» в прочитанном фрагменте не подтверждён.
- global_unique_ids — [АТР] OM3:46,52-65 верны (глобальный Set); авторство послойное L1/L2/L3/R.
- map_ref_matches_evidence — [ФАКТ] mapRef требует 4 поля (S2:140-149), не 2; стадии нет.
- node_research_refs_resolve — [КОД+АТР] OM3:220 проверяет только резолв перечисленных ref; пустой список — не отказ; «discovery» — источник R0 (C:339).
- positive_test_evidence_noncurrent_active — [АТР] OM3:191-196 верны; PTC — L3 (C:787), proof — R2 (C:679).
- test_contract_record — [ФАКТ] OM3:406 проверяет только schema_version и applies_to; activation_status/positive_test_id — другие функции/коды; applies_to/activation_status нет в авторской схеме §15.
- counterfactual_pair_same_positive_and_connector — [АТР] OM3:199-203,407 верны; «feature_preparation» — другой пайплайн.
- horizon_l1_root — [АТР] OM3:214-215 верны; корень авторится на L1 (§8).
- horizon_refs_resolve — [ЗАГЛ] причина в данных — «test».
- anchor_record — [АТР] OM3:352-353 верны; «owner» не стадия — ID на L1 (C:379), anchors на L2 (C:533).
- hierarchy_acyclic_rooted — [АТР] OM3:225,228,452 верны; hierarchy — авторское L1 (§16).
- artifact_contract_and_external_source — [АТР] OM3:230,361-362 верны, коды в §18; «specification» — 0 совпадений; L1 (§8).
- refinement_bounded_acyclic — [АТР] OM3:243-248,454-455 верны; refinement_cycle/1024/128 в C не упомянуты (деталь реализации).
- l2_root_realized_by_current_l3 — [АТР] OM3:276-281,413-415 верны; ярлыки «operational_map_itself»/«research_call» в репо не встречаются.
- connector_binding_endpoints — [УЛИКИ] OM3:300-302 покрывают только producer/consumers; enum level/activation.mode — через JSON-schema (schema_invalid, OM3:167), в refusal не названо.
- at_anchor_binding_complete — [АТР] OM3:303-304 верны; anchors — L2 (§10 шаг 7).
- work_packet_inside_acceptance_unit — [АТР] OM3:95-102,336-346 верны; «task_plan_builder» — тег другой подсистемы (plan-acceptance).
- single_integration_profile — [ФАКТ] схема требует 12 полей (не 4), schema_version — const; «owner» нет; порог 1 — bootstrap-инвариант §10.
- load_bearing_connector_live_or_sleeping — [АТР+ФАКТ] OM3:118-124,373-375 верны; §15 держит activation на коннекторе, код читает на binding — расхождение.
- au_distance_within_profile — [АТР] OM3:381-383 верны; дистанция — вычисляемое (§16, §17 шаг 12), не «объявляется» в карте.
- write_ownership_single_or_transferred — [АТР] OM3:395-401 верны; returns_to=canonical_graph_owner; L3 §12 шаг 7, не task_plan_builder.
- transfer_record — [УЛИКИ] OM3:402-404 верны; id/path/exclusive этим кодом не проверяются (id — duplicate_id, mapById:46).
- current_unit_executable_and_test_bound — [АТР] OM3:421 верен; L3 §12 шаг 4.
- current_unit_owns_active_applicable_tests — [АТР] OM3:422-426 верны; L3 (C:791).
- current_unit_has_load_bearing_input — [ФАКТ] first live consumer — вычисляемое (§16); consumer-side проверка в §12 не поименована.
- involved_counterfactual_connector_owned_by_unit — [АТР] OM3:432-436 верны; L3 (§12 п.9).
- validated_handle_exact_recompute — [АТР] OM3:483-491 верны; producer — «TASK-PLAN + Operation Graph Compiler» (§6).
- binding-operation-graph-ref — [АТР] EG3:565-576 верны; §16 относит к TASK-PLAN только graph_id/revision/sha256; «task_plan_builder» нет в C.
- generated-plan-manifest — [ФАКТ] коды верны, но артефакт generated-manifest/v1 в C отсутствует; §12/§16: dependencies — вычисляемое.
- binding-actors — [АТР] код верен; actors нет в §16 «Авторское в TASK-PLAN»; reviewer identity — runtime registry (§21).
- product-test-contracts-on-unit — [ФАКТ] проверка требует TASK-PLAN binding (EG3:156) — стадия compiler; outcome_ref/rollback_ref читаются без отдельного отказа.
- planning-graph-as-refinement-input — [АТР] проверки живут в RF (потребитель), не в валидаторе карты (0 совпадений в OM*).
- research-question-set-identity — [АТР] RF:273-291 верны; research_call не только R0; question/answer set в C не упомянуты.
- derive-task-card-operation-nodes — [АТР] код верен; operation_nodes[] — авторское TASK-PLAN (§12/§16), стадия деривации.
- derive-task-card-dependencies-vs-compiler — [ФАКТ] две разные функции; derived_field_conflict (EG3:267) сравнивает с generated plan, не requires-рёбра с коннекторами; «согласование» — вымысел.
- rqs-envelope — [КОД] схема верна, но в коде нет validate/compile этой схемы (grep 0) — статика, не действующий отказ.
- rqs-source-graph-ref — [АТР] схема верна; поле копируется из handle (RF:168-175) — вычисляемое.
- rqs-validated-handle-v3 — [АТР] схема верна; копируется handleRef (RF:177-178); producer — валидатор графа.
- rqs-planning-ref-and-bytes — [АТР] схема верна; §14/§16 этих полей не содержат; владелец схемы — M11-006.
- rqs-diagnostic-generator — [АТР] const (RQS:76,79-81) верны; producer — валидатор §18.
- rqs-question-shape — [ФАКТ] §14 задаёт 11 полей; typed_diagnostic_ref — 12-е поле реализации, в C нет.
- rqs-source-kind-enum — [АТР] enum верен в обеих схемах; producer — «validator следующего уровня» на R-стадии.
- rqs-typed-diagnostic-ref — [АТР] схема верна; typed_diagnostic_ref в §14/§16 отсутствует.
- ras-envelope — [АТР] схема верна; «каждый вопрос получил ответ» реализовано в RF:521-525; «discovery» — иная подсистема.
- ras-evidence-item — [АТР] RAS:53-98 верны; «discovery» — источник R0 (C:339), не стадия.
- rr-source-binding — [АТР] RRS:143-154 верны; producer — M11-006/R2 refinement.
- rr-catalog-and-engine-consts — [АТР] const верны; «feature_preparation» нет; M11-006 (Builder).
- rr-status-branches — [АТР] oneOf верен; producer — движок taskplan.refinement-g2.
- rr-applied-refinement — [АТР] RRS:167-195 верны; producer — R-стадии/Research Artifact (§5, §14).
- ss-envelope — [АТР] SSS:4-22 верны; source-set — WP-M11-004-SOURCE-SET, вход compiler.
- ss-entry — [УЛИКИ] схема верна; ссылка r3-feasibility-g2.mjs:307 «source_stale» неверна; git-коммит гарантирует resolveOperationMapSourceSetG2V3, не схема.
- om-envelope — [ФАКТ] 18 required/closed верны, но map_ref и contract_catalog_ref отсутствуют в §15/§16 и без named reader (Field-reader principle); цитата id-паттерна на 87-90 неточна.
- om-concept-ref-34-sections — [АТР] S2:118-136 верны; producer — L1/B05 (§8 п.8); строки 132-137 → 128-136.
- om-map-ref — [ФАКТ] «map vs graph не определено» ложно (C:171-177); map_ref отсутствует в каноне §15 — schema drift.
- om-contract-catalog-ref — [АТР] схема верна; «feature_preparation» — стадия другого пайплайна (SPECIFICATION-V3 §4.1).
- om-catalog-v2-pins — [АТР] sha и отсутствия подтверждены; каталог v2 читает refinement, карта пинует v1; «feature_preparation» нет.
- om-refinement-horizon — [ФАКТ] «единственное место L1/L2/L3» ложно — connectorBinding.level (S2:264-271); producer — результат алгоритмов L1/L2/L3, не owner_decision.
- om-node-required — [ФАКТ] 13 полей в схеме, но канонический Node §15 — 12; связь join→node через consumer_ref.
- om-node-ports-coderefs — [ФАКТ] write_scope_invalid/entrypoint_unavailable — R3 feasibility, не отсутствие полей (это schema_invalid); ports — L2, code_refs — L3.
- om-artifact-required — [АТР] схема верна; durability/sensitivity без named reader в §18.
- om-connector-required — [АТР+УЛИКИ] схема верна; поля авторятся на L1/L2/L3 (C:379,532,800); «r3 стр.310,312-313» → 920-923.
- om-integration-distance-profile — [ФАКТ] «кто задаёт пороги — не сказано» ложно: §10 п.10, §15 канон 1/1, §16 авторское.
- om-join-contract — [АТР] S2:335-359 верны; L2 (C:534).
- om-write-ownership-transfer — [АТР] S2:363-379, r3-feasibility-g2.mjs:969-990 верны; L3 (§12 шаг 7).
- om-product-test-contract — [АТР] S2:386-419 верны; L3 (§12 шаг 9).
- om-review-policy — [АТР] S2:429-436, каталог v2:88-116 верны; «feature_preparation» — другой пайплайн; review_policy_ref — с B05.
- om-evidence-refs — [ФАКТ] схема верна; «kind=concept+accepted — форма входа концепта» не подтверждено (обязательности нет; §16 evidence_refs не упомянуты).
- r3-current-identity-22 — [АТР] R3S:116-139 верны; «task_plan_builder» — enum Cockpit UI (SPECIFICATION-V3:269); task_plan/generated_plan — роли source set.
- r3-refinement-binding — [АТР] схема верна; §13 inputs R3 не содержат refinement result; producer — движок r3-feasibility.
- r3-predecessor-seal — [ФАКТ] схема верна, но predecessor_seal нет в §13/§16/§19 и нет читателя в коде — нарушение Field-reader principle.
- r3-runtime-capability-inventory — [АТР] R3S:244-265,55-63 верны; §13 называет inventory входом R3; «discovery» нет.
- r3-obligation-binding-literals — [КОД] вывод «в схемах не выражено» ложен: r3-feasibility-g2.mjs:1028-1038 ищет ANCHOR-OMG2-R3-FEASIBILITY в graph.anchors → anchor_missing; карта их содержит.
- r3-19-checks-and-finding-vocab — [ФАКТ+АТР] это выход R3, не вход; дрейф: §13 текстом 18 проверок/22 кода, схема 19/23 (mutable_current_identity_literal в C нет).
- r3-returns-to-ladder — [АТР] R3S:389,401 верны; producer — R3 (§13).
- graph-identity-and-revision — [АТР] цитаты верны; stale_graph_hash — Compiler binding (C:1483), не identity карты.
- research-evidence-refs — [АТР] цитаты верны; «discovery» — источник R0; R-стадия самим claim не определена.
- journey-blocks-l1 — [АТР+ФАКТ] parent_id/коды верны; producer — L1 builder; «один вход/output» названными кодами не покрыт.
- node-purpose-and-declared-outcome — [ФАКТ] unknown_ref/terminal_outcome_unobserved/load_bearing_connector_unproved не про отсутствие title/purpose/outcome_ref (это schema_invalid); «concept» не стадия.
- domains-vs-blocks — [АТР] тезис верен (§15 kinds без domain, §16 boundaries авторские); producer — R1 (C:419-421).
- refinement-horizon-roots — [ФАКТ] выбор блока/вертикали — шаги алгоритмов L2/L3 (C:525,771), не owner_decision (C:996 закрытый список; C:136 против owner-ворот).
- external-actors-systems-classification — [АТР] external_source/коды верны; L1 с фактами R1 (C:452-457).
- artifact-registry-with-contracts — [АТР] верно; «specification» нет — L2 (C:516-529), §16 авторское.
- connector-l1-producer-consumer — [ФАКТ] first_live_consumer — вычисляемое (C:1365, §17 шаг 12), не L1-вход; «discovery» — 0 совпадений.
- connector-l3-code-and-test-binding — [АТР] C:1152-1156, §16 верны; факты — R2 (§11), запись — L3 (§12 шаг 4).
- connector-activation-mode — [АТР] C:1159,1276-1283 верны; коды — validator §18, не стадия.
- join-contracts (концепт) — [АТР+УЛИКИ] C:240,1194-1208,1331 верны; L2/B06; typed_absence_missing и т.п. — из Failure/recovery (C:1467), не join.
- write-ownership-transfers (концепт) — [АТР] C:230-231,1213-1218,248 верны; L3 (§12 шаг 7).
- control-failure-edges — [ФАКТ] edges верны; task_dag_cycle — Compiler binding (C:1484, §17 шаг 15), не карта.
- product-test-contracts (концепт) — [АТР] C:1225-1246 верны; L3 (§12 шаг 9), не «specification».
- recovery-carrier-snapshot — [ФАКТ] «§27 не читано» ложно: C:1983-2005 — снимок перед удалением donor worktree; level L3 не обоснован.
- task-plan-authored-binding — [ФАКТ] цитаты верны; вывод «граф до написания плана» противоречит §13 (план — вход R3); «task_plan_builder» только в реализации.
- field-reader-principle — [АТР] C:1375-1376 верны; «specification» — 0 совпадений.
- r0-concept-sections-addressable — [ФАКТ] concept_ref (C:1027) — ссылка на документ целиком, implements (C:1077) — связь; concept_ref_unknown не про покрытие секций; implements авторится на L1.
- r0-source-discovery-scenarios — [ФАКТ] «discovery» — вход R0 (C:339), не стадия; «обязана поставить» без механизма отказа.
- r0-role-questions — [АТР] C:304,309,345 верны, reader — L1 шаг 1 (C:374); producer — R0, не «concept».
- r0-terminal-outcomes — [АТР] C:346,375 верны; producer — R0; terminal_outcome_unobserved не про отсутствие outcomes.
- r0-journey-variants — [АТР] 17 вариантов верны (C:315-333); producer — R0 («Канонический результат»), не concept.
- r0-external-systems — [ФАКТ] external_source_unclassified — про artifact.external_source (C:1098), не про список R0.
- r0-evidence-provenance — [ФАКТ] evidence_ref_unknown — висячая ссылка, не отсутствие; producer — R0.
- l1-scope-no-code-details — [ФАКТ] inactive_l3_requirement_leak — про L3 (§18 Refinement, C:1951), не защита L1.
- r1-scope-not-whole-repo — [АТР] C:408,410 верны; «feature_preparation» — 0 совпадений; кода §18 нет.
- r1-product-business — [АТР] цитаты верны; producer — R1 (§9).
- r1-actor-channel — [АТР] C:423,425,905 верны; стадия — R1.
- r1-runtime-execution — [АТР] C:429,433,1490 верны; стадия — R1.
- r1-data-persistence — [АТР] C:437,440,644,1477-1478,1454 верны; стадия — R1; «producer» в схеме — node_ref коннектора, не стадия.
- r1-authority-security — [АТР] C:444,448,511,930,1477 верны; стадия — R1.
- r1-integration-external — [ЗАГЛ] причина в данных — «test short reason».
- r1-recovery-operability — [АТР] C:1466-1467,931 верны; стадия — R1.
- r1-delivery-compatibility — [АТР] C:468,471,547,512 верны; стадия — R1.
- r1-evidence-test — [АТР] C:475-479,1490,1501 верны; стадия — R1.
- r1-sources-and-wip-rule — [АТР] C:483-492,1005,1446 верны; стадия — R1.
- r1-canonical-output — [ФАКТ] цитаты верны; derived_field_conflict (§16) — про поля графа/TASK-PLAN, не про R1 views.
- l2-current-block-selection — [ФАКТ] верно по §10, но «owner» не подтверждён — шаг алгоритма L2; C:136 против owner-ворот.
- r2-contract-questions — [АТР] C:685-689,1445,1456-1457,1467,924 верны; стадия — R2.
- r2-authority-questions — [АТР] C:693,698,676,930,1477,905 верны; стадия — R2.
- r2-state-recovery-questions — [АТР] C:674,702,709,1478,1466,931 верны; стадия — R2.
- r2-connectivity-testability-questions — [АТР] C:711-722,1462,1490-1492,1502,1472 верны; стадия — R2.
- r2-proof-assignment — [АТР] C:678,679,736,1004,1501-1502 верны; стадия — R2, не «feature_preparation».
- r2-future-deps-anchors — [АТР] верно (§16 anchors авторские); «operational_map_itself» нет — L2 (§10).
- r2-sources-and-evidence — [АТР] C:726,734,681 верны; стадия — R2.
- l3-observable-result-from-l2 — [УЛИКИ] C:771,767,849 верны; l3_roots — поле, не код; terminal_outcome_unobserved — про конец вертикали; исполнитель — L3 decomposer.
- l3-acceptance-unit-criteria — [АТР] C:796,812,827,1477-1479 верны (writer_conflict пропущен); «из R1/R2 фактов» текстом не подтверждено — чек-лист L3 §12.
- l3-write-ownership-transfer — [АТР] C:784,839,844,1489-1491,927 верны; L3 (B07/B08).
- l3-product-test-and-review-contracts — [ФАКТ] review contract = review_policy_ref (авторское) + review manifest (вычисляемое, §17 шаг 14); коды в коде не реализованы.
- r3-inputs-hash-bound — [АТР] C:876,881-887,915-917,950,1483 верны; «task_plan_builder» — тег plan-acceptance, не C.
- r3-checks-and-typed-result — [ФАКТ] typed results — 23, не 24 (C:914-936); стадия — R3.
- r3-routing-by-gap-kind — [АТР] C:943-948 верны; correction targets — вычисляемое (§16); стадия — R3.
- rq-source-kind-routing — [КОД] цитаты верны; source_kind нет в §18 — не enforced-инвариант.
- rq-answer-shape — [АТР] C:990,991,994,918,1446 верны; «feature_preparation»/«research_answer» — 0 совпадений.
- r-stages-not-gates — [АТР] C:55,136,291 верны; «owner» не стадия — авторский текст §3/§6.
- graph-identity-and-predecessor — [ФАКТ] predecessor_ref.required только [kind, schema_version]; «неизменяемый graph_revision» без механизма в коде.
- concept-ref-exact-sections — [АТР] OM:250,258,264 верны; формализация concept_ref — работа автора графа (L1).
- contract-catalog-ref — [АТР] OM:174-289 верны; «specification» нет — §31.3 B01 (C:2151).
- evidence-refs-source-bytes — [ФАКТ, подтверждено сейчас] код верен, но в MAP нет evidence для BOOTSTRAP-OPERATION-BINDING.json и validate-operation-map-g2-cli.test.mjs (см. п. 0); «operational_map_itself» нет в §6.
- refinement-horizon-owner-choice — [АТР] OM:298,307-308,464-465 верны; «owner» — шаги алгоритмов L1-L3; l1_only_* в §6-13 не упомянуты.
- review-policy-ref — [АТР] S1:24,422-447, OM:191-195,461, C:1337 верны; «specification» нет — L1/B05.
- integration-distance-profile-const — [АТР] OM:404-405, §10 верны; «operational_map_itself»/«topology_owner» в C нет — L2.
- node-uniform-13-fields — [ФАКТ] 192 узла/13 ключей подтверждены, но join_contract_refs нет в Node §15 (12 полей); producer послойный.
- node-id-prefix-and-parent-tree — [ФАКТ] дерево верно; $defs/id — общий паттерн, префиксы по kind схемой/валидатором не проверяются (кроме B01-B03 в OM:325-326).
- node-implements-c-refs — [СПОРНО] числа верны; причина отклонения «строки 264 и implements_ref_resolves нет в источниках» опровергнута: OM:264 содержит `"implements_ref_resolves"` (проверено grep); остаётся только «concept» ≠ стадия §6.
- node-research-refs-uniform — [ЗАГЛ] причина в данных — «test».
- boundaries-five-fields-vocab — [ФАКТ] структура/53/139 верны; словарь 26/26/29 ложен (факт 35/35/39); «$defs required 5» в источниках нет (концепт даёт 4).
- boundaries-coherence-au-realized-wp — [КОД] сравниваются 5 подполей, не весь кортеж; source realizes — AU, не WP; producer — R3 compile.
- ports-never-authored — [ФАКТ] факты верны, но вывод «обошлось по замыслу» ложен: инвариант §10 «каждый L1 connector уточнён до port» нарушен (90 L2-привязок без port_ref).
- code-refs-write-overlap-transfer — [АТР] 226/53, OM:445-453 верны; L3 (C:829-852).
- test-contract-refs-per-node — [ФАКТ] 32/33 AU верно; subblock с refs — 12, не 4; WP-M11-004-V1-V2-ERA-TEST непуст; returns_to=graph_author.
- join-contract-refs-subblock — [ФАКТ] пары переставлены: JOIN-…-CANONICAL-CONTROL-SOURCES у SB-B03-CURRENT-CONTRACT-COMPILER, JOIN-…-COMPILE-INPUTS у SB-B03-SOURCE-BINDER; SB-B03-CANONICAL-GRAPH-SOURCE — пусто.
- connector-shape — [АТР] 59/249/1-14 верны; стадия — L1 (§8 шаг 6) + уточнение L2/L3.
- connector-activation-at-anchor-wake — [ФАКТ+СПОРНО] числа верны; wake obligations — вычисляемое (§16); «правило B01-B03 запрещает» неверно — OM:325-326 требуют уточнения, не запрещают; строки 285/336 — реальные строки OM (проверено), а не §7.
- anchor-shape — [АТР] OM:289-290 верны; L2 (C:533).
- load-bearing-derived-from-counterfactuals — [КОД] OM:406-430 верны, но не соответствуют §12/§20 (dependency closure от outcomes): коннектор без PTC не проверяется (молчаливый пропуск); «47 из 59» не подтверждено.
- edges-relations-used — [ФАКТ] realizes WP→OP 16 + WP→EP 1 (не 17); стадия не «operational_map_itself».
- ptc-counterfactual-pairs — [ФАКТ] цифры верны кроме «consumer_missing 14» (не подтверждено); L3 (§12 п.9).
- ptc-forbidden-side-effects-vocab — [ФАКТ] «семантической проверки нет» ложно: r3-feasibility-g2.mjs проверяет 4 строки для FEASIBILITY_TEST (contract_mismatch).
- ptc-sleeping-wake-contracts — [ФАКТ] OM:457,336 верны; when="resolve ANCHOR-…" неверно для 2 из 7; 5 из 7 несут 1-3 пары; L3.
- external-actors-systems-r0 — [ФАКТ] «C07 для акторов» неверно (ACT-EVIDENCE-RESEARCHER без C07); системы делят общий AUTH-OMG2-EXTERNAL; producer — R0.
- bootstrap-source-owner-decision — [СПОРНО+ФАКТ] JSON верен; «коды 336/285 придуманы» опровергнуто — это строки OM:336 (future_dependency_unanchored) и OM:285 (anchor_missing), проверено; связка уже авторски выполнена в MAP — не открытое owner-решение; producer — L1 builder.
- task-plan-binding-side — [ФАКТ] поля верны; §12/§16: TASK-PLAN авторит только operationGraphRef+id/title/type+operation_nodes; остальное — compiler.
- validator-implemented-vs-concept-codes — [ФАКТ] ~10 из перечня «не реализовано» реализованы в execution-graph-g2*.mjs / r3-feasibility-g2.mjs / g2-cli.mjs (foreign_plan_binding, unbound_operation_node, derived_field_conflict, task_dag_cycle, path_missing, entrypoint_unavailable, test_unreachable, write_scope_conflict, review_subject_binding_incomplete, review_manifest_incomplete); ~19 действительно отсутствуют (level_inversion, terminal_outcome_unobserved, connector_contract_mismatch, connector_identity_fork, endpoint_outside_parent, inactive_l3_requirement_leak, return_target_too_late, recovery_carrier_missing, typed_foreign_missing, typed_stale_missing, anchor_resolution_conflict, anchor_semantic_drift, orphan_wake_obligation, acceptance_outcome_conflict, symbol_missing, future_path_required_for_current_acceptance, late_integration_choke_point, load_bearing_connector_unproved, sleeping_consumer_review_gap).

---

## 8. Не прочитано

- `contracts/validated-operation-map-g2.schema.json`, `.v2.schema.json`, `.v3.schema.json` — существуют (ls подтверждён сейчас), содержимое никем не читалось.
- `contracts/planning-execution-graph-g2.v1.schema.json`, `contracts/resolved-execution-graph-g2.v3.schema.json`, `contracts/task-plan-operation-binding-g2.v3.schema.json` (и v1/v2), `contracts/research-artifacts.schema.json` — не читались.
- Схема `task-plan-pro.operation-map-diagnostic-g2/v1` — файл в contracts/ по grep не найден; словарь кодов диагностик (typed_diagnostic_ref.code) в источниках отсутствует.
- `packages/plan-compiler/r3-feasibility-g2.mjs` — только grep (внутренние правила R3, поля результата, коды отказов не читались построчно).
- `packages/plan-compiler/operation-map-source-set-g2-v3.mjs`, `g2-index.mjs`, `git-object-reader.mjs` — только grep.
- `packages/plan-compiler/test/operation-map-g2.test.mjs`, `test/validate-operation-map-g2-cli.test.mjs` — не читались.
- `OM-NEW-CONTEXT/Operation-Map-of-NEW-OM.md` (прозовая карта, смысл B01..B08 известен только по id), `BOOTSTRAP-OPERATION-BINDING.json`, `BOOTSTRAP-OM-G2.json`, `SEALED/`, `CONTEXT.md` (кроме строк 100-200) — не читались.
- `PREPARATION/TASK-PLAN-V3.md` и `.generated.json` — только фрагменты через grep (M11-004/006/007), не целиком; `PREPARATION/POST-M9-022-*`, `POST-M9-022-AUDIT-TASK-CONCEPT.MD` — не открывались.
- `tests/journeys/v3/*/journey.json` и файлы тестов из evidence_refs — не читались.
- `OM-NEW-CONTEXT/NEW-CONCEPTION-OM.md`: §2 (67-116), §4 (140-168), §15 частично (1180-1259, 1302-1319), §17 (1380-1440), §19–§34 (1507-2273) — только фрагментами (цитированы 1951, 1983-2005, 2144-2151, 2186, 2226).
- Полные title/purpose всех 192 узлов MAP — просмотрены выборочно по одному на вид.
- Тождество $defs между S1 (v1) и S2 (v2) не проверялось; какой валидатор (v1 с 7 фиксированными путями или v3 без списка) применяется к текущему MAP в реальном прогоне — по прочитанному не установлено.