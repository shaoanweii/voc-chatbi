import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { PoolClient, QueryResultRow } from 'pg';
import type {
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
/** 单条历史消息最大字符数（assistant 答复合更长，user 问题较短） */
const MAX_HISTORY_USER_CHARS = 500;
const MAX_HISTORY_ASSISTANT_CHARS = 1500;
const DEFAULT_REPORT_SQL_LIMIT = 10000;
const DEFAULT_REPORT_CHART_LIMIT = 10;
const MAX_REPORT_CHART_LIMIT = 20;
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

const ANSWER_SYSTEM_PROMPT = `你是「VOC 智能问数」的数据分析助手。

你会收到用户问题、已执行 SQL、SQL 查询结果。
请基于查询结果回答，不要编造不存在的数据。

回答要求：
1. 先给直接结论。
2. 再用 2-5 条要点说明关键数据。
3. 最后只附一个 \`\`\`sql 代码块，不要写“已执行 SQL”、“SQL 预览”等文字标题。
4. 如果结果为空，说明没有查询到匹配数据，并提示可能的筛选条件问题。
5. 语言简洁，偏业务分析表达。;
6. 禁止在关键数据结论中输出 数据来源xxx等不相关的描述`;

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
7. rootCauses 里的每个对象必须是：
   { "keyword": "...", "count": 1, "ratio": 10.0, "evidence": ["原声片段样例"] }
8. 分布类明细不要输出 tables，优先输出 pie 实心饼图或 bar 柱状图；根因关键词不要输出 tables，输出 rootCauses 即可，系统会转成柱状图。
9. 分布/排行类图表 data 默认只输出 Top ${DEFAULT_REPORT_CHART_LIMIT}；只有用户问题明确写出 topN、Top N、前N、前 N 名等数量时，才输出用户指定数量，禁止默认输出 Top20。
10. 如果数据为空，也要输出空数组和命中记录为 0 的 metric。

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

export async function POST(request: NextRequest) {
  let sessionId: string | undefined;
  let contextWarning = false;
  try {
    const { query, isReasoning, history, smartTableIds, conversationId } = await request.json();
    const reasoningEnabled = isReasoning !== false;

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
    const historyMessages = buildHistoryMessages(history);
    const plannerPrompt = [
      tableContext,
      `用户问题：${query}`,
    ].filter(Boolean).join('\n\n');

    const fullMessages: DeepSeekMessage[] = [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      ...historyMessages,
      { role: 'user', content: plannerPrompt },
    ];
    const contextChars = estimateContextChars(fullMessages);
    contextWarning = contextChars > CONTEXT_WARNING_CHARS;

    const { content: planText, usage: planUsage } = await callDeepSeek(
      fullMessages,
      { thinking: reasoningEnabled, reasoningEffort: 'high', temperature: 0.1 }
    );

    const plan = parseSqlPlanOrFallback(planText, query);
    if (plan.intent === 'report') {
      return streamSmartReportResponse({
        sessionId,
        userQuery: query,
        history,
        tables,
        tableContext,
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
    });
    await insertChatMessage({
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
}: {
  sessionId: string;
  userQuery: string;
  tables: SmartTableContext[];
  reasoningEnabled: boolean;
  intentPlan: SqlPlan;
  contextWarning: boolean;
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
        const { analysis: rawAnalysis, usage: chartAnalysisUsage } = await generateChartAnalysis(userQuery, safeSql, queryRows, chartSpec, reasoningEnabled);
        const analysisContent = rawAnalysis || buildFallbackChartAnalysis(chartData, queryRows.length);
        const { followUps, usage: followUpsUsage } = await generateFollowUps({
          userQuery,
          answer: analysisContent,
          tables,
        });

        await insertChatMessage({
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
): { title: string; subtitle: string; type: 'bar' | 'line' | 'donut' | 'pie' | 'stackedBar'; data: Array<{ name: string; value: number; color: string; [key: string]: string | number }>; series?: string[] } {
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

    const data = rows.slice(0, 15).map((row, index) => {
      const rawName = row[dimKey];
      const name = formatChartLabel(String(rawName ?? `项${index + 1}`), chartSpec?.dimension || '');
      const entries: Record<string, string | number> = { name, value: 0, color: COLORS[index % COLORS.length] };
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

    const subtitle = measure || `${dimKey} × ${seriesLabels.join(' / ')}`;

    return { title, subtitle, type: 'stackedBar', data: data as Array<{ name: string; value: number; color: string; [key: string]: string | number }>, series: seriesLabels };
  }

  const valKey = keys.length > 1
    ? (keys.find((k) => {
        const v = rows[0]?.[k];
        return typeof v === 'number' || (typeof v === 'string' && !isNaN(Number(v)));
      }) || keys[1])
    : keys[0];

  const rawData = rows.slice(0, 30).map((row, index) => {
    const rawName = row[dimKey];
    const name = formatChartLabel(String(rawName ?? `项${index + 1}`), chartSpec?.dimension || '');
    const rawValue = row[valKey];
    const value = typeof rawValue === 'number' ? rawValue : Number(rawValue) || 0;
    return { name, value, color: COLORS[index % COLORS.length] };
  });

  const isProportionChart = chartType === 'pie' || chartType === 'donut';
  const data = isProportionChart ? topNWithOther(rawData, 10) : rawData;

  const subtitle = measure || `${dimKey} × ${valKey}`;

  return { title, subtitle, type: chartType, data };
}

type ChartDataPoint = { name: string; value: number; color: string };

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

async function generateChartAnalysis(
  userQuery: string,
  sql: string,
  rows: Array<Record<string, unknown>>,
  chartSpec: ChartSpec | undefined,
  reasoningEnabled: boolean,
): Promise<{ analysis: string; usage: DeepSeekUsage | null }> {
  const sampleRows = rows.slice(0, 10);
  const prompt = `用户问题：${userQuery}

已执行 SQL：
\`\`\`sql
${sql}
\`\`\`

查询结果（前${sampleRows.length}行）：
${JSON.stringify(sampleRows, null, 2)}

图表类型：${chartSpec?.type || 'bar'}
图表标题：${chartSpec?.title || '数据分析图表'}
维度：${chartSpec?.dimension || '自动识别'}
指标：${chartSpec?.measure || '自动识别'}

请基于以上查询结果，给出简洁的数据分析结论（3-5条要点），不要重复 SQL 代码块。`;

  const { content: answer, usage } = await callDeepSeek(
    [
      { role: 'system', content: '你是「VOC 智能问数」的数据分析助手。请基于查询结果给出简洁的业务分析结论，语言偏业务表达，3-5条要点即可。' },
      { role: 'user', content: prompt },
    ],
    { thinking: reasoningEnabled, reasoningEffort: 'high', temperature: 0.2 }
  );

  return { analysis: answer.trim(), usage };
}

function buildFallbackChartAnalysis(
  chartData: { title: string; type: string; data: Array<{ name: string; value: number }> },
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

  return `共查询到 ${totalRows} 条记录，${chartData.title}的${chartTypeLabel}情况如下：
- 最高值：${maxItem.name}（${maxItem.value}），最低值：${minItem.name}（${minItem.value}）
- 平均值：${avg}
- 共涉及 ${chartData.data.length} 个${chartData.type === 'pie' || chartData.type === 'donut' ? '分类' : '维度'}
以上结论由系统基于查询结果自动生成，仅供参考。`;
}

function streamSmartReportResponse({
  sessionId,
  userQuery,
  history,
  tables,
  tableContext,
  reasoningEnabled,
  intentPlan,
  contextWarning,
}: {
  sessionId: string;
  userQuery: string;
  history: unknown;
  tables: SmartTableContext[];
  tableContext: string;
  reasoningEnabled: boolean;
  intentPlan: SqlPlan;
  contextWarning: boolean;
}): Response {
  const encoder = new TextEncoder();
  const sourceNames = tables.map((table) => table.name);

  const stream = new ReadableStream({
    async start(controller) {
      let streamedContent = '';
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
          history,
          tables,
          tableContext,
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

        await insertChatMessage({
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
  history,
  tables,
  tableContext,
  reasoningEnabled,
  onProgress,
}: {
  userQuery: string;
  history: unknown;
  tables: SmartTableContext[];
  tableContext: string;
  reasoningEnabled: boolean;
  onProgress?: ReportProgressCallback;
}): Promise<SmartReportBuildResult> {
  const historyMessages = buildHistoryMessages(history);
  const planPrompt = [
    tableContext,
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
        ...historyMessages,
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
  const artifacts = generatedPython?.artifacts || fallbackArtifacts;
  onProgress?.(`报告撰写：为每张图表生成业务解读和最终摘要。\n`);
  onProgress?.(`思考中...\n`);
  const { narrative, usage: narrativeUsage } = await writeReportNarrative({
    userQuery,
    plan: reportPlan,
    rowCount: queryRows.length,
    tables,
    artifacts,
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

    const distribution = buildDistributionRows(rows, dimension, limit);
    if (distribution.length === 0) continue;
    charts.push({
      id: normalizeId(chartPlan.id || `${dimension}_distribution`),
      title: chartPlan.title || `${dimension}分布`,
      subtitle: `Top ${distribution.length}，按记录数统计`,
      type: chartType,
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
  const firstValue = first ? Number(first[measure] || 0) : 0;
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
  if (type === 'line' || type === 'pie' || type === 'donut' || type === 'bar') return type;
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
}): Promise<void> {
  await pgQuery(
    `INSERT INTO chat_messages (session_id, role, content, thinking, sql_text, sources, metadata, status, error_message)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)`,
    [
      sessionId,
      role,
      content,
      thinking || null,
      sqlText || null,
      JSON.stringify(sources),
      JSON.stringify(metadata),
      status,
      errorMessage || null,
    ]
  );
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
    contexts.push({ ...table, sample_rows: sampleRows });
  }

  return contexts;
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

    return [
      `表别名：${table.name}`,
      `PostgreSQL 中间表名："${table.physical_table_name}"`,
      `来源：${table.source_table_name || table.file_name || table.source_type}`,
      `表备注：${table.remark || '无'}`,
      `行数：${table.row_count}`,
      `字段：`,
      columnLines.join('\n') || '- 暂无字段配置',
      `前 10 行样例 JSON：`,
      JSON.stringify(table.sample_rows, null, 2),
    ].join('\n');
  });

  return `已选择智能问数表如下：\n\n${tableBlocks.join('\n\n')}`;
}

function buildHistoryMessages(history: unknown): DeepSeekMessage[] {
  if (!Array.isArray(history) || history.length === 0) return [];

  return history
    .slice(-MAX_HISTORY_MESSAGES)
    .filter((item): item is { role: string; content: string } => (
      Boolean(item) &&
      typeof item === 'object' &&
      (item as { role?: unknown }).role === 'user' || (item as { role?: unknown }).role === 'assistant' &&
      typeof (item as { content?: unknown }).content === 'string'
    ))
    .map((item) => {
      const maxLen = item.role === 'user' ? MAX_HISTORY_USER_CHARS : MAX_HISTORY_ASSISTANT_CHARS;
      const truncated = item.content.length > maxLen
        ? `${item.content.slice(0, maxLen)}...[已截断]`
        : item.content;
      return { role: item.role as 'user' | 'assistant', content: truncated };
    });
}

function estimateContextChars(messages: DeepSeekMessage[]): number {
  return messages.reduce((sum, msg) => sum + msg.content.length, 0);
}

function buildAnswerPrompt({
  userQuery,
  sql,
  rows,
  tables,
}: {
  userQuery: string;
  sql: string;
  rows: Array<Record<string, unknown>>;
  tables: SmartTableContext[];
}): string {
  return [
    `用户问题：${userQuery}`,
    `已选表：${tables.map((table) => `${table.name}("${table.physical_table_name}")`).join('、')}`,
    `已执行 SQL：\n${sql}`,
    `查询结果行数：${rows.length}`,
    `查询结果 JSON：\n${JSON.stringify(rows.map((row) => sanitizeRow(row, 220)), null, 2)}`,
  ].join('\n\n');
}

async function generateFollowUps({
  userQuery,
  answer,
  tables,
}: {
  userQuery: string;
  answer: string;
  tables: SmartTableContext[];
}): Promise<{ followUps: string[]; usage: DeepSeekUsage | null }> {
  try {
    const { content: text, usage } = await callDeepSeek(
      [
        { role: 'system', content: FOLLOW_UP_SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            buildTableContextPrompt(tables),
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
