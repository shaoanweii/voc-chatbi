import { NextRequest, NextResponse } from 'next/server';
import type { QueryResultRow } from 'pg';
import { isPostgresConfigured, query as pgQuery } from '@/storage/database/pg-client';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-v4-pro';

const QUESTION_SUGGESTION_PROMPT = `你是「VOC 智能问数」的问题推荐助手。

你会收到用户已选择的数据表字段、业务备注、前 10 行样例。
请推荐 3 个点击后可以直接生成 SQL 查询的问题。

要求：
1. 问题必须严格基于表字段和样例内容，不要臆造不存在的字段、对象或业务维度。
2. 如果字段和样例中没有 SKU、订单、销售额、地区等概念，不要出现这些词。
3. 每个问题必须能用单条 SELECT SQL 回答，优先使用计数、分组统计、TopN、占比、时间趋势、条件筛选。
4. 不要推荐“生成报告”“综合分析”“深入分析”“原因是什么”这类需要长报告或主观推理的问题。
5. 问题中尽量包含真实字段名或字段值，例如“用户情感”“四级标签”“品牌”“车系”“日期”等，但必须以当前表为准。
6. 每个问题不超过 24 个中文字符。

推荐风格示例：
- 负面情感最多的四级标签？
- 各品牌反馈数量排名？
- 近30天用户意图分布？

只输出 JSON，不要 Markdown，不要解释。格式：
{
  "questions": ["问题1", "问题2", "问题3"]
}`;

interface SmartTableColumn {
  name?: string;
  type?: string;
  sourceName?: string;
  source_name?: string;
  comment?: string;
}

interface SmartTableRow extends QueryResultRow {
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

interface SmartTableContext extends SmartTableRow {
  sample_rows: Array<Record<string, unknown>>;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const smartTableIds = Array.isArray(body.smartTableIds)
      ? body.smartTableIds.map((id: unknown) => String(id)).filter(Boolean)
      : [];

    if (smartTableIds.length === 0) {
      return NextResponse.json({ success: true, data: [] });
    }

    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL' }, { status: 503 });
    }

    const tables = await loadSmartTableContexts(smartTableIds);
    if (tables.length === 0) {
      return NextResponse.json({ success: true, data: [] });
    }

    const text = await callDeepSeek([
      { role: 'system', content: QUESTION_SUGGESTION_PROMPT },
      { role: 'user', content: buildTableContextPrompt(tables) },
    ]);

    const parsed = JSON.parse(extractJson(text)) as { questions?: unknown };
    const questions = Array.isArray(parsed.questions)
      ? parsed.questions
          .map((item) => String(item).trim())
          .filter(Boolean)
          .filter((item) => !/sku/i.test(item))
          .slice(0, 3)
      : [];

    return NextResponse.json({ success: true, data: questions });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

async function loadSmartTableContexts(tableIds: string[]): Promise<SmartTableContext[]> {
  const result = await pgQuery<SmartTableRow>(
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

async function callDeepSeek(messages: Array<{ role: 'system' | 'user'; content: string }>): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('未配置 DEEPSEEK_API_KEY');

  const response = await fetch(`${DEEPSEEK_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      stream: false,
      temperature: 0.35,
      thinking: { type: 'disabled' },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek 调用失败：${errorText.slice(0, 300)}`);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 未返回内容');

  return content;
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

function extractJson(text: string): string {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);

  return text;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
