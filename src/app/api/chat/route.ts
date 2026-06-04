import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { PoolClient, QueryResultRow } from 'pg';
import type {
  ChartData,
  ReportChartType,
  SmartReport,
  SmartReportAnalysisGroup,
  SmartReportChartExplanation,
  SmartReportFinalSummary,
  SmartReportChart,
  SmartReportMetric,
  SmartReportRootCause,
  SmartReportSection,
  SmartReportStep,
  SmartReportTable,
} from '@/lib/types';
import { getPgPool, isPostgresConfigured, query as pgQuery } from '@/storage/database/pg-client';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-v4-pro';
/** deepseek-v4-pro 上下文窗口 128K tokens，保守估算为 100K 字符（~4 chars/token） */
const MAX_CONTEXT_CHARS = 100_000;
/** 上下文超过此阈值时，向前端发出"建议新开对话"的提示 */
const CONTEXT_WARNING_CHARS = 50_000;
/** 历史消息最大保留条数（10 轮对话） */
const MAX_HISTORY_MESSAGES = 20;
const MAX_CONTEXT_ARTIFACTS = 6;
/** 单条历史消息最大字符数（assistant 答复合更长，user 问题较短） */
const MAX_HISTORY_USER_CHARS = 500;
const MAX_HISTORY_ASSISTANT_CHARS = 3500;
const DEFAULT_REPORT_SQL_LIMIT = 10000;
const DEFAULT_REPORT_CHART_LIMIT = 10;
const MAX_REPORT_CHART_LIMIT = 20;
const MAX_KNOWLEDGE_CANDIDATES = 60;
const MAX_RELEVANT_KNOWLEDGE = 6;
const DEFAULT_REPORT_DATE_RANGE = getDefaultReportDateRange();

const PLANNER_SYSTEM_PROMPT = `你是「VOC 智能问数」的 SQL 规划器。

你只负责基于用户已选择的数据表生成 PostgreSQL 查询计划。

核心规则：
1. 只能使用上下文中给出的 PostgreSQL 中间表，表名必须严格使用下文列出的物理表名称，禁止编造、猜测或使用任何上下文中未出现的表名。FROM 和 JOIN 后面的表名必须是物理表名或 WITH 定义的 CTE 名，不能是别名或虚构名称。
2. 只能生成 SELECT 或 WITH 查询，禁止任何写入、删除、建表、改表、授权等操作。
3. 表名和字段名必须使用英文/中文原名，并且全部用 PostgreSQL 双引号包裹，例如 "voc_3"."用户情感"。
4. intent 取值为 simple_query | chart | report | clarify，选择逻辑参见下方示例。
5. chart_spec 仅在 intent 为 chart 时必填。dimension 必须是 SQL 查询结果中的字段名。
6. SQL 中日期间字段：按年用 TO_CHAR(字段, 'YYYY-') AS year；按月用 TO_CHAR(字段, 'YYYY-MM') AS month；按天用 TO_CHAR(字段, 'MM-DD') AS day。
7. 如果用户未指定时间范围，默认按过去一年过滤：${DEFAULT_REPORT_DATE_RANGE.start} 到 ${DEFAULT_REPORT_DATE_RANGE.end}。如果用户明确说了时间（如"上个月"、"最近三个月"），则按用户指定的来。
8. simple_query 和 chart 意图的 SQL 必须显式包含 LIMIT ${DEFAULT_REPORT_SQL_LIMIT}；如果用户指定了更小的 TopN/limit，则使用用户指定值。
9. 表上下文中的前 10 行样例和字段值示例只用于理解字段含义，不代表全量数据值域。禁止因为样例里没有出现某个车系、车型、标签、渠道或意图值，就判断该值“不存在”。用户给出具体业务值时，应生成 SQL 去验证和筛选；只有 SQL 执行结果为空时，才能说明未查询到数据。
10. 用户要求“报告、竞品分析、围绕多个维度、词云、分布”等综合分析时，即使样例中没有出现用户点名的车系/车型，也应优先归类为 report 并生成查询计划，不要直接 clarify。

=== 意图识别基础原则 ===
基于用户输入的自然语言，判断需要返回数据样例对应的意图。
单一结果、单一数字 就是 simple_query 意图。
一张图包含多维度、多数字就是 chart 意图。
多图表、多维度、多数字就是 report 意图。


=== 意图判别 Few-shot 示例 ===

chart 与 report 的核心分界线：
- 单一维度分布 → chart（一个图表即可回答）
- 多维度交叉 + 筛选条件 → report（需要多图表 + 综合分析）
- "XX分布"但只有一个维度 → chart
- "XX分布，以及YY分布，和ZZ分布"多个维度并列 → report

【simple_query - 简单问答】判别特征：单一数值、单条记录、列表查看，无分组/分布/趋势诉求。
正例：
- "上个月投诉总量是多少" → 单一数值统计
- "负面情感的用户有多少" → 计数筛选，直接给数字
- "查询一下条件X为Y的记录" → 列表查询，无需图表

负例（这些不应归为 simple_query）：
- "统计各XX的投诉数量" → 有分组诉求，应走 chart
- "看看上个月每天的趋势" → 有时间序列，应走 chart
- "分析为什么XX增多" → 有根因诉求，应走 report
- "车系D的负面反馈主要集中在哪些问题" → 有筛选 + 分组集中分布，应走 chart
- "XX集中在哪些YY" → 带条件的集中分布，应走 chart

【chart - 图表可视化】判别特征：单一维度的分组分布、占比比例、排名排行、时间趋势、对比差异。
图表类型选择逻辑（核心原则：维度数量 ≤ 10 优先饼图，> 10 用柱状图避免饼图标注拥挤）：
- 分布/排名/排行/对比，且 dimension 分组数 ≤ 10 → pie
- 分布/排名/排行/对比，且 dimension 分组数 > 10 → bar
- 占比/比例/份额/构成，且 dimension 分组数 ≤ 10 → donut
- 占比/比例/份额/构成，且 dimension 分组数 > 10 → bar
- 按时间粒度变化/趋势/序列 → line
- 多系列交叉对比，同一维度下多个指标叠加展示 → stackedBar。典型场景：用户问"XX和YY在哪些ZZ上占比最高"，即需要按维度(Z轴)分组展示多系列(XX/YY两个指标)的堆叠对比。SQL 中应对应 GROUP BY 维度，并用 CASE WHEN 或 FILTER 分别聚合每个系列。

stackedBar 示例：
- "蓝牙钥匙和生锈问题占比最高的车辆" → stackedBar，dimension=车系/list_name/vehicle，series=["蓝牙钥匙","生锈问题"]，SQL 需 GROUP BY 车系并用 SUM(CASE WHEN 问题类型='蓝牙钥匙' THEN 1 ELSE 0 END) 聚合
- "不同车系的高压系统和电池衰减投诉对比" → stackedBar，dimension=车系，series=["高压系统","电池衰减"]
- "各渠道的正面和负面反馈占比" → stackedBar，dimension=渠道/source/data_source，series=["正面","负面"]
- "各区域的三个问题类型分布" → stackedBar，dimension=区域/province/area，series=[问题类型值]

同一个"分布"语义的多种自然表达，均应识别为 chart, pie：
- "不同XX的分布是怎样的"
- "各XX的分布情况"
- "帮我看看XX的分布"
- "XX的分布构成什么样的"
- "能不能展示一下XX的分布"

同一个"集中"语义的多种自然表达，均应识别为 chart, pie：
- "XX主要集中在哪些YY"
- "XX主要分布在哪些YY上"
- "XX的问题都集中在什么方面"
- "XX大部分集中在哪几类YY"

同一个"占比"语义的多种自然表达，均应识别为 chart, pie/donut：
- "各个XX的占比"
- "帮我看看XX各占多少比例"
- "XX的构成是什么样的"
- "各XX所占份额"
- "XX中XX/XX/XX的比例"

同一个"趋势"语义的多种自然表达，均应识别为 chart, line：
- "最近N个月的XX趋势"
- "过去一年的XX月度变化"
- "按月统计XX数量"
- "看看XX的时间变化情况"

同一个"排名"语义的多种自然表达，均应识别为 chart, pie（TopN 通常 ≤ 10）：
- "XX排名前10的XX"
- "TopN XX排行"
- "XX最高的几类是什么"

同一个"对比"语义的多种自然表达，均应识别为 chart, pie（对比类通常 ≤ 10）：
- "不同XX的XX对比"
- "各XX的XX差异比较"
- "对比一下不同XX的情况"

chart 负例（这些不应走 chart）：
- "最近一条XX是什么内容" → 单一记录，simple_query
- "分析一下为什么XX增多" → 需要根因分析，report
- "XX是多少" → 单一数值，simple_query
- "查询情感为负面的车系分布，以及集中在哪些省份，和渠道分布在哪些" → 多维度交叉分析，report
- "XX的分布、YY的分布和ZZ的分布" → 同时要求多个维度的分布，report

【report - 复杂报告】判别特征：根因分析、深度洞察、周报月报、多维度交叉、带筛选条件的多维分析。
正例：
- "分析上月XX异常问题" → 需要多维度根因分析
- "生成本周XX分析周报" → 综合报告
- "为什么最近XX变多了，深层次原因是什么" → 根因分析
- "给我一个Q1的XX综合洞察报告" → 综合报告
- "查询情感为负面的车系分布，以及集中在哪些省份，和渠道分布在哪些" → 多维度交叉，需要多个图表综合分析
- "筛选XX条件，看看不同YY的分布和ZZ的构成以及AA的趋势" → 带筛选 + 多维度 + 趋势，report

report 负例：
- "各XX对比" → 单一维度，chart 即可
- "帮我分析一下这个数据" → 过于模糊，若仅含数字则归 simple_query
- "XX的分布是怎样的" → 只有一个维度，chart

【clarify - 需要澄清】
正例：
- "分析一下XX" → 表中无XX字段，无法回答
- "帮我预测下个月XX" → 预测类，非 SQL 查询能力

=== 输出格式 ===

只输出 JSON，不要 Markdown，不要解释。
{
  "intent": "simple_query" | "chart" | "report" | "clarify",
  "sql": "SELECT ...",
  "reason": "一句话说明判别理由",
  "chart_spec": {
    "title": "图表标题",
    "type": "bar" | "line" | "donut" | "pie" | "stackedBar",
    "dimension": "维度字段名",
    "measure": "指标说明（如数量、占比）",
    "series": ["系列1", "系列2"]
  },
  "clarifying_question": "需要用户补充的问题"
}`;

const ANSWER_SYSTEM_PROMPT = `你是「VOC 智能问数」的数据分析专家，拥有 15 年汽车行业数据分析经验，精通研产供销服五大核心业务，深度理解 VoC 客户之声系统。

你会收到用户问题、已执行的 SQL、以及查询结果的统计摘要和详细数据。请基于查询结果回答，不要编造不存在的数据、字段、车型、标签或业务结论。

回答要求：
1. **直接结论先行**：首句给出核心数字和结论，让用户 5 秒内得到答案。
2. **关键数字加粗**：所有核心数字、指标、关键实体必须使用 ** 包裹，例如”共查询到 **1,247 条** 记录”、”**电池亏电** 问题占比最高（**34.2%**）”。
3. **分层解读**：
   - 若结果是单一数值：直接给结论 + 业务含义解读
   - 若结果是多行列表：先总览数据规模，再分析 Top 项的集中度和趋势，最后给出业务建议
4. **业务语言表达**：使用”投诉集中在””负面率上升””用户关注度高”等业务表达，而非”查询结果共 N 行”等技术描述。
5. **数据为空时**：说明未查询到匹配数据，并提示可能的筛选条件或时间范围问题，建议用户调整。
6. **极简输出**：2-5 条要点即可，不冗余堆砌。最后附一个 \`\`\`sql 代码块展示执行的 SQL，不要加”已执行 SQL”等文字标题。
7. **只输出结论和 SQL 代码块**，禁止输出”数据来源”、”根据查询结果”等无关描述。`;

const FOLLOW_UP_SYSTEM_PROMPT = `你是「VOC 智能问数」的追问建议生成器。

你会收到已选数据表的字段、业务备注、前 10 行数据样例、用户问题和当前回答。
请生成 3 个适合继续问数的中文追问。

必须遵守：
1. 追问必须严格基于当前数据表真实字段和样例内容，不要臆造不存在的字段、业务对象或维度。
2. 如果样例和字段里没有 SKU、订单、销售额、区域等概念，禁止出现这些词。
3. 优先围绕 VOC 客户之声常见分析：负面原因、问题类型、用户情绪、关注场景、渠道、时间趋势、车型/产品等，但必须以表字段为准。
4. 每条不超过 18 个中文字符。

只输出 JSON，不要 Markdown，不要解释。JSON 格式：
{
  "followUps": ["追问1", "追问2", "追问3"]
}`;

const REPORT_PLANNER_SYSTEM_PROMPT = `你是「VOC 智能问数」的智能报告规划器。

你的任务是把用户的复杂问数需求转成可执行的报告计划。当前日期按用户上下文为 2026-05-26。

必须遵守：
1. 只能使用上下文中给出的 PostgreSQL 中间表和字段。
2. 必须生成一条只读 PostgreSQL SQL，且只能是 SELECT 或 WITH。
3. 表名和字段名必须使用双引号包裹，例如 "pg智能问数中间表"."车型"。
4. SQL 应先完成明确筛选，例如时间范围、查询条件、标签条件、车型条件；不要在 SQL 里做复杂文本根因分析。
5. 报告计划必须覆盖：意图识别原因、SQL 查询、分析步骤、根因字段、图表列表。
6. 图表优先使用用户点名的维度；如果用户说“车型、四级标签”，图表里必须覆盖这两个维度。
7. 如果用户未指定日期，默认按过去一年过滤：${DEFAULT_REPORT_DATE_RANGE.start} 到 ${DEFAULT_REPORT_DATE_RANGE.end}。
8. SQL 必须显式包含 LIMIT ${DEFAULT_REPORT_SQL_LIMIT}，如果用户指定了更小的 TopN/limit，则使用用户指定值。
9. 图表类型由你根据字段类型、数据形态和业务表达目标选择，参考经验：标签构成可以用 pie 实心饼图，车型/车系排行可以用 bar 柱状图，时间维度趋势适合用 line 折线图，多列明细数据适合用 table。
10. 分布/排行类图表默认 limit 必须为 ${DEFAULT_REPORT_CHART_LIMIT}；只有用户明确写出 topN、Top N、前N、前 N 名等数量时，图表 limit 才使用用户指定值，禁止默认输出 Top20。
11. 前 10 行样例和字段值示例不是全量值域。禁止因为样例中没有出现某个车系、车型、标签、渠道或意图值，就判断该值不存在；应在 SQL 中按用户点名值筛选或用 ILIKE/IN 做候选匹配，执行后再根据结果判断。
12. 用户点名多个车系/车型做竞品分析时，必须保留这些点名对象作为筛选条件或分组条件，不能因为样例未覆盖而要求用户重新指定。
13. 用户点名多个车系/车型进行竞品分析，并要求围绕同一维度（如五级标签、三级渠道、意图、月份）对比时，禁止为每个车系/车型分别生成两张相同类型图表；必须生成一张 stackedBar 多系列对比图。dimension 使用被分析维度（如五级标签/三级渠道），seriesField 使用车系/车型字段，series 填用户点名对象（如 ["车系A", "车系B"]）。
14. 多车系/车型对比 SQL 必须保留 seriesField 和 dimension 两类字段；可返回原始明细让系统聚合，也可 GROUP BY seriesField + dimension 并输出数量。不要只按单个车系拆成多段独立图表。

只输出 JSON，不要 Markdown，不要解释。JSON 格式：
{
  "title": "报告标题",
  "reason": "为什么归类为生成报告",
  "sql": "SELECT ...",
  "timeRange": { "field": "发声时间", "label": "过去一年", "start": "2025-05-26", "end": "2026-05-26" },
  "filters": [{ "field": "通用四级标签", "operator": "=", "value": "车辆起动异常" }],
  "analysisSteps": [
    { "id": "intent", "title": "意图识别", "description": "识别为生成报告" }
  ],
  "rootCause": { "field": "原声片段", "keywords": ["启动机", "蓄电池"] },
  "charts": [
    { "id": "model_distribution", "title": "车型分布", "type": "bar", "dimension": "车型", "measure": "数量", "limit": 10 },
    { "id": "tag_competitor_compare", "title": "车系五级标签对比", "type": "stackedBar", "dimension": "五级标签", "seriesField": "车系", "series": ["车系A", "车系B"], "measure": "数量", "limit": 10 },
    { "id": "tag_distribution", "title": "四级标签分布", "type": "pie", "dimension": "通用四级标签", "measure": "数量", "limit": 10 }
  ],
  "narrativeFocus": ["问题规模", "根因排序", "车型集中度", "改进建议"]
}`;

const REPORT_WRITER_SYSTEM_PROMPT = `你是一个从业20年的汽车行业数据分析师，拥有敏锐的数据洞察力，精通研产供销服五大汽车核心业务，深度理解 VoC 客户之声系统。
你同时是「VOC 智能问数」的报告撰写专家。

你会收到用户问题、报告计划、当前数据源字段、查询统计、图表数据和根因关键词。请根据以下数据进行业务分析，只基于这些结构化结果生成报告文案，不要编造没有出现的数据、字段、车型、标签、渠道或业务结论。
所有总结、图表解读和处理建议都必须能回扣到当前数据表中的 metrics、charts、rootCauses 或 filters；没有数据支撑时要明确写成"需要进一步抽样/复核"，不要给确定性结论。

重要约束：
- 只进行数据驱动的业务分析，不要对系统/工具本身做带有价值的评判。
- 分析结论应聚焦于业务洞察（如"用户期待某车型投诉集中"、"用户期待在某渠道负面反馈上升"、"用户期待产品增加什么功能和配置"），而非系统用途评价。
- 保持正向、专业的分析态度，结论应具有建设性。

字段语义：
- executiveSummary：报告头部的全文摘要，在图表之前展示。应概括整体数据轮廓（样本量、时间范围、核心主题），让读者30秒内了解报告全貌。100-180字。
- finalSummary.summary：报告尾部的终结总结，在图表和深度分析之后展示。应提炼分析结论和关键洞察。80-150字。

格式强调规范：
- 在 executiveSummary、chartExplanations[].explanation、finalSummary.summary、analysisGroups[].points、recommendations 所有文案字段中，必须使用 ** 包围关键数字、核心指标、重要结论。例如：**348条**、**负面率38.7%**、**车机网络异常**、**华东区域**。每个字段至少 2-3 处加粗。

模型深度分析要求：
1. finalSummary.analysisGroups 必须根据实际数据动态命名，不要固定写“优点、缺点、建议”。
2. 只有当数据确实呈现优势/不足时，才可以使用类似标题；根因报告更适合使用“关键集中点、根因线索、异常风险、复核方向、业务影响”等标题。
3. 每个 analysisGroups 2-4 条，整体 2-4 组。

只输出 JSON，不要 Markdown，不要解释。JSON 格式：
{
  "executiveSummary": "报告头部的全文摘要，概括整体数据轮廓，100-180字，让读者快速了解报告全貌",
  "sections": [
    {
      "heading": "核心发现",
      "narrative": "本节说明",
      "insights": ["洞察1", "洞察2"],
      "chartIds": ["chart_id"],
      "tableIds": ["table_id"]
    }
  ],
  "chartExplanations": [
    { "chartId": "chart_id", "title": "图表标题", "explanation": "针对该图表的业务解释，说明集中点、异常点或趋势" }
  ],
  "finalSummary": {
    "summary": "最终简要摘要",
    "analysisGroups": [
      { "title": "模型根据实际数据自拟的小标题，例如用户关注点/集中场景/根因分析/异常风险/复核方向", "points": ["分析点1", "分析点2"] }
    ],
    "positives": [],
    "risks": [],
    "actions": []
  },
  "recommendations": ["建议1", "建议2", "建议3"]
}`;

const PYTHON_ANALYST_SYSTEM_PROMPT = `你是「VOC 智能问数」的 Python pandas 数据分析代码生成器。

你只生成可执行 Python 代码，不要 Markdown，不要解释。代码会在 Node.js 创建的临时目录中运行，并且已有这些常量：
- INPUT_CSV：SQL 查询结果 CSV 路径
- PLAN_JSON：报告计划 JSON 路径
- OUTPUT_JSON：必须写入的分析结果 JSON 路径

必须遵守：
1. 使用 pandas 读取 INPUT_CSV，并做数据清洗、统计、根因分析和图表数据准备。
2. 可以 import pandas、numpy、json、re、datetime、collections。
3. 不要连接数据库，不要修改源表，不要访问网络，不要读取 INPUT_CSV/PLAN_JSON 之外的数据文件。
4. 必须写入 OUTPUT_JSON，且 ensure_ascii=False。
5. 输出 JSON 必须包含 metrics、charts、tables、rootCauses 四个字段。
6. charts 里的每个对象必须是：
   { "id": "...", "title": "...", "subtitle": "...", "type": "bar|pie|donut|line|stackedBar", "dimension": "...", "measures": ["数量"], "data": [{ "<dimension>": "...", "数量": 1, "占比": 10.0 }] }
   stackedBar 必须用 measures 表达多系列，例如 "measures": ["车系A", "车系B"]，data 每行必须包含维度值和每个系列的数值：{ "五级标签": "标签1", "车系A": 12, "车系B": 8 }。
7. rootCauses 里的每个对象必须是：
   { "keyword": "...", "count": 1, "ratio": 10.0, "evidence": ["原声片段样例"] }
8. 分布类明细不要输出 tables，优先输出 pie 实心饼图或 bar 柱状图；根因关键词不要输出 tables，输出 rootCauses 即可，系统会转成柱状图。
9. 分布/排行类图表 data 默认只输出 Top ${DEFAULT_REPORT_CHART_LIMIT}；只有用户问题明确写出 topN、Top N、前N、前 N 名等数量时，才输出用户指定数量，禁止默认输出 Top20。
10. 如果数据为空，也要输出空数组和命中记录为 0 的 metric。
11. 用户点名多个车系/车型对比同一维度时，禁止分别输出“车系A维度分布”和“车系B维度分布”两张重复图；必须输出一张 stackedBar 对比图。

只输出 Python 代码。`;

interface SmartTableColumn {
  name?: string;
  type?: string;
  sourceName?: string;
  source_name?: string;
  comment?: string;
}

interface SmartTableContextRow extends QueryResultRow {
  id: string;
  name: string;
  physical_table_name: string;
  source_type: string;
  source_table_name: string | null;
  file_name: string | null;
  remark: string | null;
  columns: SmartTableColumn[];
  row_count: number;
}

interface SmartTableContext extends SmartTableContextRow {
  sample_rows: Array<Record<string, unknown>>;
  value_examples: Record<string, string[]>;
}

interface ChartSpec {
  title: string;
  type: 'bar' | 'line' | 'donut' | 'pie' | 'stackedBar';
  dimension: string;
  measure: string;
  series?: string[];
}

interface SqlPlan {
  intent: 'simple_query' | 'chart' | 'report' | 'clarify';
  sql?: string;
  reason?: string;
  clarifying_question?: string;
  chart_spec?: ChartSpec;
}

interface ReportPlanFilter {
  field?: string;
  operator?: string;
  value?: string;
}

interface ReportPlanChart {
  id?: string;
  title?: string;
  type?: ReportChartType;
  dimension?: string;
  measure?: string;
  seriesField?: string;
  series?: string[];
  limit?: number;
}

interface ReportPlanStep {
  id?: string;
  title?: string;
  description?: string;
}

interface ReportPlan {
  title?: string;
  reason?: string;
  sql?: string;
  timeRange?: {
    field?: string;
    label?: string;
    start?: string;
    end?: string;
  };
  filters?: ReportPlanFilter[];
  analysisSteps?: ReportPlanStep[];
  rootCause?: {
    field?: string;
    keywords?: string[];
  };
  charts?: ReportPlanChart[];
  narrativeFocus?: string[];
}

interface ReportArtifacts {
  metrics: SmartReportMetric[];
  charts: SmartReportChart[];
  tables: SmartReportTable[];
  rootCauses: SmartReportRootCause[];
}

interface GeneratedPythonAnalysis {
  code: string;
  artifacts: ReportArtifacts;
  pythonUsage?: DeepSeekUsage | null;
}

interface ReportNarrative {
  executiveSummary: string;
  sections: SmartReportSection[];
  chartExplanations: SmartReportChartExplanation[];
  recommendations: string[];
  finalSummary: SmartReportFinalSummary;
}

interface SmartReportBuildResult {
  content: string;
  thinking: string;
  sql: string;
  pythonCode?: string;
  report?: SmartReport;
  followUps: string[];
  plan: ReportPlan;
  isEmpty?: boolean;
  tokenUsage?: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

type ReportProgressCallback = (text: string, payload?: Record<string, unknown>) => void;

interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface StoredChatMessageRow extends QueryResultRow {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking: string | null;
  sql_text: string | null;
  sources: unknown;
  chart: unknown;
  metadata: unknown;
  created_at: Date;
}

interface StoredChatArtifactRow extends QueryResultRow {
  id: string;
  session_id: string;
  message_id: string | null;
  artifact_type: ArtifactType;
  title: string | null;
  summary: string | null;
  sql_text: string | null;
  filters: unknown;
  dimensions: unknown;
  measures: unknown;
  data: unknown;
  metadata: unknown;
  created_at: Date;
  artifact_index: number | string;
  artifact_count: number | string;
}

type ArtifactType = 'simple_query' | 'chart' | 'report';

interface InsertChatArtifactInput {
  sessionId: string;
  messageId: string;
  artifactType: ArtifactType;
  title?: string;
  summary?: string;
  sqlText?: string;
  filters?: unknown;
  dimensions?: unknown[];
  measures?: unknown[];
  data?: unknown;
  metadata?: Record<string, unknown>;
}

interface ConversationContext {
  recentMessages: StoredChatMessageRow[];
  recentArtifacts: StoredChatArtifactRow[];
  artifactSummary: string;
}

interface KnowledgeItemRow extends QueryResultRow {
  id: string;
  title: string;
  category: string;
  standard_term: string | null;
  aliases: unknown;
  keywords: unknown;
  content: string;
  field_name: string | null;
  formula: string | null;
  business_domain: string | null;
  applicable_intents: unknown;
  priority: number;
  status: string;
}

interface KnowledgeCandidateRow extends KnowledgeItemRow {
  term_score: string | number;
  matched_terms: unknown;
}

interface RelevantKnowledgeItem {
  id: string;
  title: string;
  category: string;
  standardTerm: string;
  aliases: string[];
  keywords: string[];
  content: string;
  fieldName: string;
  formula: string;
  priority: number;
  termScore: number;
  matchedTerms: string[];
  score: number;
}

export async function POST(request: NextRequest) {
  let sessionId: string | undefined;
  let contextWarning = false;
  try {
    const { query, isReasoning, smartTableIds, conversationId } = await request.json();

    if (!query || typeof query !== 'string') {
      return new Response(JSON.stringify({ error: 'query is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const selectedSmartTableIds = Array.isArray(smartTableIds)
      ? smartTableIds.map((id) => String(id)).filter(Boolean)
      : [];

    if (selectedSmartTableIds.length === 0) {
      return sseText('请先在首页「选取数据表」中选择至少一张智能问数表，然后再提问。');
    }

    if (!isPostgresConfigured()) {
      return sseText('当前未配置 PostgreSQL，暂时无法执行智能问数查询。');
    }

    const tables = await loadSmartTableContexts(selectedSmartTableIds);
    if (tables.length === 0) {
      return sseText('未找到可用的智能问数表，请确认数据表已创建并处于在线状态。');
    }

    sessionId = await ensureChatSession({
      conversationId: typeof conversationId === 'string' ? conversationId : undefined,
      userQuery: query,
      tables,
    });

    const conversationContext = await loadConversationContext(sessionId);
    const relevantKnowledge = await loadRelevantKnowledge(query, tables);
    const businessKnowledgePrompt = buildBusinessKnowledgePrompt(relevantKnowledge);

    await insertChatMessage({
      sessionId,
      role: 'user',
      content: query,
      sources: tables.map((table) => table.name),
      metadata: {
        selectedTableIds: tables.map((table) => table.id),
        selectedTableNames: tables.map((table) => table.name),
      },
    });

    const tableContext = buildTableContextPrompt(tables);
    const contextMessages = buildConversationContextMessages(conversationContext, query);
    const reasoningEnabled = isReasoning === true || await shouldEnableReasoningForFollowUp(query, contextMessages);
    const plannerPrompt = [
      tableContext,
      businessKnowledgePrompt,
      `用户问题：${query}`,
    ].filter(Boolean).join('\n\n');

    const fullMessages: DeepSeekMessage[] = [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      ...contextMessages,
      { role: 'user', content: plannerPrompt },
    ];
    const contextChars = estimateContextChars(fullMessages);
    contextWarning = contextChars > CONTEXT_WARNING_CHARS;

    const { content: planText, usage: planUsage } = await callDeepSeek(
      fullMessages,
      { thinking: reasoningEnabled, reasoningEffort: 'high', temperature: 0.1 }
    );

    let plan = parseSqlPlanOrFallback(planText, query);
    if (shouldSuppressSampleBasedClarify(plan, query)) {
      plan = createFallbackSqlReportPlan(query, tables);
    }
    if (plan.intent === 'report') {
      return streamSmartReportResponse({
        sessionId,
        userQuery: query,
        contextMessages,
        tables,
        tableContext,
        businessKnowledgePrompt,
        reasoningEnabled,
        intentPlan: plan,
        contextWarning,
      });
    }
    if (plan.intent === 'chart') {
      return streamChartResponse({
        sessionId,
        userQuery: query,
        tables,
        reasoningEnabled,
        intentPlan: plan,
        contextWarning,
        hasConversationContext: conversationContext.recentArtifacts.length > 0,
        businessKnowledgePrompt,
      });
    }
    if (plan.intent === 'clarify') {
      const content = plan.clarifying_question || plan.reason || '这个问题需要补充筛选条件后才能查询。';
      await insertChatMessage({
        sessionId,
        role: 'assistant',
        content,
        sources: tables.map((table) => table.name),
        metadata: { intent: 'clarify' },
      });
      return sseText(content, { sessionId, contextWarning });
    }

    const safeSql = validateAndNormalizeSql(plan.sql || '', tables.map((table) => table.physical_table_name));
    const queryRows = await executeReadOnlySql(safeSql);
    const answerPrompt = buildAnswerPrompt({
      userQuery: query,
      sql: safeSql,
      rows: queryRows,
      tables,
      businessKnowledgePrompt,
    });

    const { content: answer, usage: answerUsage } = await callDeepSeek(
      [
        { role: 'system', content: ANSWER_SYSTEM_PROMPT },
        { role: 'user', content: answerPrompt },
      ],
      { thinking: reasoningEnabled, reasoningEffort: 'high', temperature: 0.2 }
    );

    const answerParts = extractAnswerParts(answer);
    const { followUps, usage: followUpsUsage } = await generateFollowUps({
      userQuery: query,
      answer: answerParts.content || answer,
      tables,
      businessKnowledgePrompt,
    });
    const assistantMessageId = await insertChatMessage({
      sessionId,
      role: 'assistant',
      content: answerParts.content || answer,
      thinking: undefined,
      sqlText: answerParts.sql || safeSql,
      sources: tables.map((table) => table.name),
      metadata: {
        intent: 'simple_query',
        rowCount: queryRows.length,
        physicalTables: tables.map((table) => table.physical_table_name),
        followUps,
        tokenUsage:
          planUsage || answerUsage || followUpsUsage
            ? {
                promptTokens: (planUsage?.prompt_tokens ?? 0) + (answerUsage?.prompt_tokens ?? 0) + (followUpsUsage?.prompt_tokens ?? 0),
                completionTokens: (planUsage?.completion_tokens ?? 0) + (answerUsage?.completion_tokens ?? 0) + (followUpsUsage?.completion_tokens ?? 0),
                totalTokens: (planUsage?.total_tokens ?? 0) + (answerUsage?.total_tokens ?? 0) + (followUpsUsage?.total_tokens ?? 0),
              }
            : null,
      },
    });
    await insertChatArtifact({
      sessionId,
      messageId: assistantMessageId,
      artifactType: 'simple_query',
      title: buildSessionTitle(query),
      summary: answerParts.content || answer,
      sqlText: answerParts.sql || safeSql,
      filters: buildSqlFilterArtifact(safeSql),
      data: queryRows.slice(0, 50).map((row) => sanitizeRow(row, 320)),
      metadata: {
        rowCount: queryRows.length,
        physicalTables: tables.map((table) => table.physical_table_name),
        followUps,
      },
    });

    return sseText(answer, { sessionId, followUps, contextWarning });
  } catch (error) {
    const message = error instanceof Error ? error.message : '未知错误';
    const content = `抱歉，智能问数执行失败：${message}`;
    if (sessionId) {
      await insertChatMessage({
        sessionId,
        role: 'assistant',
        content,
        metadata: { intent: 'error' },
        status: 'failure',
        errorMessage: message,
      }).catch(() => undefined);
    }
    return sseText(content, sessionId ? { sessionId, contextWarning } : undefined);
  }
}

function streamChartResponse({
  sessionId,
  userQuery,
  tables,
  reasoningEnabled,
  intentPlan,
  contextWarning,
  hasConversationContext,
  businessKnowledgePrompt,
}: {
  sessionId: string;
  userQuery: string;
  tables: SmartTableContext[];
  reasoningEnabled: boolean;
  intentPlan: SqlPlan;
  contextWarning: boolean;
  hasConversationContext: boolean;
  businessKnowledgePrompt: string;
}): Response {
  const encoder = new TextEncoder();
  const sourceNames = tables.map((table) => table.name);
  const chartSpec = intentPlan.chart_spec;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      const progress = (text: string, phase: string = 'thinking') => {
        send({ content: text, progressPhase: phase });
      };

      try {
        send({ sessionId, contextWarning });
        progress(`意图识别：生成图表（chart）\n`);
        progress(`理解说明：${intentPlan.reason || '用户需要可视化图表分析。'}\n`);
        if (hasConversationContext) {
          progress(`上下文承接：已读取本会话上一轮结构化结果，优先沿用相关筛选、图表点位和实体线索。\n`);
        }
        progress(`确认数据源：${sourceNames.join('、') || '已选智能问数表'}\n`);

        if (!intentPlan.sql) {
          throw new Error('图表意图未生成 SQL 查询');
        }

        progress(`SQL处理：正在生成只读查询...\n`, 'sql');
        const safeSql = validateAndNormalizeSql(intentPlan.sql, tables.map((table) => table.physical_table_name));
        progress(`SQL处理：查询已生成，正在执行...\n`, 'sql');
        const queryRows = await executeReadOnlySql(safeSql);
        progress(`SQL处理：查询完成，命中 ${queryRows.length} 条记录\n`, 'sql');

        if (queryRows.length === 0) {
          const emptyContent = '查询结果为空，无法生成图表。请调整筛选条件后重试。';
          await insertChatMessage({
            sessionId,
            role: 'assistant',
            content: emptyContent,
            sqlText: safeSql,
            sources: sourceNames,
            metadata: { intent: 'chart' },
          });
          send({ content: emptyContent, sql: safeSql });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        const chartData = buildChartDataFromRows(queryRows, chartSpec, userQuery);
        const { analysis: rawAnalysis, usage: chartAnalysisUsage } = await generateChartAnalysis(userQuery, safeSql, chartData, chartSpec, reasoningEnabled, businessKnowledgePrompt);
        const analysisContent = rawAnalysis || buildFallbackChartAnalysis(chartData, queryRows.length);
        const { followUps, usage: followUpsUsage } = await generateFollowUps({
          userQuery,
          answer: analysisContent,
          tables,
          businessKnowledgePrompt,
        });

        const assistantMessageId = await insertChatMessage({
          sessionId,
          role: 'assistant',
          content: analysisContent,
          sqlText: safeSql,
          sources: sourceNames,
          metadata: {
            intent: 'chart',
            chart: chartData,
            followUps,
            tokenUsage:
              chartAnalysisUsage || followUpsUsage
                ? {
                    promptTokens: (chartAnalysisUsage?.prompt_tokens ?? 0) + (followUpsUsage?.prompt_tokens ?? 0),
                    completionTokens: (chartAnalysisUsage?.completion_tokens ?? 0) + (followUpsUsage?.completion_tokens ?? 0),
                    totalTokens: (chartAnalysisUsage?.total_tokens ?? 0) + (followUpsUsage?.total_tokens ?? 0),
                  }
                : null,
          },
        });

        await insertChatArtifact({
          sessionId,
          messageId: assistantMessageId,
          artifactType: 'chart',
          title: chartData.title,
          summary: analysisContent,
          sqlText: safeSql,
          filters: buildSqlFilterArtifact(safeSql),
          dimensions: chartSpec?.dimension ? [chartSpec.dimension] : [],
          measures: chartSpec?.measure ? [chartSpec.measure] : [],
          data: chartData,
          metadata: {
            chartSpec,
            rowCount: queryRows.length,
            followUps,
          },
        });

        send({
          content: analysisContent,
          sql: safeSql,
          chart: chartData,
          followUps,
        });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        const content = `图表生成失败：${message}`;
        await insertChatMessage({
          sessionId,
          role: 'assistant',
          content,
          sources: sourceNames,
          metadata: { intent: 'error' },
          status: 'failure',
          errorMessage: message,
        }).catch(() => undefined);
        send({ content });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

function formatChartLabel(raw: string, dimension: string): string {
  const isMonthDimension = /月|month/i.test(dimension);
  const isDayDimension = /日|天|day/i.test(dimension);

  const isoMatch = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const year = isoMatch[1];
    const month = parseInt(isoMatch[2], 10);
    const day = parseInt(isoMatch[3], 10);
    if (isMonthDimension) return `${year}/${month}`;
    if (isDayDimension) return `${month}/${day}`;
    return `${year}/${month}/${day}`;
  }

  const isoFullMatch = raw.match(/^\d{4}-\d{2}-\d{2}T/);
  if (isoFullMatch) {
    const date = new Date(raw);
    if (!isNaN(date.getTime())) {
      const y = date.getFullYear();
      const m = date.getMonth() + 1;
      const d = date.getDate();
      if (isMonthDimension) return `${y}/${m}`;
      if (isDayDimension) return `${m}/${d}`;
      return `${y}/${m}/${d}`;
    }
  }

  const slashMatch = raw.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})/);
  if (slashMatch) {
    const year = slashMatch[1];
    const month = parseInt(slashMatch[2], 10);
    const day = parseInt(slashMatch[3], 10);
    if (isMonthDimension) return `${year}/${month}`;
    if (isDayDimension) return `${month}/${day}`;
    return raw;
  }

  return raw;
}

function buildChartDataFromRows(
  rows: Array<Record<string, unknown>>,
  chartSpec: ChartSpec | undefined,
  userQuery: string,
): ChartData {
  const COLORS = ['#9adcc3', '#83a7ee', '#b69aef', '#83cbdf', '#e4b494', '#f0d4c3', '#d9c6f8', '#bde5f0'];
  const title = chartSpec?.title || '数据分析图表';
  const chartType = chartSpec?.type || 'bar';
  const dimension = chartSpec?.dimension;
  const measure = chartSpec?.measure;

  const keys = Object.keys(rows[0] || {});
  const dimKey = dimension && keys.includes(dimension) ? dimension : keys[0];

  if (chartType === 'stackedBar') {
    const seriesKeys = chartSpec?.series && chartSpec.series.length > 0
      ? chartSpec.series.filter((k) => keys.includes(k))
      : keys.filter((k) => {
          if (k === dimKey || k === 'name') return false;
          const v = rows[0]?.[k];
          return typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)));
        });

    const seriesLabels = seriesKeys.length > 0 ? seriesKeys : ['数量'];

    const allData: ChartData['data'] = rows.map((row, index) => {
      const rawName = row[dimKey];
      const name = formatChartLabel(String(rawName ?? `项${index + 1}`), chartSpec?.dimension || '');
      const entries: ChartData['data'][number] = {
        name,
        value: 0,
        color: COLORS[index % COLORS.length],
        rawDimensionValue: String(rawName ?? ''),
      };
      let total = 0;
      for (const sk of seriesLabels) {
        const raw = row[sk];
        const num = typeof raw === 'number' ? raw : Number(raw) || 0;
        entries[sk] = num;
        total += num;
      }
      entries.value = total;
      return entries;
    });
    const data = allData.slice(0, 15);

    const subtitle = measure || `${dimKey} × ${seriesLabels.join(' / ')}`;

    return {
      title,
      subtitle,
      type: 'stackedBar',
      data,
      series: seriesLabels,
      summary: buildChartDataSummary(allData, data, dimKey, measure || seriesLabels.join(' / ')),
    };
  }

  const valKey = keys.length > 1
    ? (keys.find((k) => {
        const v = rows[0]?.[k];
        return typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)));
      }) || keys[1])
    : keys[0];

  const rawData = rows.map((row, index) => {
    const rawName = row[dimKey];
    const name = formatChartLabel(String(rawName ?? `项${index + 1}`), chartSpec?.dimension || '');
    const rawValue = row[valKey];
    const value = typeof rawValue === 'number' ? rawValue : Number(rawValue) || 0;
    return { name, value, color: COLORS[index % COLORS.length], rawDimensionValue: String(rawName ?? '') };
  });

  const isProportionChart = chartType === 'pie' || chartType === 'donut';
  const data = isProportionChart ? topNWithOther(rawData, 10) : rawData.slice(0, 30);
  const hiddenDetailValue = isProportionChart
    ? [...rawData].sort((a, b) => b.value - a.value).slice(10).reduce((sum, item) => sum + item.value, 0)
    : undefined;
  const hiddenDetailGroups = isProportionChart ? Math.max(rawData.length - 10, 0) : undefined;

  const subtitle = measure || `${dimKey} × ${valKey}`;

  return {
    title,
    subtitle,
    type: chartType,
    data,
    summary: buildChartDataSummary(rawData, data, dimKey, String(valKey || measure || '数量'), {
      hiddenValue: hiddenDetailValue,
      hiddenGroups: hiddenDetailGroups,
    }),
  };
}

type ChartDataPoint = { name: string; value: number; color: string };

function buildChartDataSummary(
  allData: Array<{ value: number }>,
  displayedData: Array<{ value: number }>,
  dimensionName: string,
  measureName: string,
  options: { hiddenValue?: number; hiddenGroups?: number } = {},
): NonNullable<ChartData['summary']> {
  const totalValue = allData.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
  const displayedValue = displayedData.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
  const totalGroups = allData.length;
  const displayedGroups = displayedData.length;
  const hiddenGroups = options.hiddenGroups ?? Math.max(totalGroups - displayedGroups, 0);

  return {
    totalValue,
    displayedValue,
    hiddenValue: options.hiddenValue ?? Math.max(totalValue - displayedValue, 0),
    totalGroups,
    displayedGroups,
    hiddenGroups,
    isTruncated: hiddenGroups > 0,
    dimensionName,
    measureName,
  };
}

function topNWithOther(data: ChartDataPoint[], n: number): ChartDataPoint[] {
  if (data.length <= n) return data;
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const top = sorted.slice(0, n);
  const otherSum = sorted.slice(n).reduce((sum, item) => sum + item.value, 0);
  if (otherSum > 0) {
    top.push({ name: '其他', value: otherSum, color: '#cbd5e1' });
  }
  return top;
}

function computeChartStats(chartData: Pick<ChartData, 'title' | 'type' | 'data' | 'summary'>): string {
  const { data } = chartData;
  if (!data || data.length === 0) return '无数据';

  const summary = chartData.summary;
  const total = summary?.totalValue ?? data.reduce((sum, d) => sum + (d.value || 0), 0);
  const count = summary?.totalGroups ?? data.length;
  const displayedValue = summary?.displayedValue ?? data.reduce((sum, d) => sum + (d.value || 0), 0);
  const displayedGroups = summary?.displayedGroups ?? data.length;
  const hiddenValue = summary?.hiddenValue ?? Math.max(total - displayedValue, 0);
  const hiddenGroups = summary?.hiddenGroups ?? Math.max(count - displayedGroups, 0);
  const sorted = [...data].sort((a, b) => (b.value || 0) - (a.value || 0));
  const maxVal = sorted[0]?.value || 0;

  const parts = [
    `完整 SQL 查询结果共 **${count}** 个维度，总量 **${total.toLocaleString()}**，最高 **${maxVal.toLocaleString()}**（Top1 占完整总量 **${total > 0 ? ((maxVal / total) * 100).toFixed(1) : '0'}%**）`,
  ];

  if (summary?.isTruncated) {
    parts.push(`图表仅展示 **${displayedGroups}** 个维度，展示合计 **${displayedValue.toLocaleString()}**；未展开 **${hiddenGroups}** 个维度，合计 **${hiddenValue.toLocaleString()}**。数据全貌和占比必须以完整总量 **${total.toLocaleString()}** 为准。`);
  }

  const topN = sorted.slice(0, 5);
  topN.forEach((d, i) => {
    const pct = total > 0 ? ((d.value / total) * 100).toFixed(1) : '0';
    parts.push(`Top${i + 1}：**${d.name}** — ${d.value.toLocaleString()}（占比 **${pct}%**）`);
  });

  const top3Sum = topN.slice(0, 3).reduce((s, d) => s + (d.value || 0), 0);
  const top3Pct = total > 0 ? ((top3Sum / total) * 100).toFixed(1) : '0';
  if (topN.length >= 3) {
    parts.push(`Top3 集中度：**${top3Pct}%**（前 3 项合计占完整总量 ${top3Pct}%）`);
  }

  return parts.join('\n');
}

const CHART_ANALYSIS_SYSTEM_PROMPT = `你是「VOC 智能问数」的数据分析专家，面向车企高管提供精要洞察，要求一眼能看到核心结论。

严格遵守以下输出格式：

**数据全貌**：1 句概括样本量 + 集中度特征，如"共 **N** 条负面反馈，Top3 问题集中度 **XX%**，长尾特征显著"。

**Top 核心发现**（2-3 条，每条独立成段，加粗标题）：
- 按占比从高到低排列，优先分析 Top1 和具有强关联性的问题组（如"发动机+起动异常"同属动力系统应合并分析）
- 每条含：数据事实（数量、占比）→ 业务影响 → 排查方向
- 如 Top1 是"其他/未分类"等笼统类别，重点指出数据采集问题

**行动建议**：1 条具体可落地的建议，不超过 2 句。

核心约束：
- 每条 Top 发现整段不超过 80 字，高管 10 秒内可扫完
- 关键数字必须用 ** 加粗
- 禁止编造字段、车型、标签
- 使用"动力系统""智能座舱""NVH""IQS"等专业术语`;

async function generateChartAnalysis(
  userQuery: string,
  sql: string,
  chartData: Pick<ChartData, 'title' | 'type' | 'data' | 'summary'>,
  chartSpec: ChartSpec | undefined,
  reasoningEnabled: boolean,
  businessKnowledgePrompt: string,
): Promise<{ analysis: string; usage: DeepSeekUsage | null }> {
  const dataSummary = computeChartStats(chartData);

  const prompt = `${businessKnowledgePrompt ? `${businessKnowledgePrompt}\n\n` : ''}用户问题：${userQuery}

图表标题：${chartData.title || chartSpec?.title || '数据分析图表'}
图表类型：${chartData.type || chartSpec?.type || 'bar'}

数据统计摘要：
${dataSummary}

请基于以上统计摘要，按格式输出：数据全貌（1句）→ Top3 核心发现（每条加粗标题+2-3句）→ 行动建议（1条）。数据全貌必须使用完整 SQL 查询总量，不允许使用图表截断后的展示合计作为总量。每条发现整段不超过 80 字，关键数字用 ** 加粗。`;

  const { content: answer, usage } = await callDeepSeek(
    [
      { role: 'system', content: CHART_ANALYSIS_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    { thinking: reasoningEnabled, reasoningEffort: 'high', temperature: 0.2 }
  );

  return { analysis: answer.trim(), usage };
}

function buildFallbackChartAnalysis(
  chartData: Pick<ChartData, 'title' | 'type' | 'data' | 'summary'>,
  totalRows: number,
): string {
  if (!chartData.data || chartData.data.length === 0) {
    return `共查询到 ${totalRows} 条记录，当前数据无法生成有效的图表分析。请检查筛选条件后重试。`;
  }
  const values = chartData.data.map((d) => d.value).filter((v) => typeof v === 'number' && !isNaN(v));
  if (values.length === 0) {
    return `图表展示了 ${chartData.data.length} 个维度的数据分布情况，建议查看具体数值进行业务判断。`;
  }
  const maxItem = chartData.data.reduce((a, b) => (a.value > b.value ? a : b));
  const minItem = chartData.data.reduce((a, b) => (a.value < b.value ? a : b));
  const avg = Math.round(values.reduce((s, v) => s + v, 0) / values.length);
  const chartTypeLabel = chartData.type === 'pie' || chartData.type === 'donut' ? '占比' : '分布';
  const summary = chartData.summary;
  const totalValue = summary?.totalValue ?? values.reduce((sum, value) => sum + value, 0);
  const overview = summary
    ? `完整查询共 ${summary.totalGroups} 个维度，总量 ${summary.totalValue}；图表展示 ${summary.displayedGroups} 个维度，展示合计 ${summary.displayedValue}${summary.isTruncated ? `，其余 ${summary.hiddenGroups} 个维度合计 ${summary.hiddenValue}` : ''}。`
    : `共查询到 ${totalRows} 条记录。`;

  return `${overview}${chartData.title}的${chartTypeLabel}情况如下：
- 最高值：${maxItem.name}（${maxItem.value}），最低值：${minItem.name}（${minItem.value}）
- 平均值：${avg}
- 完整总量口径：${totalValue}
以上结论由系统基于查询结果自动生成，仅供参考。`;
}

function streamSmartReportResponse({
  sessionId,
  userQuery,
  contextMessages,
  tables,
  tableContext,
  businessKnowledgePrompt,
  reasoningEnabled,
  intentPlan,
  contextWarning,
}: {
  sessionId: string;
  userQuery: string;
  contextMessages: DeepSeekMessage[];
  tables: SmartTableContext[];
  tableContext: string;
  businessKnowledgePrompt: string;
  reasoningEnabled: boolean;
  intentPlan: SqlPlan;
  contextWarning: boolean;
}): Response {
  const encoder = new TextEncoder();
  const sourceNames = tables.map((table) => table.name);

  const stream = new ReadableStream({
    async start(controller) {
      const send = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };
      const progress: ReportProgressCallback = (text, payload) => {
        const phase = payload?.progressPhase || 'thinking';
        send({ content: text, progressPhase: phase, ...payload });
      };

      try {
        send({ sessionId, contextWarning });
        progress(`意图识别：生成报告（${intentPlan.intent}）\n`);
        progress(`理解说明：${intentPlan.reason || '该问题需要执行数据查询、分析计算和可视化报告生成。'}\n`);
        progress(`确认数据源：${sourceNames.join('、') || '已选智能问数表'}\n`);

        const reportResult = await buildSmartReport({
          userQuery,
          contextMessages,
          tables,
          tableContext,
          businessKnowledgePrompt,
          reasoningEnabled,
          onProgress: progress,
        });

        if (reportResult.isEmpty) {
          progress(`${reportResult.content}\n`);
          await insertChatMessage({
            sessionId,
            role: 'assistant',
            content: reportResult.content,
            thinking: reportResult.thinking,
            sqlText: reportResult.sql,
            sources: sourceNames,
            metadata: { intent: 'report', tokenUsage: reportResult.tokenUsage },
          });
          send({
            content: reportResult.content,
            thinking: reportResult.thinking,
            sql: reportResult.sql,
          });
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        progress(`报告生成完成，已输出业务报告。\n`);

        const assistantMessageId = await insertChatMessage({
          sessionId,
          role: 'assistant',
          content: reportResult.content?.trim() || '',
          thinking: reportResult.thinking,
          sqlText: reportResult.sql,
          sources: sourceNames,
          metadata: {
            intent: 'report',
            report: reportResult.report,
            reportPlan: reportResult.plan,
            pythonCode: reportResult.pythonCode,
            followUps: reportResult.followUps,
            tokenUsage: reportResult.tokenUsage,
          },
        });
        await insertChatArtifact({
          sessionId,
          messageId: assistantMessageId,
          artifactType: 'report',
          title: reportResult.report?.title || buildReportTitle(userQuery),
          summary: reportResult.report?.finalSummary?.summary || reportResult.report?.executiveSummary || reportResult.content,
          sqlText: reportResult.sql,
          filters: buildReportFilterArtifact(reportResult.plan),
          dimensions: uniqueStrings((reportResult.report?.charts || []).map((chart) => chart.dimension)),
          measures: uniqueStrings((reportResult.report?.charts || []).flatMap((chart) => chart.measures)),
          data: reportResult.report,
          metadata: {
            reportPlan: reportResult.plan,
            pythonCode: reportResult.pythonCode,
            followUps: reportResult.followUps,
            recordCount: reportResult.report?.recordCount,
          },
        });

        send({
          followUps: reportResult.followUps,
          thinking: reportResult.thinking,
          sql: reportResult.sql,
          pythonCode: reportResult.pythonCode,
          report: reportResult.report,
        });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : '未知错误';
        const content = `报告生成失败：${message}`;
        await insertChatMessage({
          sessionId,
          role: 'assistant',
          content,
          sources: sourceNames,
          metadata: { intent: 'error' },
          status: 'failure',
          errorMessage: message,
        }).catch(() => undefined);
        send({ content });
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

async function buildSmartReport({
  userQuery,
  contextMessages,
  tables,
  tableContext,
  businessKnowledgePrompt,
  reasoningEnabled,
  onProgress,
}: {
  userQuery: string;
  contextMessages: DeepSeekMessage[];
  tables: SmartTableContext[];
  tableContext: string;
  businessKnowledgePrompt: string;
  reasoningEnabled: boolean;
  onProgress?: ReportProgressCallback;
}): Promise<SmartReportBuildResult> {
  const planPrompt = [
    tableContext,
    businessKnowledgePrompt,
    `用户问题：${userQuery}`,
  ].filter(Boolean).join('\n\n');

  let reportPlan: ReportPlan;
  let planUsage: DeepSeekUsage | null = null;
  try {
    onProgress?.(`任务规划：正在生成筛选条件、SQL、根因分析和图表方案。\n`);
    onProgress?.(`思考中...\n`);
    const { content: planText, usage: _planUsage } = await callDeepSeek(
      [
        { role: 'system', content: REPORT_PLANNER_SYSTEM_PROMPT },
        ...contextMessages,
        { role: 'user', content: planPrompt },
      ],
      { thinking: reasoningEnabled, reasoningEffort: 'high', temperature: 0.12 }
    );
    planUsage = _planUsage;
    onProgress?.(`任务规划：方案已生成，开始执行数据查询。\n`);
    reportPlan = parseReportPlan(planText);
  } catch {
    reportPlan = createFallbackReportPlan(userQuery, tables);
  }

  if (!reportPlan.sql) {
    onProgress?.(`任务规划缺少 SQL，正在使用表结构生成兜底查询计划。\n`);
    reportPlan = { ...createFallbackReportPlan(userQuery, tables), ...reportPlan };
  }
  reportPlan = applyReportQueryDefaults(reportPlan, userQuery, tables);

  onProgress?.(`SQL处理：正在校验并执行查询...`, { progressPhase: 'sql' });
  let safeSql: string;
  try {
    safeSql = validateAndNormalizeSql(reportPlan.sql || '', tables.map((table) => table.physical_table_name));
  } catch (err) {
    const reason = err instanceof Error ? err.message : '未知错误';
    onProgress?.(`SQL处理：校验失败（${reason}），将使用兜底查询计划。`, { progressPhase: 'sql' });
    reportPlan = { ...createFallbackReportPlan(userQuery, tables), ...reportPlan };
    safeSql = validateAndNormalizeSql(reportPlan.sql || '', tables.map((table) => table.physical_table_name));
  }
  onProgress?.(formatSqlProgress(), { sql: safeSql, progressPhase: 'sql' });

  let queryRows: Array<Record<string, unknown>>;
  try {
    onProgress?.(`SQL处理：正在执行查询...`, { progressPhase: 'sql' });
    queryRows = await executeReadOnlySql(safeSql, { limit: DEFAULT_REPORT_SQL_LIMIT, maxTextLength: 1200 });
    onProgress?.(`SQL处理：查询完成，命中 ${queryRows.length} 条记录`, { progressPhase: 'sql' });
  } catch (err) {
    const reason = err instanceof Error ? err.message : '未知错误';
    onProgress?.(`SQL处理：查询执行异常（${reason}），正在使用兜底降级方案...`, { progressPhase: 'sql' });
    queryRows = [];
  }


  if (queryRows.length === 0) {
    onProgress?.(`查询结果：未命中任何记录，请检查查询条件或换个提问方式。\n`);
    return {
      content: '暂未查询到相关数据，请检查查询条件或者换个提问方式。',
      thinking: [
        `意图识别：生成报告。${reportPlan.reason || '多维度交叉分析任务。'}`,
        `数据来源：${tables.map((t) => t.name).join('、')}`,
        `SQL 校验通过，执行查询后未命中任何记录。`,
        `建议：调整筛选条件或更换查询维度后重试。`,
      ].join('\n'),
      sql: safeSql,
      followUps: [],
      plan: reportPlan,
      isEmpty: true,
      tokenUsage: planUsage ? { promptTokens: planUsage.prompt_tokens, completionTokens: planUsage.completion_tokens, totalTokens: planUsage.total_tokens } : null,
    };
  }

  onProgress?.(`数据分析：生成维度分布、趋势和根因关键词兜底结果。\n`);
  const fallbackArtifacts = buildReportArtifacts({
    userQuery,
    rows: queryRows,
    plan: reportPlan,
    tables,
  });
  onProgress?.(`Python处理：正在生成 pandas 清洗分析代码...`, { progressPhase: 'python' });
  onProgress?.(`思考中...\n`);
  const generatedPythonResult = await runGeneratedPythonAnalysis({
    userQuery,
    rows: queryRows,
    plan: reportPlan,
    tables,
    fallbackArtifacts,
    onPythonCode: (code) => {
      onProgress?.(formatPythonProgress(), { pythonCode: code, progressPhase: 'python' });
    },
  });
  const generatedPython = generatedPythonResult ? { code: generatedPythonResult.code, artifacts: generatedPythonResult.artifacts } : undefined;
  const pythonUsage = generatedPythonResult?.pythonUsage ?? null;
  onProgress?.(
    generatedPython?.code
      ? `Python处理：已执行代码并回收指标、图表数据和根因结果。`
      : `Python处理：未产出可用结果，已切换为结构化分析结果。`,
    { progressPhase: 'python' }
  );
  const artifacts = enhanceReportArtifactsForComparison(
    generatedPython?.artifacts || fallbackArtifacts,
    userQuery,
    queryRows,
    reportPlan,
    tables,
  );
  onProgress?.(`报告撰写：为每张图表生成业务解读和最终摘要。\n`);
  onProgress?.(`思考中...\n`);
  const { narrative, usage: narrativeUsage } = await writeReportNarrative({
    userQuery,
    plan: reportPlan,
    rowCount: queryRows.length,
    tables,
    artifacts,
    businessKnowledgePrompt,
  });

  const report: SmartReport = {
    title: reportPlan.title || buildReportTitle(userQuery),
    subtitle: buildReportSubtitle(reportPlan, queryRows.length),
    generatedAt: new Date().toISOString(),
    recordCount: queryRows.length,
    timeRange: normalizeReportTimeRange(reportPlan),
    classification: {
      intent: 'report',
      reason: reportPlan.reason || '该问题同时涉及数据查询、根因分析和可视化展示，归类为生成报告。',
    },
    dataSources: tables.map((table) => table.name),
    metrics: artifacts.metrics,
    steps: buildReportSteps(reportPlan, tables, queryRows.length, artifacts.charts.length, Boolean(generatedPython?.code)),
    executiveSummary: narrative.executiveSummary,
    sections: narrative.sections,
    chartExplanations: narrative.chartExplanations,
    charts: artifacts.charts,
    tables: artifacts.tables,
    rootCauses: artifacts.rootCauses,
    recommendations: narrative.recommendations,
    finalSummary: narrative.finalSummary,
  };

  const content = [
    `已识别为「生成报告」任务，并基于 ${tables.map((table) => table.name).join('、')} 完成任务规划。`,
    `本次命中 ${queryRows.length} 条记录，${generatedPython?.code ? '已生成并执行 pandas 分析代码。' : '已完成结构化分析。'}`,
  ].join('\n');


  const reportTokenUsage = (planUsage || pythonUsage || narrativeUsage)
    ? {
        promptTokens: (planUsage?.prompt_tokens ?? 0) + (pythonUsage?.prompt_tokens ?? 0) + (narrativeUsage?.prompt_tokens ?? 0),
        completionTokens: (planUsage?.completion_tokens ?? 0) + (pythonUsage?.completion_tokens ?? 0) + (narrativeUsage?.completion_tokens ?? 0),
        totalTokens: (planUsage?.total_tokens ?? 0) + (pythonUsage?.total_tokens ?? 0) + (narrativeUsage?.total_tokens ?? 0),
      }
    : null;

  return {
    content,
    thinking: buildReportThinking(report, reportPlan, queryRows.length, Boolean(generatedPython?.code)),
    sql: safeSql,
    pythonCode: generatedPython?.code,
    report,
    followUps: buildReportFollowUps(report),
    plan: reportPlan,
    tokenUsage: reportTokenUsage,
  };
}

function parseReportPlan(text: string): ReportPlan {
  const parsed = JSON.parse(extractJson(text)) as ReportPlan;
  return {
    ...parsed,
    charts: Array.isArray(parsed.charts) ? parsed.charts : [],
    filters: Array.isArray(parsed.filters) ? parsed.filters : [],
    analysisSteps: Array.isArray(parsed.analysisSteps) ? parsed.analysisSteps : [],
    narrativeFocus: Array.isArray(parsed.narrativeFocus) ? parsed.narrativeFocus : [],
  };
}

function applyReportQueryDefaults(plan: ReportPlan, userQuery: string, tables: SmartTableContext[]): ReportPlan {
  const fields = getAvailableFields(tables);
  const dateField = resolveFieldName(plan.timeRange?.field || '', [], tables)
    || findFieldByKeywords(fields, ['发声时间', '时间', '日期', '创建时间']);
  const userSpecifiedDate = hasUserSpecifiedDateRange(userQuery);
  const sqlAlreadyHasDate = Boolean(plan.sql && dateField && hasSqlDateConstraint(plan.sql, dateField));
  const shouldApplyDefaultDate = Boolean(dateField && !userSpecifiedDate && !sqlAlreadyHasDate);
  const timeRange = shouldApplyDefaultDate
    ? {
        field: dateField,
        label: '过去一年',
        start: DEFAULT_REPORT_DATE_RANGE.start,
        end: DEFAULT_REPORT_DATE_RANGE.end,
      }
    : plan.timeRange;

  return {
    ...plan,
    timeRange,
    sql: plan.sql
      ? enforceReportSqlDefaults({
          sql: plan.sql,
          dateField,
          timeRange: shouldApplyDefaultDate ? timeRange : undefined,
          limit: DEFAULT_REPORT_SQL_LIMIT,
        })
      : plan.sql,
  };
}

function enforceReportSqlDefaults({
  sql,
  dateField,
  timeRange,
  limit,
}: {
  sql: string;
  dateField?: string;
  timeRange?: ReportPlan['timeRange'];
  limit: number;
}): string {
  const { sql: withoutLimit, limit: existingLimit } = stripTrailingLimit(sql);
  const boundedLimit = Math.min(existingLimit || limit, limit);
  const dateCondition = dateField && timeRange?.start && timeRange.end
    ? `${quoteIdent(dateField)} >= DATE '${timeRange.start}' AND ${quoteIdent(dateField)} <= DATE '${timeRange.end}'`
    : '';
  const guardedSql = dateCondition && dateField && !hasSqlDateConstraint(withoutLimit, dateField)
    ? appendSqlCondition(withoutLimit, dateCondition)
    : withoutLimit;

  return `${guardedSql} LIMIT ${boundedLimit}`;
}

function stripTrailingLimit(sql: string): { sql: string; limit?: number } {
  const normalized = sql.trim().replace(/;+$/g, '').trim();
  const match = normalized.match(/\s+limit\s+(\d+)\s*$/i);
  if (!match) return { sql: normalized };
  return {
    sql: normalized.slice(0, match.index).trim(),
    limit: Number(match[1]),
  };
}

function appendSqlCondition(sql: string, condition: string): string {
  const tailMatch = sql.match(/\s+(group\s+by|having|order\s+by)\b/i);
  const head = tailMatch?.index !== undefined ? sql.slice(0, tailMatch.index).trim() : sql.trim();
  const tail = tailMatch?.index !== undefined ? sql.slice(tailMatch.index).trim() : '';
  const connector = /\bwhere\b/i.test(head) ? ' AND ' : ' WHERE ';
  return `${head}${connector}${condition}${tail ? ` ${tail}` : ''}`;
}

function hasSqlDateConstraint(sql: string, dateField: string): boolean {
  if (!dateField) return false;
  const quotedField = quoteIdent(dateField).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const plainField = dateField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(${quotedField}|${plainField})\\s*(>=|>|<=|<|=|between\\b)`, 'i').test(sql);
}

function hasUserSpecifiedDateRange(userQuery: string): boolean {
  return /过去一年|近一年|最近一年|今天|昨日|昨天|本周|上周|本月|上月|今年|去年|\d{4}[-年/.]\d{1,2}/.test(userQuery);
}

function parseSqlPlanOrFallback(text: string, query: string): SqlPlan {
  try {
    return parseSqlPlan(text);
  } catch {
    return {
      intent: 'clarify',
      reason: '意图识别结果解析失败，未能得到 simple_query、report 或 clarify 枚举。',
      clarifying_question: `我没有可靠识别这个问题的任务类型，请重新描述要查询或生成报告的目标：${compactText(query, 80)}`,
    };
  }
}

function createFallbackReportPlan(userQuery: string, tables: SmartTableContext[]): ReportPlan {
  const table = tables[0];
  const fields = getAvailableFields(tables);
  const dateField = findFieldByKeywords(fields, ['发声时间', '时间', '日期', '创建时间']);
  const modelField = findFieldByKeywords(fields, ['车型', '车系', '产品型号', '型号']);
  const tag4Field = findFieldByKeywords(fields, ['通用四级标签', '四级标签', '问题标签']);
  const tag3Field = findFieldByKeywords(fields, ['通用三级标签', '三级标签']);
  const sentimentField = findFieldByKeywords(fields, ['情感', '用户情感', '情绪', '正负面']);
  const voiceField = findFieldByKeywords(fields, ['原声片段', '原文', '用户原声', '反馈内容', '评论内容']);
  const selectedFields = uniqueStrings([dateField, modelField, tag3Field, tag4Field, sentimentField, voiceField].filter(Boolean) as string[]);
  const selectFields = selectedFields.length > 0 ? selectedFields.map(quoteIdent).join(', ') : '*';
  const where: string[] = [];
  const filters: ReportPlanFilter[] = [];

  if (dateField) {
    where.push(`${quoteIdent(dateField)} >= DATE '${DEFAULT_REPORT_DATE_RANGE.start}'`);
    where.push(`${quoteIdent(dateField)} <= DATE '${DEFAULT_REPORT_DATE_RANGE.end}'`);
  }

  if (sentimentField && /负面|负向|差评|不满意/.test(userQuery)) {
    where.push(`${quoteIdent(sentimentField)} = '负面'`);
    filters.push({ field: sentimentField, operator: '=', value: '负面' });
  }

  const tagValue = extractLikelyTagValue(userQuery);
  if (tag4Field && tagValue) {
    const equivalentValues = uniqueStrings([tagValue, tagValue.replace('启动', '起动'), tagValue.replace('起动', '启动')]);
    where.push(`${quoteIdent(tag4Field)} IN (${equivalentValues.map((value) => `'${escapeSqlLiteral(value)}'`).join(', ')})`);
    filters.push({ field: tag4Field, operator: '=', value: tagValue });
  }

  return {
    title: buildReportTitle(userQuery),
    reason: '该问题包含筛选查询、根因分析和图表展示，属于综合型生成报告。',
    sql: `SELECT ${selectFields} FROM ${quoteIdent(table.physical_table_name)}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} LIMIT ${DEFAULT_REPORT_SQL_LIMIT}`,
    timeRange: dateField
      ? { field: dateField, label: '过去一年', start: DEFAULT_REPORT_DATE_RANGE.start, end: DEFAULT_REPORT_DATE_RANGE.end }
      : undefined,
    filters,
    analysisSteps: [
      { id: 'intent', title: '意图识别', description: '识别为生成报告任务' },
      { id: 'query', title: '数据查询', description: '按时间和标签条件筛选数据' },
      { id: 'analysis', title: '根因与维度分析', description: '统计关键词、车型和标签分布' },
    ],
    rootCause: {
      field: voiceField,
      keywords: DEFAULT_ROOT_CAUSE_KEYWORDS,
    },
    charts: [
      modelField && { id: 'model_distribution', title: '车型分布', type: 'bar' as const, dimension: modelField, measure: '数量', limit: 10 },
      tag4Field && { id: 'tag4_distribution', title: '四级标签分布', type: 'pie' as const, dimension: tag4Field, measure: '数量', limit: 10 },
      tag3Field && { id: 'tag3_distribution', title: '三级标签分布', type: 'pie' as const, dimension: tag3Field, measure: '数量', limit: 8 },
      dateField && { id: 'time_trend', title: '时间趋势', type: 'line' as const, dimension: dateField, measure: '数量', limit: 12 },
    ].filter(Boolean) as ReportPlanChart[],
    narrativeFocus: ['问题规模', '根因排序', '车型集中度', '处置建议'],
  };
}

const DEFAULT_ROOT_CAUSE_KEYWORDS = [
  '启动机',
  '蓄电池',
  '电池',
  '电瓶',
  '点火',
  '马达',
  '钥匙',
  '遥控',
  '无法启动',
  '打不着',
  '不着火',
  '启动不了',
  '起动不了',
  '启动困难',
  '起动困难',
  '启动异常',
  '起动异常',
  '故障灯',
  '异响',
  '失灵',
  '亏电',
  '没电',
  '充电',
  '低压',
];

function buildReportArtifacts({
  userQuery,
  rows,
  plan,
  tables,
}: {
  userQuery: string;
  rows: Array<Record<string, unknown>>;
  plan: ReportPlan;
  tables: SmartTableContext[];
}): ReportArtifacts {
  const rootCauses = buildRootCauseAnalysis(rows, plan, tables);
  const charts = appendRootCauseChart(buildReportCharts(rows, plan, tables, userQuery), rootCauses);
  const topChart = charts.find((chart) => chart.data.length > 0);
  const topMeasure = topChart?.measures[0] || '数量';
  const topItem = topChart?.data[0];
  const topDimension = topChart && topItem ? String(topItem[topChart.dimension] || '-') : '-';
  const topCount = topItem ? Number(topItem[topMeasure] || 0) : 0;
  const topRootCause = rootCauses[0];

  return {
    charts,
    tables: [],
    rootCauses,
    metrics: [
      { label: '命中记录', value: rows.length, description: 'SQL 筛选后的分析样本量' },
      { label: '核心维度 Top1', value: topDimension, description: topCount > 0 ? `${topCount} 条记录` : '暂无分布数据' },
      { label: '首要根因', value: topRootCause?.keyword || '-', description: topRootCause ? `${topRootCause.count} 次提及` : '未匹配到关键词' },
    ],
  };
}

function enhanceReportArtifactsForComparison(
  artifacts: ReportArtifacts,
  userQuery: string,
  rows: Array<Record<string, unknown>>,
  plan: ReportPlan,
  tables: SmartTableContext[],
): ReportArtifacts {
  const comparisonCharts = buildComparisonCharts(rows, plan, tables, userQuery);
  if (comparisonCharts.length === 0) return artifacts;

  const comparisonDimensions = new Set(comparisonCharts.map((chart) => normalizeField(chart.dimension)));
  const comparisonIds = new Set(comparisonCharts.map((chart) => chart.id));
  const retainedCharts = artifacts.charts.filter((chart) => {
    if (comparisonIds.has(chart.id)) return false;
    return !comparisonDimensions.has(normalizeField(chart.dimension));
  });

  return {
    ...artifacts,
    charts: [...comparisonCharts, ...retainedCharts].slice(0, 6),
  };
}

function buildComparisonCharts(
  rows: Array<Record<string, unknown>>,
  plan: ReportPlan,
  tables: SmartTableContext[],
  userQuery: string,
): SmartReportChart[] {
  const seriesContext = resolveComparisonSeriesContext(rows, tables, userQuery);
  if (!seriesContext) return [];

  const dimensions = resolveComparisonDimensions(plan, tables, rows, userQuery, seriesContext.field);
  const limit = resolveReportChartLimit(userQuery);

  return dimensions
    .map((dimension): SmartReportChart | undefined => {
      const data = buildStackedDistributionRows(rows, dimension, seriesContext.field, seriesContext.values, limit);
      if (data.length === 0) return undefined;

      return {
        id: normalizeId(`comparison_${seriesContext.field}_${dimension}`),
        title: `${seriesContext.values.join(' vs ')}${shortReportDimensionName(dimension)}对比`,
        subtitle: `按 ${dimension} 分组，对比 ${seriesContext.field} 的记录数`,
        type: 'stackedBar',
        dimension,
        measures: seriesContext.values,
        data,
      };
    })
    .filter(isDefined)
    .slice(0, 3);
}

function resolveComparisonSeriesContext(
  rows: Array<Record<string, unknown>>,
  tables: SmartTableContext[],
  userQuery: string,
  chartPlan?: ReportPlanChart,
): { field: string; values: string[] } | undefined {
  const fields = getAvailableFields(tables, rows);
  const seriesField = resolveFieldName(chartPlan?.seriesField || '', rows, tables)
    || findFieldByKeywords(fields, ['车系', '车型', '车型名称', '产品型号', '型号']);
  if (!seriesField) return undefined;

  const distinctValues = uniqueStrings(rows.map((row) => normalizeCellValue(row[seriesField]))).slice(0, 40);
  if (distinctValues.length < 2) return undefined;

  const requestedValues = uniqueStrings([
    ...(Array.isArray(chartPlan?.series) ? chartPlan.series.map(String) : []),
    ...extractVehicleCompareCandidates(userQuery),
  ]);
  const matchedValues = uniqueStrings(
    requestedValues
      .map((value) => findMatchingSeriesValue(value, distinctValues))
      .filter(isDefined)
  );
  if (matchedValues.length >= 2) {
    return { field: seriesField, values: matchedValues.slice(0, 6) };
  }

  if (!looksLikeVehicleComparisonQuery(userQuery)) return undefined;
  return { field: seriesField, values: distinctValues.slice(0, 6) };
}

function resolveComparisonDimensions(
  plan: ReportPlan,
  tables: SmartTableContext[],
  rows: Array<Record<string, unknown>>,
  userQuery: string,
  seriesField: string,
): string[] {
  const fields = getAvailableFields(tables, rows);
  const queryDimensions = [
    /五级/.test(userQuery) ? findFieldByKeywords(fields, ['通用五级标签', '五级标签', '五级']) : undefined,
    /四级/.test(userQuery) ? findFieldByKeywords(fields, ['通用四级标签', '四级标签', '四级']) : undefined,
    /三级渠道|渠道/.test(userQuery) ? findFieldByKeywords(fields, ['三级渠道', '渠道', '来源', '数据来源']) : undefined,
    /投诉意图|意图/.test(userQuery) ? findFieldByKeywords(fields, ['投诉意图', '用户意图', '意图']) : undefined,
    /三级标签/.test(userQuery) ? findFieldByKeywords(fields, ['通用三级标签', '三级标签', '三级']) : undefined,
  ].filter(isDefined);
  const planDimensions = (plan.charts || [])
    .map((chart) => resolveFieldName(chart.dimension || '', rows, tables))
    .filter(isDefined);

  return uniqueStrings([...queryDimensions, ...planDimensions])
    .filter((dimension) => normalizeField(dimension) !== normalizeField(seriesField))
    .filter((dimension) => !/时间|日期|月份|month|date/i.test(dimension))
    .slice(0, 4);
}

function buildStackedDistributionRows(
  rows: Array<Record<string, unknown>>,
  dimension: string,
  seriesField: string,
  seriesValues: string[],
  limit: number,
): Array<Record<string, string | number>> {
  const countField = findCountWeightField(rows, dimension, seriesField);
  const counts = new Map<string, Map<string, number>>();
  let grandTotal = 0;

  for (const row of rows) {
    const dimensionValue = normalizeCellValue(row[dimension]);
    const rawSeriesValue = normalizeCellValue(row[seriesField]);
    const seriesValue = findMatchingSeriesValue(rawSeriesValue, seriesValues);
    if (!dimensionValue || !seriesValue) continue;

    const weight = countField ? Number(row[countField]) || 0 : 1;
    if (weight <= 0) continue;

    const current = counts.get(dimensionValue) || new Map<string, number>();
    current.set(seriesValue, (current.get(seriesValue) || 0) + weight);
    counts.set(dimensionValue, current);
    grandTotal += weight;
  }

  return Array.from(counts.entries())
    .map(([dimensionValue, seriesCounts]) => {
      const record: Record<string, string | number> = { [dimension]: dimensionValue };
      let total = 0;
      for (const seriesValue of seriesValues) {
        const count = seriesCounts.get(seriesValue) || 0;
        record[seriesValue] = count;
        total += count;
      }
      record['总计'] = total;
      record['占比'] = grandTotal > 0 ? Number(((total / grandTotal) * 100).toFixed(1)) : 0;
      return record;
    })
    .filter((record) => Number(record['总计'] || 0) > 0)
    .sort((a, b) => Number(b['总计'] || 0) - Number(a['总计'] || 0))
    .slice(0, limit);
}

function findCountWeightField(rows: Array<Record<string, unknown>>, dimension: string, seriesField: string): string | undefined {
  const firstRow = rows[0];
  if (!firstRow) return undefined;
  return Object.keys(firstRow).find((key) => {
    if (normalizeField(key) === normalizeField(dimension) || normalizeField(key) === normalizeField(seriesField)) return false;
    if (!/数量|记录数|次数|count|cnt|total/i.test(key)) return false;
    const value = firstRow[key];
    return typeof value === 'number' || (typeof value === 'string' && Number.isFinite(Number(value)));
  });
}

function extractVehicleCompareCandidates(userQuery: string): string[] {
  const matches: string[] = [];
  const quotedMatches = userQuery.matchAll(/[“"']([^”"']{1,40})[”"']/g);
  for (const match of quotedMatches) {
    if (/车系|车型/.test(match[1])) matches.push(match[1].trim());
  }

  const vehicleMatches = userQuery.matchAll(/(车系|车型)\s*([^，。；;、和与及\s的]{1,30})/g);
  for (const match of vehicleMatches) {
    const prefix = match[1];
    const value = match[2].trim();
    if (!value || /分布|报告|分析|对比|渠道|标签|意图/.test(value)) continue;
    matches.push(`${prefix}${value}`);
  }

  return uniqueStrings(matches);
}

function findMatchingSeriesValue(candidate: string, values: string[]): string | undefined {
  const normalizedCandidate = normalizeField(candidate);
  if (!normalizedCandidate) return undefined;
  return values.find((value) => normalizeField(value) === normalizedCandidate)
    || values.find((value) => {
      const normalizedValue = normalizeField(value);
      return normalizedCandidate.length >= 2 && normalizedValue.includes(normalizedCandidate);
    })
    || values.find((value) => {
      const normalizedValue = normalizeField(value);
      return normalizedValue.length >= 2 && normalizedCandidate.includes(normalizedValue);
    });
}

function looksLikeVehicleComparisonQuery(userQuery: string): boolean {
  return /车系|车型/.test(userQuery) && /竞品|对比|比较|分别|以及|和|与|vs|VS/.test(userQuery);
}

function shortReportDimensionName(value: string): string {
  return value
    .replace(/^通用/, '')
    .replace(/分布|趋势|分析|数量|Top\s*\d+/gi, '')
    .trim() || value;
}

function shouldSuppressSampleBasedClarify(plan: SqlPlan, userQuery: string): boolean {
  if (plan.intent !== 'clarify') return false;
  const text = `${plan.reason || ''}${plan.clarifying_question || ''}`;
  const looksLikeMissingValue = /不存在|未找到|没有.*数据|样例.*没有|数据中.*没有|不在.*数据/.test(text);
  const asksForAnalysis = /报告|分析|分布|趋势|对比|竞品|渠道|标签|词云|车系|车型|意图/.test(userQuery);
  const namesConcreteVehicle = /车系\w+|车型\w+|车系[A-Za-z0-9一二三四五六七八九十]+|车型[A-Za-z0-9一二三四五六七八九十]+/.test(userQuery);

  return looksLikeMissingValue && (asksForAnalysis || namesConcreteVehicle);
}

function createFallbackSqlReportPlan(userQuery: string, tables: SmartTableContext[]): SqlPlan {
  const fallback = createFallbackReportPlan(userQuery, tables);
  return {
    intent: 'report',
    sql: fallback.sql,
    reason: '用户提出综合分析/报告诉求；不能因为样例行未覆盖点名业务值就判断不存在，改为执行 SQL 验证。',
  };
}

function buildReportCharts(rows: Array<Record<string, unknown>>, plan: ReportPlan, tables: SmartTableContext[], userQuery: string): SmartReportChart[] {
  const chartPlans = (plan.charts && plan.charts.length > 0 ? plan.charts : createFallbackReportPlan('', tables).charts) || [];
  const charts: SmartReportChart[] = [];
  const requestedChartLimit = resolveReportChartLimit(userQuery);

  for (const chartPlan of chartPlans) {
    const requestedDimension = chartPlan.dimension || '';
    const dimension = resolveFieldName(requestedDimension, rows, tables);
    if (!dimension) continue;

    const chartType = normalizeRenderableChartType(chartPlan.type);
    const limit = clampNumber(requestedChartLimit, 3, MAX_REPORT_CHART_LIMIT);
    const measure = chartPlan.measure || '数量';

    if (chartType === 'line') {
      const data = buildTrendRows(rows, dimension);
      if (data.length === 0) continue;
      charts.push({
        id: normalizeId(chartPlan.id || `${dimension}_trend`),
        title: chartPlan.title || `${dimension}趋势`,
        subtitle: `按 ${dimension} 汇总`,
        type: 'line',
        dimension,
        measures: [measure],
        data: data.map((item) => ({ [dimension]: item.name, [measure]: item.value })),
      });
      continue;
    }

    if (chartType === 'stackedBar') {
      const seriesContext = resolveComparisonSeriesContext(rows, tables, userQuery, chartPlan);
      if (seriesContext) {
        const data = buildStackedDistributionRows(rows, dimension, seriesContext.field, seriesContext.values, limit);
        if (data.length > 0) {
          charts.push({
            id: normalizeId(chartPlan.id || `comparison_${seriesContext.field}_${dimension}`),
            title: chartPlan.title || `${seriesContext.values.join(' vs ')}${shortReportDimensionName(dimension)}对比`,
            subtitle: `按 ${dimension} 分组，对比 ${seriesContext.field} 的记录数`,
            type: 'stackedBar',
            dimension,
            measures: seriesContext.values,
            data,
          });
          continue;
        }
      }
    }

    const distribution = buildDistributionRows(rows, dimension, limit);
    if (distribution.length === 0) continue;
    charts.push({
      id: normalizeId(chartPlan.id || `${dimension}_distribution`),
      title: chartPlan.title || `${dimension}分布`,
      subtitle: `Top ${distribution.length}，按记录数统计`,
      type: chartType === 'stackedBar' ? 'bar' : chartType,
      dimension,
      measures: [measure],
      data: distribution.map((item) => ({
        [dimension]: item.name,
        [measure]: item.value,
        占比: item.ratio,
      })),
    });
  }

  return charts.slice(0, 6);
}

function appendRootCauseChart(charts: SmartReportChart[], rootCauses: SmartReportRootCause[]): SmartReportChart[] {
  if (rootCauses.length === 0 || charts.some((chart) => chart.id === 'root_cause_keywords')) return charts;
  const rootCauseChart: SmartReportChart = {
    id: 'root_cause_keywords',
    title: '根因关键词分布',
    subtitle: '按原声片段关键词提及次数统计',
    type: 'bar',
    dimension: '关键词',
    measures: ['提及次数'],
    data: rootCauses.slice(0, 10).map((cause) => ({
      关键词: cause.keyword,
      提及次数: cause.count,
      占比: cause.ratio,
    })),
  };

  return [...charts, rootCauseChart].slice(0, 7);
}

function buildDistributionRows(rows: Array<Record<string, unknown>>, field: string, limit: number): Array<{ name: string; value: number; ratio: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const value = normalizeCellValue(row[field]);
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, value]) => ({
      name,
      value,
      ratio: rows.length > 0 ? Number(((value / rows.length) * 100).toFixed(1)) : 0,
    }));
}

function resolveReportChartLimit(userQuery: string): number {
  const explicitLimit = extractExplicitTopLimit(userQuery);
  return clampNumber(explicitLimit || DEFAULT_REPORT_CHART_LIMIT, 3, MAX_REPORT_CHART_LIMIT);
}

function extractExplicitTopLimit(text: string): number | undefined {
  const normalized = text.trim();
  const digitMatch = normalized.match(/(?:top|TOP|Top)\s*([0-9]{1,3})|前\s*([0-9]{1,3})\s*(?:个|条|名|项|类|位)?/);
  if (digitMatch) {
    const value = Number(digitMatch[1] || digitMatch[2]);
    return Number.isFinite(value) ? value : undefined;
  }

  const chineseMatch = normalized.match(/前\s*([一二两三四五六七八九十]{1,3})\s*(?:个|条|名|项|类|位)?/);
  if (!chineseMatch) return undefined;
  return parseSimpleChineseNumber(chineseMatch[1]);
}

function parseSimpleChineseNumber(text: string): number | undefined {
  const digits: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };

  if (text === '十') return 10;
  if (!text.includes('十')) return digits[text];

  const [tensText, onesText] = text.split('十');
  const tens = tensText ? digits[tensText] : 1;
  const ones = onesText ? digits[onesText] : 0;
  const value = tens * 10 + ones;
  return Number.isFinite(value) ? value : undefined;
}

function buildTrendRows(rows: Array<Record<string, unknown>>, field: string): Array<{ name: string; value: number }> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const rawValue = row[field];
    const date = rawValue instanceof Date ? rawValue : new Date(String(rawValue || ''));
    if (Number.isNaN(date.getTime())) continue;
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return Array.from(counts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, value]) => ({ name, value }));
}

function buildRootCauseAnalysis(rows: Array<Record<string, unknown>>, plan: ReportPlan, tables: SmartTableContext[]): SmartReportRootCause[] {
  const textField = resolveFieldName(plan.rootCause?.field || '', rows, tables)
    || findFieldByKeywords(getAvailableFields(tables, rows), ['原声片段', '原文', '反馈内容', '评论内容', '用户原声']);
  if (!textField) return [];

  const keywords = uniqueStrings([
    ...(Array.isArray(plan.rootCause?.keywords) ? plan.rootCause.keywords : []),
    ...DEFAULT_ROOT_CAUSE_KEYWORDS,
  ].map((keyword) => String(keyword).trim()).filter(Boolean)).slice(0, 32);

  return keywords
    .map((keyword) => {
      const matchedRows = rows.filter((row) => String(row[textField] || '').includes(keyword));
      return {
        keyword,
        count: matchedRows.length,
        ratio: rows.length > 0 ? Number(((matchedRows.length / rows.length) * 100).toFixed(1)) : 0,
        evidence: matchedRows
          .slice(0, 2)
          .map((row) => compactText(String(row[textField] || ''), 120))
          .filter(Boolean),
      };
    })
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

async function runGeneratedPythonAnalysis({
  userQuery,
  rows,
  plan,
  tables,
  fallbackArtifacts,
  onPythonCode,
}: {
  userQuery: string;
  rows: Array<Record<string, unknown>>;
  plan: ReportPlan;
  tables: SmartTableContext[];
  fallbackArtifacts: ReportArtifacts;
  onPythonCode?: (code: string) => void;
}): Promise<GeneratedPythonAnalysis | undefined> {
  if (rows.length === 0) return undefined;

  const workDir = await mkdtemp(path.join(tmpdir(), 'voc-report-'));
  const inputCsvPath = path.join(workDir, 'input.csv');
  const planJsonPath = path.join(workDir, 'plan.json');
  const outputJsonPath = path.join(workDir, 'report_artifacts.json');
  const scriptPath = path.join(workDir, 'generated_analysis.py');

  try {
    await writeFile(inputCsvPath, rowsToCsv(rows), 'utf8');
    await writeFile(planJsonPath, JSON.stringify({
      userQuery,
      plan,
      columns: getAvailableFields(tables, rows),
      rowCount: rows.length,
      sampleRows: rows.slice(0, 12),
    }, null, 2), 'utf8');

    const { code: generatedBody, usage: pythonUsage } = await generatePythonAnalysisCode({
      userQuery,
      rows,
      plan,
      tables,
    });
    const script = buildPythonScript({
      generatedBody,
      inputCsvPath,
      planJsonPath,
      outputJsonPath,
    });

    onPythonCode?.(script);
    await writeFile(scriptPath, script, 'utf8');
    await executePythonScript(scriptPath, workDir);

    const outputText = await readFile(outputJsonPath, 'utf8');
    const parsed = JSON.parse(outputText) as unknown;
    return {
      code: script,
      artifacts: normalizePythonArtifacts(parsed, fallbackArtifacts, rows.length, resolveReportChartLimit(userQuery)),
      pythonUsage,
    };
  } catch {
    return undefined;
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function generatePythonAnalysisCode({
  userQuery,
  rows,
  plan,
  tables,
}: {
  userQuery: string;
  rows: Array<Record<string, unknown>>;
  plan: ReportPlan;
  tables: SmartTableContext[];
}): Promise<{ code: string; usage: DeepSeekUsage | null }> {
  const { content: text, usage } = await callDeepSeek(
    [
      { role: 'system', content: PYTHON_ANALYST_SYSTEM_PROMPT },
      {
        role: 'user',
        content: JSON.stringify({
          userQuery,
          plan,
          columns: getAvailableFields(tables, rows),
          rowCount: rows.length,
          sampleRows: rows.slice(0, 8),
          requiredOutput: {
            metrics: [{ label: '命中记录', value: rows.length, description: 'SQL 查询后的样本量' }],
            charts: [],
            tables: [],
            rootCauses: [],
          },
        }, null, 2),
      },
    ],
    { thinking: false, reasoningEffort: 'high', temperature: 0.08 }
  );

  return { code: extractPythonCode(text), usage };
}

function buildPythonScript({
  generatedBody,
  inputCsvPath,
  planJsonPath,
  outputJsonPath,
}: {
  generatedBody: string;
  inputCsvPath: string;
  planJsonPath: string;
  outputJsonPath: string;
}): string {
  return [
    '# Auto-generated by VOC intelligent report mode.',
    '# It reads the SQL result CSV, performs pandas analysis, and writes report_artifacts.json.',
    `INPUT_CSV = ${JSON.stringify(inputCsvPath)}`,
    `PLAN_JSON = ${JSON.stringify(planJsonPath)}`,
    `OUTPUT_JSON = ${JSON.stringify(outputJsonPath)}`,
    '',
    generatedBody.trim(),
    '',
  ].join('\n');
}

function formatSqlProgress(): string {
  return 'SQL语句：已生成，完整内容见下方 SQL 预览。\n';
}

function formatPythonProgress(): string {
  return 'Python代码：已生成，完整内容见下方 Python 代码预览。\n';
}

function extractPythonCode(text: string): string {
  const jsonText = text.trim().startsWith('{') ? extractJson(text) : '';
  if (jsonText) {
    try {
      const parsed = JSON.parse(jsonText) as { code?: unknown };
      if (typeof parsed.code === 'string' && parsed.code.trim()) return parsed.code.trim();
    } catch {
      // fall through to fenced code parsing
    }
  }

  const fenced = text.match(/```(?:python|py)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

function executePythonScript(scriptPath: string, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [scriptPath], {
      cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
      },
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 30000);

    child.stdout.on('data', (chunk) => {
      stdout = appendLimited(stdout, String(chunk), 4000);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendLimited(stderr, String(chunk), 4000);
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error('Python 分析执行超时'));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Python 分析执行失败：${stderr || stdout || `exit ${code}`}`));
        return;
      }
      resolve();
    });
  });
}

function appendLimited(current: string, next: string, maxLength: number): string {
  const merged = current + next;
  return merged.length > maxLength ? merged.slice(-maxLength) : merged;
}

function normalizePythonArtifacts(value: unknown, fallback: ReportArtifacts, rowCount: number, chartLimit: number): ReportArtifacts {
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Record<string, unknown>;
  const rootCauses = normalizePythonRootCauses(raw.rootCauses);
  const effectiveRootCauses = rootCauses.length > 0 ? rootCauses : fallback.rootCauses;
  const pythonCharts = normalizePythonCharts(raw.charts, chartLimit);
  const charts = appendRootCauseChart(pythonCharts.length > 0 ? pythonCharts : fallback.charts, effectiveRootCauses);
  const tables = normalizePythonTables(raw.tables).filter((table) => !isDistributionTable(table));
  const metrics = normalizePythonMetrics(raw.metrics, rowCount, charts.length, effectiveRootCauses[0]);

  return {
    metrics: metrics.length > 0 ? metrics : fallback.metrics,
    charts,
    tables,
    rootCauses: effectiveRootCauses,
  };
}

function normalizePythonMetrics(value: unknown, rowCount: number, chartCount: number, topRootCause?: SmartReportRootCause): SmartReportMetric[] {
  const metrics = Array.isArray(value)
    ? value.map((item): SmartReportMetric | undefined => {
        if (!item || typeof item !== 'object') return undefined;
        const row = item as Record<string, unknown>;
        return {
          label: String(row.label || '').trim(),
          value: typeof row.value === 'number' || typeof row.value === 'string' ? row.value : String(row.value || ''),
          description: typeof row.description === 'string' ? row.description : undefined,
        };
      }).filter(isDefined).filter((item) => Boolean(item.label))
    : [];

  if (!metrics.some((metric) => metric.label === '命中记录')) {
    metrics.unshift({ label: '命中记录', value: rowCount, description: 'Python pandas 分析样本量' });
  }
  if (!metrics.some((metric) => metric.label === '首要根因')) {
    metrics.push({
      label: '首要根因',
      value: topRootCause?.keyword || '-',
      description: topRootCause ? `${topRootCause.count} 次提及` : '未匹配到关键词',
    });
  }
  return metrics.slice(0, 4);
}

function normalizePythonCharts(value: unknown, chartLimit: number): SmartReportChart[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index): SmartReportChart | undefined => {
    if (!item || typeof item !== 'object') return undefined;
    const raw = item as Record<string, unknown>;
    const dimension = String(raw.dimension || '').trim();
    const measures = Array.isArray(raw.measures) ? raw.measures.map(String).filter(Boolean) : ['数量'];
    const chartType = normalizeRenderableChartType(raw.type);
    const dataLimit = chartType === 'line' ? 24 : clampNumber(chartLimit, 3, MAX_REPORT_CHART_LIMIT);
    const data = Array.isArray(raw.data)
      ? raw.data
          .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
          .slice(0, dataLimit)
          .map((row) => normalizeRecordValues(row))
      : [];

    if (!dimension || data.length === 0) return undefined;
    return {
      id: normalizeId(String(raw.id || `python_chart_${index + 1}`)),
      title: String(raw.title || `${dimension}分布`),
      subtitle: typeof raw.subtitle === 'string' ? raw.subtitle : undefined,
      type: chartType,
      dimension,
      measures,
      data,
    };
  }).filter(isDefined).slice(0, 6);
}

function normalizePythonTables(value: unknown): SmartReportTable[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index): SmartReportTable | undefined => {
    if (!item || typeof item !== 'object') return undefined;
    const raw = item as Record<string, unknown>;
    const columns = Array.isArray(raw.columns) ? raw.columns.map(String).filter(Boolean) : [];
    const rows = Array.isArray(raw.rows)
      ? raw.rows
          .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object')
          .slice(0, 30)
          .map((row) => normalizeRecordValues(row))
      : [];
    if (columns.length === 0 || rows.length === 0) return undefined;
    return {
      id: normalizeId(String(raw.id || `python_table_${index + 1}`)),
      title: String(raw.title || '分析明细'),
      columns,
      rows,
    };
  }).filter(isDefined).slice(0, 4);
}

function isDistributionTable(table: SmartReportTable): boolean {
  return /分布|明细|占比|构成/.test(table.title)
    || table.columns.includes('占比')
    || table.columns.some((column) => /数量|次数|记录数/.test(column));
}

function normalizePythonRootCauses(value: unknown): SmartReportRootCause[] {
  if (!Array.isArray(value)) return [];
  return value.map((item): SmartReportRootCause | undefined => {
    if (!item || typeof item !== 'object') return undefined;
    const raw = item as Record<string, unknown>;
    const keyword = String(raw.keyword || '').trim();
    const count = Number(raw.count || 0);
    if (!keyword || count <= 0) return undefined;
    return {
      keyword,
      count,
      ratio: Number(raw.ratio || 0),
      evidence: Array.isArray(raw.evidence) ? raw.evidence.map(String).filter(Boolean).slice(0, 3) : [],
    };
  }).filter(isDefined).slice(0, 10);
}

function normalizeRecordValues(row: Record<string, unknown>): Record<string, string | number> {
  const next: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      next[key] = value;
    } else if (typeof value === 'boolean') {
      next[key] = value ? '是' : '否';
    } else if (value !== null && value !== undefined) {
      next[key] = String(value);
    } else {
      next[key] = '';
    }
  }
  return next;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function rowsToCsv(rows: Array<Record<string, unknown>>): string {
  const columns = uniqueStrings(rows.flatMap((row) => Object.keys(row)));
  if (columns.length === 0) return '';
  const lines = [
    columns.map(escapeCsvCell).join(','),
    ...rows.map((row) => columns.map((column) => escapeCsvCell(row[column])).join(',')),
  ];
  return lines.join('\n');
}

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

async function writeReportNarrative({
  userQuery,
  plan,
  rowCount,
  tables,
  artifacts,
  businessKnowledgePrompt,
}: {
  userQuery: string;
  plan: ReportPlan;
  rowCount: number;
  tables: SmartTableContext[];
  artifacts: {
    metrics: SmartReportMetric[];
    charts: SmartReportChart[];
    tables: SmartReportTable[];
    rootCauses: SmartReportRootCause[];
  };
  businessKnowledgePrompt: string;
}): Promise<{ narrative: ReportNarrative; usage: DeepSeekUsage | null }> {
  const fallback = buildFallbackNarrative(userQuery, rowCount, artifacts);
  try {
    const { content: text, usage } = await callDeepSeek(
      [
        { role: 'system', content: REPORT_WRITER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: JSON.stringify({
            userQuery,
            businessKnowledge: businessKnowledgePrompt,
            plan: {
              title: plan.title,
              reason: plan.reason,
              filters: plan.filters,
              timeRange: plan.timeRange,
              narrativeFocus: plan.narrativeFocus,
            },
            rowCount,
            dataSources: tables.map((table) => ({
              name: table.name,
              physicalTableName: table.physical_table_name,
              fields: getAvailableFields([table]).slice(0, 80),
            })),
            metrics: artifacts.metrics,
            charts: artifacts.charts.map((chart) => ({
              id: chart.id,
              title: chart.title,
              type: chart.type,
              dimension: chart.dimension,
              measures: chart.measures,
              topData: chart.data.slice(0, 8),
            })),
            rootCauses: artifacts.rootCauses.slice(0, 8),
          }),
        },
      ],
      { thinking: false, reasoningEffort: 'high', temperature: 0.28 }
    );
    const parsed = JSON.parse(extractJson(text)) as Partial<{
      executiveSummary: string;
      sections: SmartReportSection[];
      chartExplanations: SmartReportChartExplanation[];
      finalSummary: SmartReportFinalSummary;
      recommendations: string[];
    }>;

    return {
      narrative: {
        executiveSummary: typeof parsed.executiveSummary === 'string' ? parsed.executiveSummary : fallback.executiveSummary,
        sections: Array.isArray(parsed.sections) && parsed.sections.length > 0 ? parsed.sections : fallback.sections,
        chartExplanations: normalizeChartExplanations(parsed.chartExplanations, artifacts.charts, fallback.chartExplanations),
        recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String).filter(Boolean).slice(0, 5) : fallback.recommendations,
        finalSummary: normalizeFinalSummary(parsed.finalSummary, fallback.finalSummary),
      },
      usage,
    };
  } catch {
    return { narrative: fallback, usage: null };
  }
}

function buildFallbackNarrative(
  userQuery: string,
  rowCount: number,
  artifacts: {
    charts: SmartReportChart[];
    rootCauses: SmartReportRootCause[];
  }
): ReportNarrative {
  const firstChart = artifacts.charts[0];
  const measure = firstChart?.measures[0] || '数量';
  const topItem = firstChart?.data[0];
  const topLabel = firstChart && topItem ? String(topItem[firstChart.dimension] || '') : '';
  const topValue = topItem ? Number(topItem[measure] || 0) : 0;
  const topCause = artifacts.rootCauses[0];

  return {
    executiveSummary: `本次围绕“${compactText(userQuery, 48)}”完成报告分析，共命中 ${rowCount} 条记录。${topLabel ? `从${firstChart?.dimension}看，${topLabel}记录最多，共 ${topValue} 条。` : ''}${topCause ? `原声片段中「${topCause.keyword}」提及最高，共 ${topCause.count} 次。` : ''}`,
    sections: [
      {
        heading: '核心发现',
        narrative: '系统已完成数据筛选、维度分布、根因关键词和可视化图表生成。',
        insights: [
          topLabel ? `${firstChart?.dimension}维度 Top1 为「${topLabel}」，共 ${topValue} 条。` : '当前样本可继续补充业务维度后分析。',
          topCause ? `根因关键词 Top1 为「${topCause.keyword}」，占样本 ${topCause.ratio}%。` : '原声片段未匹配到明显根因关键词。',
          `本次生成 ${artifacts.charts.length} 个图表，可用于进一步追问和复盘。`,
        ],
        chartIds: artifacts.charts.map((chart) => chart.id).slice(0, 3),
        tableIds: [],
      },
    ],
    recommendations: [
      topCause ? `优先抽样复核包含「${topCause.keyword}」的原声片段，确认真实故障机制。` : '补充更细的原声片段标签，提升根因识别准确度。',
      topLabel ? `针对「${topLabel}」集中样本建立专项排查清单。` : '按车型、渠道、时间继续拆解问题集中度。',
      '将本报告中的 Top 维度作为下一轮追问条件，继续定位高风险组合。',
    ],
    chartExplanations: artifacts.charts.map((chart) => buildFallbackChartExplanation(chart)),
    finalSummary: {
      summary: `样本共 ${rowCount} 条，已完成分布、趋势和根因分析。${topLabel ? `重点集中在「${topLabel}」。` : ''}${topCause ? `首要根因关键词为「${topCause.keyword}」。` : ''}`,
      analysisGroups: [
        {
          title: '关键集中点',
          points: [
            topLabel ? `${firstChart?.dimension}维度中「${topLabel}」最集中，共 ${topValue} 条。` : '当前样本尚未形成明显的维度集中点。',
            `本次命中 ${rowCount} 条记录，适合继续做高频组合和原声抽样。`,
          ],
        },
        {
          title: '根因线索',
          points: [
            topCause ? `原声关键词「${topCause.keyword}」提及最高，共 ${topCause.count} 次，占样本 ${topCause.ratio}%。` : '当前原声片段未匹配到稳定高频根因关键词。',
            '关键词结果代表文本提及频次，需要结合原声语义和业务标签复核。',
          ],
        },
        {
          title: '复核方向',
          points: [
            topCause ? `优先复核包含「${topCause.keyword}」的原声样本。` : '补充根因词库或引入主题聚类提升文本归因。',
            topLabel ? `针对「${topLabel}」建立专项跟进清单。` : '按车型、渠道和时间继续拆解问题集中度。',
          ],
        },
      ],
      positives: [
        artifacts.charts.length > 0 ? '已形成可按车型、标签或时间继续拆解的结构化视图。' : '已完成基础样本筛选。',
        topCause ? '原声片段中已出现可追踪的高频原因线索。' : '当前样本未出现单一压倒性关键词。',
      ],
      risks: [
        rowCount === 0 ? '当前筛选条件下没有命中记录，可能需要核对标签或时间范围。' : '关键词统计只能代表文本提及频次，不能直接等同于真实故障占比。',
        '仍需抽样核验原声片段，避免标签误标或描述噪声影响判断。',
      ],
      actions: [
        topCause ? `优先复核包含「${topCause.keyword}」的原声样本。` : '补充根因词库或引入主题聚类提升文本归因。',
        topLabel ? `针对「${topLabel}」建立专项跟进清单。` : '按车型、渠道和时间继续拆解问题集中度。',
      ],
    },
  };
}

function normalizeChartExplanations(
  value: unknown,
  charts: SmartReportChart[],
  fallback: SmartReportChartExplanation[]
): SmartReportChartExplanation[] {
  if (!Array.isArray(value)) return fallback;
  const explanations = value
    .map((item): SmartReportChartExplanation | undefined => {
      if (!item || typeof item !== 'object') return undefined;
      const raw = item as Record<string, unknown>;
      const chartId = String(raw.chartId || raw.id || '').trim();
      const chart = charts.find((candidate) => candidate.id === chartId);
      if (!chart) return undefined;
      const explanation = String(raw.explanation || '').trim();
      if (!explanation) return undefined;
      return {
        chartId: chart.id,
        title: String(raw.title || chart.title),
        explanation,
      };
    })
    .filter(isDefined);

  const missing = charts
    .filter((chart) => !explanations.some((item) => item.chartId === chart.id))
    .map((chart) => buildFallbackChartExplanation(chart));

  return [...explanations, ...missing].slice(0, charts.length);
}

function buildFallbackChartExplanation(chart: SmartReportChart): SmartReportChartExplanation {
  const measure = chart.measures[0] || '数量';
  const first = chart.data[0];
  const firstName = first ? String(first[chart.dimension] || '') : '';
  const firstValue = first
    ? chart.type === 'stackedBar'
      ? chart.measures.reduce((sum, item) => sum + Number(first[item] || 0), 0)
      : Number(first[measure] || 0)
    : 0;
  const explanation = firstName
    ? `${chart.title}中，「${firstName}」排名最高，共 ${firstValue} 条，建议优先作为后续拆解和抽样复核对象。`
    : `${chart.title}当前没有明显可展示的数据，建议核对筛选条件或补充样本。`;

  return {
    chartId: chart.id,
    title: chart.title,
    explanation,
  };
}

function normalizeFinalSummary(value: unknown, fallback: SmartReportFinalSummary): SmartReportFinalSummary {
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Record<string, unknown>;
  return {
    summary: typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary : fallback.summary,
    analysisGroups: normalizeAnalysisGroups(raw.analysisGroups, fallback.analysisGroups),
    positives: normalizeStringList(raw.positives, fallback.positives),
    risks: normalizeStringList(raw.risks, fallback.risks),
    actions: normalizeStringList(raw.actions, fallback.actions),
  };
}

function normalizeAnalysisGroups(value: unknown, fallback?: SmartReportAnalysisGroup[]): SmartReportAnalysisGroup[] | undefined {
  if (!Array.isArray(value)) return fallback;
  const groups = value
    .map((item): SmartReportAnalysisGroup | undefined => {
      if (!item || typeof item !== 'object') return undefined;
      const raw = item as Record<string, unknown>;
      const title = String(raw.title || '').trim();
      const points = normalizeStringList(raw.points, []);
      if (!title || points.length === 0) return undefined;
      return { title: compactText(title, 16), points: points.slice(0, 4) };
    })
    .filter(isDefined)
    .slice(0, 4);

  return groups.length > 0 ? groups : fallback;
}

function normalizeStringList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const list = value.map(String).map((item) => item.trim()).filter(Boolean);
  return list.length > 0 ? list.slice(0, 5) : fallback;
}

function buildReportSteps(plan: ReportPlan, tables: SmartTableContext[], rowCount: number, chartCount: number, usedPython: boolean): SmartReportStep[] {
  const sourceNames = tables.map((table) => table.name).join('、');
  return [
    {
      id: 'intent',
      title: '意图识别：生成报告',
      description: plan.reason || '该问题需要数据查询、根因分析和图表展示。',
      status: 'completed',
    },
    {
      id: 'source',
      title: '确认数据来源',
      description: sourceNames ? `使用已选智能问数表：${sourceNames}` : '使用已选智能问数表。',
      status: 'completed',
    },
    {
      id: 'sql',
      title: '生成并执行 SQL',
      description: `完成筛选查询，返回 ${rowCount} 条分析样本。`,
      status: 'completed',
    },
    {
      id: 'analysis',
      title: usedPython ? '执行 pandas 分析代码' : '执行受控分析器',
      description: usedPython
        ? '模型生成 Python pandas 代码，完成清洗、维度分布、时间趋势和原声片段根因关键词统计。'
        : '完成维度分布、时间趋势和原声片段根因关键词统计。',
      status: 'completed',
    },
    {
      id: 'chart',
      title: '生成可视化图表',
      description: chartCount > 0 ? '已根据任务规划生成相关可视化图表。' : '当前样本不足，暂未生成有效图表。',
      status: 'completed',
    },
    {
      id: 'summary',
      title: '撰写智能总结',
      description: '基于结构化统计结果生成业务洞察和处置建议。',
      status: 'completed',
    },
  ];
}

function buildReportThinking(report: SmartReport, plan: ReportPlan, rowCount: number, usedPython: boolean): string {
  const filters = (plan.filters || [])
    .map((filter) => `${filter.field || ''}${filter.operator || '='}${filter.value || ''}`)
    .filter(Boolean)
    .join('；');
  const chartTitles = report.charts.map((chart) => chart.title).join('、') || '暂无图表';

  return [
    `意图识别：生成报告。${report.classification.reason}`,
    `数据来源：${report.dataSources.join('、') || '已选智能问数表'}`,
    plan.timeRange?.label ? `时间范围：${plan.timeRange.label}${plan.timeRange.start && plan.timeRange.end ? `（${plan.timeRange.start} 至 ${plan.timeRange.end}）` : ''}` : '',
    filters ? `筛选条件：${filters}` : '',
    `执行 SQL 查询并获得 ${rowCount} 条记录。`,
    usedPython
      ? '执行分析：模型生成 pandas 代码，读取 SQL 结果 CSV，完成清洗、根因关键词统计、维度分布和趋势/占比计算。'
      : '执行分析：使用内置受控分析器完成根因关键词统计、维度分布、趋势/占比计算。',
    `生成图表：${chartTitles}。`,
    '生成报告：汇总核心发现、风险原因和后续处置建议。',
  ].filter(Boolean).join('\n');
}

function buildReportFollowUps(report: SmartReport): string[] {
  const firstChart = report.charts[0];
  const firstRootCause = report.rootCauses[0];
  return [
    firstChart ? `继续拆解${firstChart.dimension}` : '继续拆解高频问题',
    firstRootCause ? `查看${firstRootCause.keyword}原声` : '查看原声样本',
    '生成处置跟踪报告',
  ].slice(0, 3);
}

function buildReportTitle(userQuery: string): string {
  const normalized = userQuery.replace(/\s+/g, '').trim();
  if (/车辆[起启]动异常/.test(normalized)) return '车辆启动异常根因分析报告';
  if (/周报/.test(normalized)) return 'VOC 数据分析周报';
  if (/月报/.test(normalized)) return 'VOC 数据分析月报';
  return `${compactText(userQuery, 22)}分析报告`;
}

function buildReportSubtitle(plan: ReportPlan, _rowCount: number): string {
  const parts = [
    (plan.filters || []).map((filter) => `${filter.field || ''}${filter.operator || '='}${filter.value || ''}`).filter(Boolean).join('，'),
  ].filter(Boolean);
  return parts.join(' · ');
}

function normalizeReportTimeRange(plan: ReportPlan): SmartReport['timeRange'] {
  if (!plan.timeRange) return undefined;
  return {
    label: plan.timeRange.label,
    field: plan.timeRange.field,
    start: plan.timeRange.start,
    end: plan.timeRange.end,
  };
}

function getAvailableFields(tables: SmartTableContext[], rows: Array<Record<string, unknown>> = []): string[] {
  const fields: string[] = [];
  for (const row of rows.slice(0, 3)) {
    fields.push(...Object.keys(row));
  }
  for (const table of tables) {
    for (const row of table.sample_rows || []) {
      fields.push(...Object.keys(row));
    }
    for (const column of Array.isArray(table.columns) ? table.columns : []) {
      const sourceName = column.sourceName || column.source_name;
      if (column.name) fields.push(column.name);
      if (sourceName) fields.push(sourceName);
    }
  }
  return uniqueStrings(fields.map(String).filter(Boolean));
}

function resolveFieldName(field: string, rows: Array<Record<string, unknown>>, tables: SmartTableContext[]): string | undefined {
  const fields = getAvailableFields(tables, rows);
  if (!field) return undefined;
  const normalizedTarget = normalizeField(field);
  return fields.find((candidate) => normalizeField(candidate) === normalizedTarget)
    || fields.find((candidate) => normalizeField(candidate).includes(normalizedTarget) || normalizedTarget.includes(normalizeField(candidate)));
}

function findFieldByKeywords(fields: string[], keywords: string[]): string | undefined {
  for (const keyword of keywords) {
    const normalizedKeyword = normalizeField(keyword);
    const matched = fields.find((field) => normalizeField(field) === normalizedKeyword)
      || fields.find((field) => normalizeField(field).includes(normalizedKeyword));
    if (matched) return matched;
  }
  return undefined;
}

function normalizeField(value: unknown): string {
  return String(value ?? '').replace(/[\s_"'`.-]/g, '').toLowerCase();
}

function extractLikelyTagValue(userQuery: string): string {
  const quoted = userQuery.match(/[“"']([^”"']{2,30})[”"']/);
  if (quoted?.[1]) return quoted[1].trim();

  const equalMatch = userQuery.match(/(?:等于|为|是|=)\s*([^，。,.；;\s]{2,30})/);
  if (equalMatch?.[1]) return equalMatch[1].replace(/的数据$/, '').trim();

  const known = ['车辆起动异常', '车辆启动异常', '启动异常', '起动异常'];
  return known.find((item) => userQuery.includes(item)) || '';
}

function normalizeChartType(type: unknown): Exclude<ReportChartType, 'table'> {
  if (type === 'line' || type === 'pie' || type === 'donut' || type === 'bar' || type === 'stackedBar') return type;
  return 'bar';
}

function normalizeRenderableChartType(type: unknown): Exclude<ReportChartType, 'table'> {
  return normalizeChartType(type);
}

function normalizeCellValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  if (!text || text.toLowerCase() === 'null' || text.toLowerCase() === 'undefined') return '';
  return compactText(text, 36);
}

function compactText(value: unknown, maxLength: number): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function normalizeId(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || `chart_${Date.now()}`;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(Math.round(value), min), max);
}

function getDefaultReportDateRange(): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end);
  start.setFullYear(start.getFullYear() - 1);
  return {
    start: formatDateOnly(start),
    end: formatDateOnly(end),
  };
}

function formatDateOnly(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

async function ensureChatSession({
  conversationId,
  userQuery,
  tables,
}: {
  conversationId?: string;
  userQuery: string;
  tables: SmartTableContext[];
}): Promise<string> {
  const selectedTableIds = tables.map((table) => table.id);
  const selectedTableNames = tables.map((table) => table.name);

  if (conversationId) {
    const updated = await pgQuery<{ id: string }>(
      `UPDATE chat_sessions
       SET selected_table_ids = $2::jsonb,
           selected_table_names = $3::jsonb,
           expires_at = NOW() + INTERVAL '30 days'
       WHERE id = $1
         AND expires_at > NOW()
       RETURNING id`,
      [conversationId, JSON.stringify(selectedTableIds), JSON.stringify(selectedTableNames)]
    );

    if (updated.rows[0]?.id) return updated.rows[0].id;
  }

  const title = buildSessionTitle(userQuery);
  const created = await pgQuery<{ id: string }>(
    `INSERT INTO chat_sessions (title, selected_table_ids, selected_table_names, expires_at)
     VALUES ($1, $2::jsonb, $3::jsonb, NOW() + INTERVAL '30 days')
     RETURNING id`,
    [title, JSON.stringify(selectedTableIds), JSON.stringify(selectedTableNames)]
  );

  return created.rows[0].id;
}

async function insertChatMessage({
  sessionId,
  role,
  content,
  thinking,
  sqlText,
  sources = [],
  metadata = {},
  status = 'success',
  errorMessage,
}: {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  sqlText?: string;
  sources?: string[];
  metadata?: Record<string, unknown>;
  status?: 'success' | 'failure';
  errorMessage?: string;
}): Promise<string> {
  const chartPayload = metadata.chart && typeof metadata.chart === 'object' ? metadata.chart : null;

  const result = await pgQuery<{ id: string }>(
    `INSERT INTO chat_messages (session_id, role, content, thinking, sql_text, sources, chart, metadata, status, error_message)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
     RETURNING id`,
    [
      sessionId,
      role,
      content,
      thinking || null,
      sqlText || null,
      JSON.stringify(sources),
      chartPayload ? JSON.stringify(chartPayload) : null,
      JSON.stringify(metadata),
      status,
      errorMessage || null,
    ]
  );

  return result.rows[0]?.id || '';
}

async function insertChatArtifact({
  sessionId,
  messageId,
  artifactType,
  title,
  summary,
  sqlText,
  filters = {},
  dimensions = [],
  measures = [],
  data,
  metadata = {},
}: InsertChatArtifactInput): Promise<void> {
  if (!messageId) return;
  await pgQuery(
    `INSERT INTO chat_artifacts (
       session_id, message_id, artifact_type, title, summary, sql_text,
       filters, dimensions, measures, data, metadata
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb)`,
    [
      sessionId,
      messageId,
      artifactType,
      title || null,
      summary || null,
      sqlText || null,
      JSON.stringify(filters || {}),
      JSON.stringify(dimensions || []),
      JSON.stringify(measures || []),
      data === undefined ? null : JSON.stringify(data),
      JSON.stringify(metadata || {}),
    ]
  );
}

async function loadConversationContext(sessionId: string): Promise<ConversationContext> {
  const result = await pgQuery<StoredChatMessageRow>(
    `SELECT id, role, content, thinking, sql_text, sources, chart, metadata, created_at
     FROM chat_messages
     WHERE session_id = $1
       AND role IN ('user', 'assistant')
       AND status = 'success'
     ORDER BY created_at DESC
     LIMIT $2`,
    [sessionId, MAX_HISTORY_MESSAGES]
  );
  const recentMessages = [...result.rows].reverse();
  const artifactResult = await pgQuery<StoredChatArtifactRow>(
    `WITH ranked_artifacts AS (
       SELECT id, session_id, message_id, artifact_type, title, summary, sql_text,
              filters, dimensions, measures, data, metadata, created_at,
              ROW_NUMBER() OVER (ORDER BY created_at ASC) AS artifact_index,
              COUNT(*) OVER () AS artifact_count
       FROM chat_artifacts
       WHERE session_id = $1
     )
     SELECT id, session_id, message_id, artifact_type, title, summary, sql_text,
            filters, dimensions, measures, data, metadata, created_at,
            artifact_index, artifact_count
     FROM ranked_artifacts
     WHERE artifact_index <= 3
        OR artifact_index > GREATEST(artifact_count - $2, 0)
     ORDER BY artifact_index ASC`,
    [sessionId, MAX_CONTEXT_ARTIFACTS]
  );
  const recentArtifacts = artifactResult.rows;

  return {
    recentMessages,
    recentArtifacts,
    artifactSummary: buildStoredArtifactsSummary(recentArtifacts),
  };
}

function buildConversationContextMessages(context: ConversationContext, userQuery: string): DeepSeekMessage[] {
  let userQuestionIndex = 0;
  const recentMessages = context.recentMessages.reduce<DeepSeekMessage[]>((messages, message) => {
    if (message.role === 'user') userQuestionIndex += 1;
    const content = buildStoredHistoryContent(message, message.role === 'user' ? userQuestionIndex : undefined);
    if (!content) return messages;
    const maxLen = message.role === 'user' ? MAX_HISTORY_USER_CHARS : MAX_HISTORY_ASSISTANT_CHARS;
    messages.push({
      role: message.role as 'user' | 'assistant',
      content: compactText(content, maxLen),
    });
    return messages;
  }, []);

  const referenceSummary = resolveArtifactReferenceSummary(userQuery, context.recentArtifacts);
  const artifactMessage: DeepSeekMessage[] = context.artifactSummary
    ? [{
        role: 'assistant',
        content: [
          '【数据库恢复的结构化问数上下文】',
          '引用规则：当用户说“刚才/上面/其中/这个”时优先使用最近一次 artifact；当用户说“第N张图/图表N”时优先使用报告内图表编号；当用户说“第N个问题/第一次/第N次查询”时优先使用 Artifact N 或用户问题编号；当用户说“TopN里的X/只看X/把异常点展开”时优先在 artifact 的实体候选和Top数据中匹配；当用户说“沿用筛选条件”时继承匹配 artifact 的筛选线索和 SQL WHERE 条件。',
          referenceSummary,
          context.artifactSummary,
        ].filter(Boolean).join('\n\n'),
      }]
    : [];

  return [...recentMessages, ...artifactMessage];
}

function buildStoredHistoryContent(message: StoredChatMessageRow, userQuestionIndex?: number): string {
  const label = message.role === 'user'
    ? `用户问题#${userQuestionIndex || '?'}`
    : '助手回答';
  const parts = [
    `${label}：${message.content}`,
    message.sql_text ? `SQL：${compactText(message.sql_text, 700)}` : '',
  ].filter(Boolean);

  return parts.join('\n\n');
}

function buildStoredArtifactsSummary(artifacts: StoredChatArtifactRow[]): string {
  if (artifacts.length === 0) return '';
  return artifacts
    .map((artifact, index) => buildStoredArtifactSummary(artifact, getArtifactIndex(artifact) || index + 1, index === artifacts.length - 1))
    .join('\n\n---\n\n');
}

function buildStoredArtifactSummary(artifact: StoredChatArtifactRow, order: number, isLatest: boolean): string {
  const metadata = asRecord(artifact.metadata);
  const dimensions = normalizeStoredStringList(artifact.dimensions);
  const measures = normalizeStoredStringList(artifact.measures);
  const followUps = normalizeStoredStringList(metadata?.followUps).slice(0, 5);
  const filterSummary = buildStoredFilterSummary(artifact.filters, metadata);
  const dataSummary = buildStoredArtifactDataSummary(artifact);

  return [
    `Artifact ${order}${isLatest ? '（最近一次）' : ''}`,
    `类型：${artifact.artifact_type}`,
    artifact.title ? `标题：${artifact.title}` : '',
    artifact.summary ? `摘要：${compactText(artifact.summary, 800)}` : '',
    artifact.sql_text ? `SQL：\n${compactText(artifact.sql_text, 1200)}` : '',
    filterSummary ? `筛选线索：${filterSummary}` : '',
    dimensions.length > 0 ? `维度：${dimensions.join('、')}` : '',
    measures.length > 0 ? `指标：${measures.join('、')}` : '',
    dataSummary,
    followUps.length > 0 ? `建议追问：${followUps.join('；')}` : '',
  ].filter(Boolean).join('\n\n');
}

function buildStoredArtifactDataSummary(artifact: StoredChatArtifactRow): string {
  if (artifact.artifact_type === 'chart') {
    const chart = normalizeStoredChart(artifact.data);
    return chart ? buildStoredChartSummary(chart) : '';
  }
  if (artifact.artifact_type === 'report') {
    const report = normalizeStoredReport(artifact.data);
    return report ? buildStoredReportSummary(report) : '';
  }
  if (artifact.artifact_type === 'simple_query') {
    const rows = Array.isArray(artifact.data) ? artifact.data.slice(0, 8) : [];
    if (rows.length === 0) return '';
    return `结果样例：${rows.map((row) => compactText(JSON.stringify(row), 180)).join('；')}`;
  }
  return '';
}

function buildSqlFilterArtifact(sql: string): Record<string, string> {
  const whereClause = extractSqlWhereClause(sql);
  return whereClause ? { sqlWhere: whereClause } : {};
}

function buildReportFilterArtifact(plan: ReportPlan): Record<string, unknown> {
  return {
    timeRange: plan.timeRange || null,
    filters: plan.filters || [],
  };
}

function extractSqlWhereClause(sql: string): string {
  const match = sql.match(/\bwhere\b([\s\S]*?)(\bgroup\s+by\b|\border\s+by\b|\blimit\b|$)/i);
  return match?.[1] ? compactText(match[1].trim(), 900) : '';
}

function buildStoredFilterSummary(filters: unknown, metadata?: Record<string, unknown>): string {
  const filterRecord = asRecord(filters);
  const parts: string[] = [];

  const sqlWhere = typeof filterRecord?.sqlWhere === 'string' ? filterRecord.sqlWhere : '';
  if (sqlWhere) parts.push(`SQL WHERE: ${compactText(sqlWhere, 500)}`);

  const timeRange = asRecord(filterRecord?.timeRange);
  if (timeRange) {
    const label = [timeRange.label, timeRange.start && timeRange.end ? `${timeRange.start}至${timeRange.end}` : '']
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join('，');
    if (label) parts.push(`时间范围: ${label}`);
  }

  const reportFilters = Array.isArray(filterRecord?.filters) ? filterRecord.filters : [];
  if (reportFilters.length > 0) {
    parts.push(`报告筛选: ${reportFilters
      .map((item) => {
        const raw = asRecord(item);
        if (!raw) return '';
        return `${raw.field || ''}${raw.operator || '='}${raw.value || ''}`;
      })
      .filter(Boolean)
      .join('；')}`);
  }

  const chartSpec = asRecord(metadata?.chartSpec);
  if (chartSpec) {
    const dimension = typeof chartSpec.dimension === 'string' ? chartSpec.dimension : '';
    const measure = typeof chartSpec.measure === 'string' ? chartSpec.measure : '';
    if (dimension || measure) parts.push(`图表口径: ${dimension ? `维度=${dimension}` : ''}${measure ? `，指标=${measure}` : ''}`);
  }

  const reportPlan = asRecord(metadata?.reportPlan);
  const reportPlanTimeRange = asRecord(reportPlan?.timeRange);
  if (reportPlanTimeRange && !timeRange) {
    const label = [reportPlanTimeRange.label, reportPlanTimeRange.start && reportPlanTimeRange.end ? `${reportPlanTimeRange.start}至${reportPlanTimeRange.end}` : '']
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join('，');
    if (label) parts.push(`报告时间范围: ${label}`);
  }

  return parts.join('；');
}

function resolveArtifactReferenceSummary(userQuery: string, artifacts: StoredChatArtifactRow[]): string {
  if (artifacts.length === 0) return '';

  const lines: string[] = [];
  const latestArtifact = artifacts[artifacts.length - 1];
  const chartNumber = extractReferencedChartNumber(userQuery);
  const artifactNumber = extractReferencedArtifactNumber(userQuery);
  const topLimit = extractTopLimit(userQuery);
  const matchedChartPoints = findReferencedChartPoints(userQuery, artifacts);
  const matchedEntities = findReferencedEntities(userQuery, artifacts);
  const asksLatest = /刚才|上面|上述|其中|这个|该|继续|基于|沿用|只看|展开/.test(userQuery);
  const asksFilterInheritance = /沿用|继承|同样|相同|刚才.*筛选|上面.*条件|筛选条件/.test(userQuery);
  const asksAnomaly = /异常|最高|最低|突增|突降|波动|拐点|展开|拆解/.test(userQuery);

  if (artifactNumber) {
    const targetArtifact = findArtifactByIndex(artifacts, artifactNumber);
    lines.push(targetArtifact
      ? `用户引用 Artifact ${artifactNumber}：优先使用该 artifact 的标题、SQL、筛选线索、维度指标和结果样例。`
      : `用户引用 Artifact ${artifactNumber}，但当前上下文未加载到该 artifact；如无法确认应反问用户。`);
  }

  if (chartNumber) {
    const chartMatch = findReferencedReportChart(artifacts, chartNumber);
    if (chartMatch) {
      lines.push(`用户引用图表#${chartNumber}：${chartMatch.reportTitle} / ${chartMatch.chartTitle}，维度=${chartMatch.dimension}，指标=${chartMatch.measures.join('/') || '数量'}。`);
    } else {
      lines.push(`用户引用图表#${chartNumber}：优先在最近 report artifact 的图表编号中查找；若不存在则反问确认。`);
    }
  }

  if (asksLatest && latestArtifact) {
    lines.push(`用户存在承接表达：默认引用最近一次 Artifact ${getArtifactIndex(latestArtifact) || artifacts.length}（${latestArtifact.artifact_type}，${latestArtifact.title || '未命名'}）。`);
  }

  if (topLimit) {
    lines.push(`用户提到 Top${topLimit}：优先在匹配 artifact 的 Top 数据或实体候选中限定前 ${topLimit} 项。`);
  }

  if (matchedChartPoints.length > 0) {
    lines.push(`用户引用了上一轮图表点位：${matchedChartPoints.slice(0, 5).join('；')}。后续 SQL 必须继承该 artifact 的筛选线索，并追加该点位对应的原始维度条件；如果用户同时提到点位数值，应以该点位数值作为样本集合预期，不要扩大到其它日期或默认时间范围。`);
  }

  if (matchedEntities.length > 0) {
    lines.push(`用户提到的实体命中 artifact：${matchedEntities.slice(0, 8).join('；')}。后续 SQL 应优先把这些实体作为筛选条件。`);
  }

  if (asksFilterInheritance) {
    const target = artifactNumber ? findArtifactByIndex(artifacts, artifactNumber) || latestArtifact : latestArtifact;
    const filterSummary = target ? buildStoredFilterSummary(target.filters, asRecord(target.metadata)) : '';
    lines.push(filterSummary
      ? `用户要求沿用筛选：继承 ${target?.title || '最近 artifact'} 的筛选线索：${filterSummary}。`
      : '用户要求沿用筛选：优先复用匹配 artifact 的 SQL WHERE 条件；如果没有明确条件则基于当前问题重新判断。');
  }

  if (asksAnomaly) {
    lines.push('用户可能在要求展开异常点：优先查找 artifact Top数据中的最高/最低/突变项，生成更细维度或时间趋势查询。');
  }

  return lines.length > 0 ? `【当前追问引用解析】\n${lines.join('\n')}` : '';
}

function findArtifactByIndex(artifacts: StoredChatArtifactRow[], artifactIndex: number): StoredChatArtifactRow | undefined {
  return artifacts.find((artifact) => getArtifactIndex(artifact) === artifactIndex);
}

function getArtifactIndex(artifact: StoredChatArtifactRow): number | undefined {
  const index = Number(artifact.artifact_index);
  return Number.isFinite(index) && index > 0 ? index : undefined;
}

function findReferencedReportChart(
  artifacts: StoredChatArtifactRow[],
  chartNumber: number
): { reportTitle: string; chartTitle: string; dimension: string; measures: string[] } | undefined {
  for (const artifact of [...artifacts].reverse()) {
    if (artifact.artifact_type !== 'report') continue;
    const report = normalizeStoredReport(artifact.data);
    const chart = report?.charts[chartNumber - 1];
    if (report && chart) {
      return {
        reportTitle: report.title,
        chartTitle: chart.title,
        dimension: chart.dimension,
        measures: chart.measures,
      };
    }
  }
  const chartArtifacts = artifacts.filter((artifact) => artifact.artifact_type === 'chart');
  const chartArtifact = chartArtifacts[chartNumber - 1];
  const chart = chartArtifact ? normalizeStoredChart(chartArtifact.data) : undefined;
  if (chart) {
    return {
      reportTitle: `Artifact ${getArtifactIndex(chartArtifact) || chartNumber}`,
      chartTitle: chart.title,
      dimension: normalizeStoredStringList(chartArtifact.dimensions)[0] || 'name',
      measures: normalizeStoredStringList(chartArtifact.measures),
    };
  }
  return undefined;
}

function findReferencedChartPoints(userQuery: string, artifacts: StoredChatArtifactRow[]): string[] {
  const matches: string[] = [];
  const queryCounts = extractCountNumbersFromText(userQuery);

  for (const [artifactIndex, artifact] of artifacts.entries()) {
    const charts = collectArtifactCharts(artifact);
    for (const chart of charts) {
      for (const row of chart.rows) {
        const label = String(row.name || '');
        const rawDimensionValue = String(row.rawDimensionValue || '');
        const value = Number(row.value || 0);
        const matchedDateOrLabel = matchesReferenceLabel(userQuery, label) || matchesReferenceLabel(userQuery, rawDimensionValue);
        const matchedValue = queryCounts.length === 0 || queryCounts.includes(value);
        if (!matchedDateOrLabel || !matchedValue) continue;

        matches.push([
          `Artifact ${getArtifactIndex(artifact) || artifactIndex + 1}`,
          chart.title ? `图表=${chart.title}` : '',
          `点位=${label}`,
          rawDimensionValue && rawDimensionValue !== label ? `原始值=${rawDimensionValue}` : '',
          `数值=${value}`,
          chart.dimension ? `维度=${chart.dimension}` : '',
        ].filter(Boolean).join('，'));
      }
    }
  }

  return uniqueStrings(matches);
}

function collectArtifactCharts(artifact: StoredChatArtifactRow): Array<{
  title: string;
  dimension: string;
  rows: Array<Record<string, string | number>>;
}> {
  if (artifact.artifact_type === 'chart') {
    const chart = normalizeStoredChart(artifact.data);
    return chart
      ? [{
          title: chart.title,
          dimension: normalizeStoredStringList(artifact.dimensions)[0] || 'name',
          rows: chart.data,
        }]
      : [];
  }

  if (artifact.artifact_type === 'report') {
    const report = normalizeStoredReport(artifact.data);
    if (!report) return [];
    return report.charts.map((chart) => ({
      title: chart.title,
      dimension: chart.dimension,
      rows: chart.data.map((row) => ({
        name: String(row[chart.dimension] ?? ''),
        rawDimensionValue: String(row[chart.dimension] ?? ''),
        value: Number(row[chart.measures[0] || '数量'] || 0),
      })),
    }));
  }

  return [];
}

function matchesReferenceLabel(userQuery: string, label: string): boolean {
  if (!label) return false;
  const normalizedQuery = normalizeReferenceText(userQuery);
  const normalizedLabel = normalizeReferenceText(label);
  if (normalizedLabel.length >= 2 && normalizedQuery.includes(normalizedLabel)) return true;

  return buildDateReferenceAliases(label).some((alias) => normalizeReferenceText(alias).length >= 2 && normalizedQuery.includes(normalizeReferenceText(alias)));
}

function buildDateReferenceAliases(value: string): string[] {
  const text = String(value || '').trim();
  const aliases = new Set<string>();
  aliases.add(text);

  const iso = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  const md = text.match(/^(\d{1,2})[/-](\d{1,2})$/);
  const cn = text.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/);
  const month = iso ? Number(iso[2]) : md ? Number(md[1]) : cn ? Number(cn[1]) : undefined;
  const day = iso ? Number(iso[3]) : md ? Number(md[2]) : cn ? Number(cn[2]) : undefined;
  const year = iso ? iso[1] : undefined;

  if (month && day) {
    aliases.add(`${month}/${day}`);
    aliases.add(`${month}-${day}`);
    aliases.add(`${month}月${day}日`);
    aliases.add(`${month}月${day}号`);
    aliases.add(`${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
    if (year) {
      aliases.add(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
      aliases.add(`${year}年${month}月${day}日`);
    }
  }

  return Array.from(aliases);
}

function extractCountNumbersFromText(text: string): number[] {
  return uniqueStrings(Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s*(?:条|个|项|次|辆|例|件)/g)).map((match) => match[1]))
    .map(Number)
    .filter((value) => Number.isFinite(value));
}

function findReferencedEntities(userQuery: string, artifacts: StoredChatArtifactRow[]): string[] {
  const normalizedQuery = normalizeReferenceText(userQuery);
  const matches: string[] = [];

  for (const [artifactIndex, artifact] of artifacts.entries()) {
    const labels = collectArtifactEntityLabels(artifact);
    for (const label of labels) {
      const normalizedLabel = normalizeReferenceText(label);
      if (normalizedLabel.length < 2) continue;
      if (normalizedQuery.includes(normalizedLabel)) {
        matches.push(`Artifact ${artifactIndex + 1}：${label}`);
      }
    }
  }

  return uniqueStrings(matches);
}

function collectArtifactEntityLabels(artifact: StoredChatArtifactRow): string[] {
  if (artifact.artifact_type === 'chart') {
    const chart = normalizeStoredChart(artifact.data);
    return chart ? chart.data.map((row) => String(row.name || '')).filter(Boolean) : [];
  }

  if (artifact.artifact_type === 'report') {
    const report = normalizeStoredReport(artifact.data);
    if (!report) return [];
    return uniqueStrings([
      ...report.metrics.map((metric) => String(metric.label || '')),
      ...report.rootCauses.map((cause) => String(cause.keyword || '')),
      ...report.charts.flatMap((chart) => chart.data.map((row) => String(row[chart.dimension] ?? ''))),
    ]);
  }

  if (artifact.artifact_type === 'simple_query' && Array.isArray(artifact.data)) {
    return uniqueStrings(
      artifact.data
        .slice(0, 20)
        .flatMap((row) => Object.values(asRecord(row) || {}).map((value) => String(value || '')))
    );
  }

  return [];
}

function extractReferencedChartNumber(text: string): number | undefined {
  const match = text.match(/(?:第\s*([一二三四五六七八九十\d]+)\s*张\s*图|图表\s*#?\s*([一二三四五六七八九十\d]+))/i);
  return parseReferenceNumber(match?.[1] || match?.[2]);
}

function extractReferencedArtifactNumber(text: string): number | undefined {
  const match = text.match(/第\s*([一二三四五六七八九十\d]+)\s*(?:个|次|轮)?\s*(?:问题|查询|结果|分析|artifact)/i)
    || text.match(/第\s*([一二三四五六七八九十\d]+)\s*次/);
  return parseReferenceNumber(match?.[1]);
}

function extractTopLimit(text: string): number | undefined {
  const match = text.match(/(?:top\s*([0-9]+)|前\s*([一二三四五六七八九十\d]+)\s*(?:个|名|项)?)/i);
  return parseReferenceNumber(match?.[1] || match?.[2]);
}

function parseReferenceNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return Math.round(numeric);
  const digitMap: Record<string, number> = {
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (value === '十') return 10;
  if (value.startsWith('十')) return 10 + (digitMap[value.slice(1)] || 0);
  if (value.endsWith('十')) return (digitMap[value.slice(0, -1)] || 1) * 10;
  if (value.includes('十')) {
    const [ten, one] = value.split('十');
    return (digitMap[ten] || 1) * 10 + (digitMap[one] || 0);
  }
  return digitMap[value];
}

function normalizeReferenceText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase();
}

function buildStoredChartSummary(chart: ChartData): string {
  const summary = chart.summary
    ? `完整总量=${chart.summary.totalValue}，完整维度=${chart.summary.totalGroups}，展示合计=${chart.summary.displayedValue}，展示维度=${chart.summary.displayedGroups}${chart.summary.isTruncated ? `，未展示合计=${chart.summary.hiddenValue}，未展示维度=${chart.summary.hiddenGroups}` : ''}`
    : '';
  const topRows = chart.data
    .slice(0, 12)
    .map((row) => {
      const rawDimensionValue = row.rawDimensionValue && row.rawDimensionValue !== row.name
        ? `raw=${row.rawDimensionValue}`
        : '';
      const extras = Object.entries(row)
        .filter(([key]) => key !== 'name' && key !== 'value' && key !== 'color' && key !== 'rawDimensionValue')
        .slice(0, 4)
        .map(([key, value]) => `${key}=${value}`);
      return [row.name, rawDimensionValue, `value=${row.value}`, ...extras].filter(Boolean).join('，');
    })
    .join('；');

  return [
    '上一轮图表 artifact：',
    `标题：${chart.title || '未命名图表'}`,
    chart.subtitle ? `说明：${chart.subtitle}` : '',
    `类型：${chart.type}`,
    summary ? `总量口径：${summary}` : '',
    topRows ? `数据：${topRows}` : '',
  ].filter(Boolean).join('\n');
}

function buildStoredReportSummary(report: SmartReport): string {
  const metricSummary = report.metrics
    .slice(0, 5)
    .map((metric) => `${metric.label}=${metric.value}`)
    .join('；');
  const chartSummary = report.charts
    .slice(0, 5)
    .map((chart, index) => {
      const measure = chart.measures[0] || '数量';
      const topRows = chart.data
        .slice(0, 4)
        .map((row) => {
          if (chart.type === 'stackedBar') {
            const seriesValues = chart.measures.map((item) => `${item}=${row[item] ?? 0}`).join('/');
            return `${row[chart.dimension] ?? ''}:${seriesValues}`;
          }
          return `${row[chart.dimension] ?? ''}:${row[measure] ?? ''}`;
        })
        .filter(Boolean)
        .join('、');
      return `图表#${index + 1} ${chart.title}（${chart.type}，维度=${chart.dimension}，指标=${chart.measures.join('/') || measure}${topRows ? `，Top=${topRows}` : ''}）`;
    })
    .join('；');

  return [
    '上一轮报告 artifact：',
    `标题：${report.title}`,
    `样本量：${report.recordCount}`,
    report.executiveSummary ? `报告摘要：${compactText(report.executiveSummary, 500)}` : '',
    report.finalSummary?.summary ? `最终结论：${compactText(report.finalSummary.summary, 500)}` : '',
    metricSummary ? `核心指标：${metricSummary}` : '',
    chartSummary ? `图表摘要：${chartSummary}` : '',
  ].filter(Boolean).join('\n');
}

function normalizeStoredChart(value: unknown): ChartData | undefined {
  const raw = asRecord(value);
  if (!raw || typeof raw.title !== 'string' || typeof raw.type !== 'string' || !Array.isArray(raw.data)) return undefined;
  const validTypes = ['bar', 'donut', 'line', 'pie', 'stackedBar'];
  if (!validTypes.includes(raw.type)) return undefined;
  return raw as unknown as ChartData;
}

function normalizeStoredReport(value: unknown): SmartReport | undefined {
  const raw = asRecord(value);
  if (!raw || typeof raw.title !== 'string' || !Array.isArray(raw.charts) || !Array.isArray(raw.metrics)) return undefined;
  return raw as unknown as SmartReport;
}

function normalizeStoredStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

async function loadSmartTableContexts(tableIds: string[]): Promise<SmartTableContext[]> {
  const result = await pgQuery<SmartTableContextRow>(
    `SELECT id, name, physical_table_name, source_type, source_table_name, file_name, remark, columns, row_count
     FROM smart_tables
     WHERE id = ANY($1::text[])
       AND is_enabled = TRUE
       AND physical_table_name IS NOT NULL
     ORDER BY created_at DESC`,
    [tableIds]
  );

  const contexts: SmartTableContext[] = [];
  for (const table of result.rows) {
    const sampleRows = await loadSampleRows(table.physical_table_name);
    const valueExamples = await loadValueExamples(table, sampleRows);
    contexts.push({ ...table, sample_rows: sampleRows, value_examples: valueExamples });
  }

  return contexts;
}

async function loadValueExamples(
  table: SmartTableContextRow,
  sampleRows: Array<Record<string, unknown>>,
): Promise<Record<string, string[]>> {
  const candidateFields = getValueExampleFields(table, sampleRows);
  const examples: Record<string, string[]> = {};

  for (const field of candidateFields) {
    try {
      const result = await pgQuery<{ value: string }>(
        `SELECT ${quoteIdent(field)}::text AS value
         FROM ${quoteIdent(table.physical_table_name)}
         WHERE ${quoteIdent(field)} IS NOT NULL
           AND TRIM(${quoteIdent(field)}::text) <> ''
         GROUP BY ${quoteIdent(field)}
         ORDER BY COUNT(*) DESC
         LIMIT 40`
      );
      const values = result.rows.map((row) => String(row.value || '').trim()).filter(Boolean);
      if (values.length > 0) examples[field] = values;
    } catch {
      // Some configured display fields may not map to physical columns. Skip them.
    }
  }

  return examples;
}

function getValueExampleFields(table: SmartTableContextRow, sampleRows: Array<Record<string, unknown>>): string[] {
  const sampleFields = uniqueStrings(sampleRows.flatMap((row) => Object.keys(row)));
  const configuredFields = Array.isArray(table.columns)
    ? table.columns.flatMap((column) => [column.name, column.sourceName, column.source_name]).map((field) => String(field || '')).filter(Boolean)
    : [];
  const fields = uniqueStrings([...sampleFields, ...configuredFields]);
  const semanticKeywords = [
    '车系',
    '车型',
    '车款',
    '品牌',
    '竞品',
    '意图',
    '标签',
    '渠道',
    '来源',
    '情感',
    '五级',
    '四级',
    '三级',
    '二级',
    '一级',
    '词云',
    '关键词',
  ];

  return fields
    .filter((field) => semanticKeywords.some((keyword) => normalizeField(field).includes(normalizeField(keyword))))
    .slice(0, 10);
}

async function loadSampleRows(physicalTableName: string): Promise<Array<Record<string, unknown>>> {
  const result = await pgQuery<Record<string, unknown> & QueryResultRow>(
    `SELECT * FROM ${quoteIdent(physicalTableName)} LIMIT 10`
  );

  return result.rows.map((row) => sanitizeRow(row, 140));
}

function buildTableContextPrompt(tables: SmartTableContext[]): string {
  const tableBlocks = tables.map((table) => {
    const columnLines = (Array.isArray(table.columns) ? table.columns : []).map((column) => {
      const sourceName = column.sourceName || column.source_name || column.name || '';
      const displayName = column.name || sourceName;
      const comment = column.comment ? `，业务含义：${column.comment}` : '';
      return `- "${displayName}" 类型：${column.type || 'string'}，源字段："${sourceName}"${comment}`;
    });
    const valueExampleLines = Object.entries(table.value_examples || {})
      .map(([field, values]) => `- "${field}" 常见值示例（非全量）：${values.slice(0, 40).join('、')}`);

    return [
      `表别名：${table.name}`,
      `PostgreSQL 中间表名："${table.physical_table_name}"`,
      `来源：${table.source_table_name || table.file_name || table.source_type}`,
      `表备注：${table.remark || '无'}`,
      `行数：${table.row_count}`,
      `字段：`,
      columnLines.join('\n') || '- 暂无字段配置',
      valueExampleLines.length > 0 ? `关键维度字段值示例（仅用于理解口径，不代表全量值域）：` : '',
      valueExampleLines.join('\n'),
      `前 10 行样例 JSON：`,
      JSON.stringify(table.sample_rows, null, 2),
    ].join('\n');
  });

  return `已选择智能问数表如下：\n\n${tableBlocks.join('\n\n')}`;
}

function buildKnowledgeLookupTerms(userQuery: string, tables: SmartTableContext[]): string[] {
  const normalizedQuery = normalizeKnowledgeText(userQuery).slice(0, 180);
  if (normalizedQuery.length < 2) return [];

  const terms: string[] = [normalizedQuery];
  const businessTerms = [
    '竞品分析',
    '竞品',
    '横向对比',
    '对比分析',
    '五级标签',
    '末级标签',
    '三级渠道',
    '投诉量',
    '客诉数',
    '反馈数',
    '投诉意图',
    '用户词云',
    '词云',
    '高频词',
    '关键词',
    '用户原声',
    '原声片段',
    '车系',
    '车型',
    '渠道',
    '标签',
    '负面率',
    '集中度',
    '环比',
    '同比',
    '趋势',
    '根因',
    '异常点',
  ];

  for (const term of businessTerms) {
    if (userQuery.includes(term)) terms.push(term);
  }

  for (const match of userQuery.matchAll(/(?:车系|车型)\s*([A-Za-z0-9_\-\u4e00-\u9fa5]{1,24})(?=的|在|和|与|及|、|，|,|。|；|;|\s|$)/g)) {
    if (match[0]) terms.push(match[0]);
    if (match[1]) terms.push(match[1]);
  }

  for (const field of getAvailableFields(tables)) {
    const normalizedField = normalizeKnowledgeText(field);
    if (normalizedField.length >= 2 && normalizedQuery.includes(normalizedField)) {
      terms.push(field);
    }
  }

  const maxLength = Math.min(normalizedQuery.length, 120);
  for (let length = 2; length <= 8; length += 1) {
    for (let start = 0; start <= maxLength - length; start += 1) {
      terms.push(normalizedQuery.slice(start, start + length));
      if (terms.length >= 700) {
        return uniqueStrings(terms.map(normalizeKnowledgeText).filter((term) => term.length >= 2)).slice(0, 700);
      }
    }
  }

  return uniqueStrings(terms.map(normalizeKnowledgeText).filter((term) => term.length >= 2)).slice(0, 700);
}

async function loadRelevantKnowledge(userQuery: string, tables: SmartTableContext[]): Promise<RelevantKnowledgeItem[]> {
  try {
    const lookupTerms = buildKnowledgeLookupTerms(userQuery, tables);
    if (lookupTerms.length === 0) return [];

    const result = await pgQuery<KnowledgeCandidateRow>(
      `SELECT k.id,
              k.title,
              k.category,
              k.standard_term,
              k.aliases,
              k.keywords,
              k.content,
              k.field_name,
              k.formula,
              k.business_domain,
              k.applicable_intents,
              k.priority,
              k.status,
              COALESCE(SUM(t.weight), 0) AS term_score,
              COALESCE(jsonb_agg(DISTINCT t.term) FILTER (WHERE t.term IS NOT NULL), '[]'::jsonb) AS matched_terms
       FROM knowledge_item_terms t
       INNER JOIN knowledge_items k ON k.id = t.item_id
       WHERE k.status = 'active'
         AND t.normalized_term = ANY($1::text[])
       GROUP BY k.id
       ORDER BY term_score DESC, k.priority DESC, k.updated_at DESC NULLS LAST, k.created_at DESC
       LIMIT $2`,
      [lookupTerms, MAX_KNOWLEDGE_CANDIDATES]
    );

    const fields = getAvailableFields(tables);
    return result.rows
      .map((row) => {
        const item = normalizeKnowledgeRow(row);
        return { ...item, score: scoreKnowledgeItem(item, userQuery, fields) };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || b.priority - a.priority)
      .slice(0, MAX_RELEVANT_KNOWLEDGE);
  } catch {
    return [];
  }
}

function normalizeKnowledgeRow(row: KnowledgeItemRow | KnowledgeCandidateRow): RelevantKnowledgeItem {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    standardTerm: row.standard_term || '',
    aliases: normalizeKnowledgeStringList(row.aliases),
    keywords: normalizeKnowledgeStringList(row.keywords),
    content: row.content,
    fieldName: row.field_name || '',
    formula: row.formula || '',
    priority: Number(row.priority || 50),
    termScore: Number('term_score' in row ? row.term_score : 0),
    matchedTerms: normalizeKnowledgeStringList('matched_terms' in row ? row.matched_terms : []),
    score: 0,
  };
}

function scoreKnowledgeItem(item: RelevantKnowledgeItem, userQuery: string, fields: string[]): number {
  const queryText = normalizeKnowledgeText(userQuery);
  const matchTexts = uniqueStrings([
    item.title,
    item.standardTerm,
    item.fieldName,
    ...item.aliases,
    ...item.keywords,
  ].filter(Boolean));
  let lexicalScore = 0;

  for (const text of matchTexts) {
    const normalized = normalizeKnowledgeText(text);
    if (!normalized || normalized.length < 2) continue;
    if (queryText.includes(normalized)) lexicalScore += 24;
    if (normalized.includes(queryText) && queryText.length >= 2) lexicalScore += 8;
  }

  let score = item.termScore * 10 + lexicalScore;
  if (score <= 0) return 0;

  if (item.category === 'scenario' && /报告|分析|竞品|对比|根因|趋势|异常/.test(userQuery)) score += 4;
  if (item.category === 'metric' && /率|占比|数量|多少|集中度|环比|同比|top|Top|TOP/.test(userQuery)) score += 3;
  if (item.category === 'field_mapping' && /字段|维度|分布|词云|标签|渠道|意图/.test(userQuery)) score += 3;
  if (item.fieldName && fields.some((field) => normalizeField(field) === normalizeField(item.fieldName))) score += 2;

  return score + Math.min(Math.max(item.priority, 0), 100) / 25;
}

function buildBusinessKnowledgePrompt(items: RelevantKnowledgeItem[]): string {
  if (items.length === 0) return '';

  const lines = items.map((item, index) => {
    const parts = [
      `${index + 1}. [${formatKnowledgeCategory(item.category)}] ${item.title}`,
      item.standardTerm ? `标准词=${item.standardTerm}` : '',
      item.fieldName ? `字段=${item.fieldName}` : '',
      item.aliases.length > 0 ? `别名=${item.aliases.slice(0, 8).join('/')}` : '',
      item.keywords.length > 0 ? `关键词=${item.keywords.slice(0, 8).join('/')}` : '',
      item.matchedTerms.length > 0 ? `命中词=${item.matchedTerms.slice(0, 6).join('/')}` : '',
      item.formula ? `口径=${item.formula}` : '',
      `规则=${compactText(item.content, 220)}`,
    ].filter(Boolean);
    return parts.join('；');
  });

  return [
    '知识中心命中语义（必须优先遵守，用于理解业务语言、字段映射、指标口径和场景规则；若与真实字段冲突，以当前数据表字段为准）：',
    ...lines,
  ].join('\n');
}

function formatKnowledgeCategory(category: string): string {
  const labels: Record<string, string> = {
    concept: '业务概念',
    synonym: '同义词',
    field_mapping: '字段映射',
    metric: '指标口径',
    scenario: '场景规则',
    example: '语料案例',
    rule: '推理规则',
  };
  return labels[category] || category;
}

function normalizeKnowledgeStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return parsed.map((item) => String(item).trim()).filter(Boolean);
    } catch {
      return value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function normalizeKnowledgeText(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase();
}

async function shouldEnableReasoningForFollowUp(userQuery: string, historyMessages: DeepSeekMessage[]): Promise<boolean> {
  if (historyMessages.length === 0) return false;

  const recentHistory = historyMessages
    .slice(-6)
    .map((message) => `${message.role === 'user' ? '用户' : '助手'}：${compactText(message.content, 900)}`)
    .join('\n\n');

  try {
    const { content } = await callDeepSeek(
      [
        {
          role: 'system',
          content: [
            '你是多轮数据问答相关性分类器，只判断当前问题是否依赖上一轮或更早的输出结果。',
            '如果当前问题引用了上一轮图表、报告、SQL、筛选条件、Top项、某个上一轮出现的车型/标签/维度，或使用“刚才、继续、基于、这个、上面、其中、它”等承接表达，返回 related=true。',
            '如果当前问题是一个可独立回答的新查询，即使同属数据分析，也返回 related=false。',
            '只输出 JSON：{"related":true|false,"reason":"简短原因"}',
          ].join('\n'),
        },
        {
          role: 'user',
          content: [
            `历史上下文：\n${recentHistory}`,
            `当前问题：${userQuery}`,
          ].join('\n\n'),
        },
      ],
      { thinking: false, reasoningEffort: 'high', temperature: 0 }
    );
    const parsed = JSON.parse(extractJson(content)) as { related?: unknown };
    return parsed.related === true;
  } catch {
    return false;
  }
}

function estimateContextChars(messages: DeepSeekMessage[]): number {
  return messages.reduce((sum, msg) => sum + msg.content.length, 0);
}

function buildAnswerPrompt({
  userQuery,
  sql,
  rows,
  tables,
  businessKnowledgePrompt,
}: {
  userQuery: string;
  sql: string;
  rows: Array<Record<string, unknown>>;
  tables: SmartTableContext[];
  businessKnowledgePrompt: string;
}): string {
  const stats = summarizeQueryRows(rows);
  return [
    businessKnowledgePrompt,
    `用户问题：${userQuery}`,
    `已选表：${tables.map((table) => `${table.name}("${table.physical_table_name}")`).join('、')}`,
    `已执行 SQL：\n${sql}`,
    stats,
  ].join('\n\n');
}

function summarizeQueryRows(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return '查询结果：**0 条**记录';

  const keys = Object.keys(rows[0] || {});
  const numKeys = keys.filter((k) => typeof rows[0]?.[k] === 'number');
  const strKeys = keys.filter((k) => typeof rows[0]?.[k] === 'string');

  if (rows.length === 1 && numKeys.length === 1 && strKeys.length <= 1) {
    return `查询结果（单一数值）：**${rows[0][numKeys[0]]}**${strKeys[0] ? `（${strKeys[0]}：${rows[0][strKeys[0]]}）` : ''}`;
  }

  const parts = [`查询结果：共 **${rows.length}** 条记录`];

  if (numKeys.length > 0) {
    for (const nk of numKeys.slice(0, 2)) {
      const values = rows.map((r) => Number(r[nk]) || 0);
      const total = values.reduce((a, b) => a + b, 0);
      const avg = total / rows.length;
      const max = Math.max(...values);
      const min = Math.min(...values);
      parts.push(`「${nk}」：总计 **${total.toLocaleString()}**，均值 **${avg.toFixed(1)}**，范围 **${min.toLocaleString()}** ~ **${max.toLocaleString()}**`);
    }
  }

  // Top 5 条明细
  if (rows.length > 1) {
    parts.push(`明细数据（前 5 条）：\n${JSON.stringify(rows.slice(0, 5).map((r) => sanitizeRow(r, 120)), null, 2)}`);
  } else {
    parts.push(`明细数据：\n${JSON.stringify(rows.map((r) => sanitizeRow(r, 120)), null, 2)}`);
  }

  return parts.join('\n');
}

async function generateFollowUps({
  userQuery,
  answer,
  tables,
  businessKnowledgePrompt,
}: {
  userQuery: string;
  answer: string;
  tables: SmartTableContext[];
  businessKnowledgePrompt: string;
}): Promise<{ followUps: string[]; usage: DeepSeekUsage | null }> {
  try {
    const { content: text, usage } = await callDeepSeek(
      [
        { role: 'system', content: FOLLOW_UP_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            buildTableContextPrompt(tables),
            businessKnowledgePrompt,
            `用户问题：${userQuery}`,
            `当前回答：${answer}`,
          ].join('\n\n'),
        },
      ],
      { thinking: false, reasoningEffort: 'high', temperature: 0.35 }
    );

    const parsed = JSON.parse(extractJson(text)) as { followUps?: unknown };
    if (!Array.isArray(parsed.followUps)) return { followUps: [], usage };

    return {
      followUps: parsed.followUps
        .map((item) => String(item).trim())
        .filter(Boolean)
        .filter((item) => !/sku/i.test(item))
        .slice(0, 3),
      usage,
    };
  } catch {
    return { followUps: [], usage: null };
  }
}

async function executeReadOnlySql(
  sql: string,
  options: { limit?: number; maxTextLength?: number } = {}
): Promise<Array<Record<string, unknown>>> {
  const limit = clampNumber(options.limit || 200, 1, 20000);
  const maxTextLength = clampNumber(options.maxTextLength || 500, 80, 2000);
  const executableSql = `SELECT * FROM (${sql}) AS voc_result LIMIT ${limit}`;
  const queryTimeoutMs = 25_000;

  const doQuery = async (): Promise<Array<Record<string, unknown>>> => {
    const client = await getPgPool().connect();
    try {
      await client.query(`SET statement_timeout = '${queryTimeoutMs}ms'`);
      await client.query('BEGIN READ ONLY');
      const result = await client.query<Record<string, unknown> & QueryResultRow>(executableSql);
      await client.query('ROLLBACK');
      return result.rows.map((row) => sanitizeRow(row, maxTextLength));
    } catch (error) {
      await safeRollback(client);
      throw error;
    } finally {
      client.release();
    }
  };

  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error(`SQL 查询超时（${queryTimeoutMs / 1000}秒），请缩小查询范围或添加更明确的筛选条件`)), queryTimeoutMs);
  });

  return Promise.race([doQuery(), timeout]);
}

async function safeRollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // ignore rollback errors
  }
}

function validateAndNormalizeSql(sql: string, allowedTables: string[]): string {
  const normalized = sql
    .replace(/```sql/gi, '')
    .replace(/```/g, '')
    .trim()
    .replace(/;+$/g, '')
    .trim();

  if (!normalized) throw new Error('模型未生成 SQL');
  if (!/^(select|with)\b/i.test(normalized)) {
    throw new Error('只允许执行 SELECT 查询');
  }
  if (/;/.test(normalized) || /--|\/\*/.test(normalized)) {
    throw new Error('SQL 中包含不允许的注释或多语句');
  }
  if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|merge|vacuum|analyze)\b/i.test(normalized)) {
    throw new Error('SQL 中包含不允许的写入或管理操作');
  }

  const allowedSet = new Set(allowedTables.map((table) => table.toLowerCase()));
  const referencedTables = extractReferencedTables(normalized);
  const hasAllowedTable = referencedTables.some((table) => allowedSet.has(table.toLowerCase()));

  if (!hasAllowedTable) {
    throw new Error('SQL 未引用已选择的智能问数表');
  }

  const disallowedTable = referencedTables.find((table) => !allowedSet.has(table.toLowerCase()));
  if (disallowedTable) {
    throw new Error(`SQL 引用了未选择的数据表：${disallowedTable}`);
  }

  return normalized;
}

const SQL_KEYWORDS = new Set([
  'lateral', 'only', 'natural', 'cross', 'inner', 'outer', 'left', 'right', 'full',
  'using', 'on', 'as', 'where', 'group', 'having', 'order', 'limit', 'offset', 'with',
]);

function extractReferencedTables(sql: string): string[] {
  const cteNames = extractCteNames(sql);
  const tables = new Set<string>();
  const regex = /\b(?:from|join)\s+((?:"[^"]+"|[a-zA-Z_][\w$]*)(?:\s*\.\s*(?:"[^"]+"|[a-zA-Z_][\w$]*))?)/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(sql)) !== null) {
    const rawRef = match[1].split('.').pop() || match[1];
    const cleaned = rawRef.trim().replace(/^"|"$/g, '').replace(/""/g, '"');
    if (!SQL_KEYWORDS.has(cleaned.toLowerCase()) && !cteNames.has(cleaned.toLowerCase())) {
      tables.add(cleaned);
    }
  }

  return Array.from(tables);
}

function extractCteNames(sql: string): Set<string> {
  const names = new Set<string>();
  // 匹配单个 CTE 名称：cte_name AS (  或 cte_name(col1,col2) AS (
  const cteNamePattern = /\b((?:"[^"]+"|[a-zA-Z_][\w$]*))\s*(?:\([^)]*\))?\s*as\s*\(/gi;

  // 先找到 WITH 关键字后的起始位置
  const withMatch = /\bwith\b\s+/i.exec(sql);
  if (withMatch) {
    // 从 WITH 之后开始扫描所有 CTE 名称
    const afterWith = sql.slice(withMatch.index + withMatch[0].length);
    let cursor = 0;
    while (cursor < afterWith.length) {
      cteNamePattern.lastIndex = cursor;
      const match = cteNamePattern.exec(afterWith);
      if (!match) break;
      const name = match[1].replace(/^"|"$/g, '');
      names.add(name.toLowerCase());
      cursor = match.index + match[0].length;
    }
  }

  return names;
}

function sanitizeRow(row: Record<string, unknown>, maxTextLength: number): Record<string, unknown> {
  const next: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (key.startsWith('_')) continue;
    if (value instanceof Date) {
      next[key] = value.toISOString();
    } else if (typeof value === 'string' && value.length > maxTextLength) {
      next[key] = `${value.slice(0, maxTextLength)}...`;
    } else {
      next[key] = value;
    }
  }

  return next;
}

function parseSqlPlan(text: string): SqlPlan {
  try {
    const jsonText = extractJson(text);
    const parsed = JSON.parse(jsonText) as Partial<SqlPlan>;
    const validIntents = ['simple_query', 'chart', 'report', 'clarify'] as const;
    const intent = validIntents.includes(parsed.intent as typeof validIntents[number])
      ? (parsed.intent as SqlPlan['intent'])
      : 'simple_query';

    return {
      intent,
      sql: parsed.sql,
      reason: parsed.reason,
      clarifying_question: parsed.clarifying_question,
      chart_spec: intent === 'chart' ? parsed.chart_spec : undefined,
    };
  } catch {
    throw new Error('模型返回的 SQL 计划无法解析');
  }
}

function buildSessionTitle(query: string): string {
  const normalized = query.replace(/\s+/g, ' ').trim();
  if (!normalized) return '新对话';
  return normalized.length > 36 ? `${normalized.slice(0, 36)}...` : normalized;
}

function extractAnswerParts(answer: string): { content: string; sql?: string } {
  const sqlMatch = answer.match(/```sql\s*\n?([\s\S]*?)```/i);
  if (!sqlMatch) return { content: answer.trim() };

  const content = answer
    .replace(sqlMatch[0], '')
    .replace(/\n?\s*(?:已执行\s*)?SQL\s*(?:查询|预览)?\s*[:：]\s*$/i, '')
    .trim();

  return {
    content,
    sql: sqlMatch[1].trim(),
  };
}

function extractJson(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);

  return text;
}

interface DeepSeekUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface DeepSeekResult {
  content: string;
  usage: DeepSeekUsage | null;
}

async function callDeepSeek(
  messages: DeepSeekMessage[],
  options: { thinking: boolean; reasoningEffort: 'high' | 'max'; temperature: number }
): Promise<DeepSeekResult> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('未配置 DEEPSEEK_API_KEY');
  }

  const body: Record<string, unknown> = {
    model: DEEPSEEK_MODEL,
    messages,
    stream: false,
    temperature: options.temperature,
  };

  body.thinking = { type: options.thinking ? 'enabled' : 'disabled' };

  if (options.thinking) {
    body.reasoning_effort = options.reasoningEffort;
  }

  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek 调用失败：${errorText.slice(0, 300)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 未返回内容');

  return { content, usage: data.usage || null };
}

function sseText(
  text: string,
  meta?: {
    sessionId?: string;
    followUps?: string[];
    thinking?: string;
    sql?: string;
    pythonCode?: string;
    report?: SmartReport;
    contextWarning?: boolean;
  }
): Response {
  const encoder = new TextEncoder();
  const chunks = chunkText(text, 60);

  const stream = new ReadableStream({
    start(controller) {
      if (meta?.sessionId || meta?.followUps || meta?.thinking || meta?.sql || meta?.pythonCode || meta?.report || meta?.contextWarning) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          sessionId: meta.sessionId,
          followUps: meta.followUps,
          thinking: meta.thinking,
          sql: meta.sql,
          pythonCode: meta.pythonCode,
          report: meta.report,
          contextWarning: meta.contextWarning,
        })}\n\n`));
      }
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ content: chunk })}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

function chunkText(text: string, size: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks.length > 0 ? chunks : [''];
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
