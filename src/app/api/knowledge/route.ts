import { NextRequest, NextResponse } from 'next/server';
import type { PoolClient, QueryResultRow } from 'pg';
import { isPostgresConfigured, query, transaction } from '@/storage/database/pg-client';

const categories = ['concept', 'synonym', 'field_mapping', 'metric', 'scenario', 'example', 'rule'] as const;
type KnowledgeCategory = (typeof categories)[number];
type KnowledgeStatus = 'active' | 'inactive';

interface KnowledgeItemRow extends QueryResultRow {
  id: string;
  title: string;
  category: KnowledgeCategory;
  standard_term: string | null;
  aliases: unknown;
  keywords: unknown;
  content: string;
  field_name: string | null;
  formula: string | null;
  business_domain: string | null;
  applicable_intents: unknown;
  metadata: unknown;
  priority: number;
  status: KnowledgeStatus;
  created_at: string;
  updated_at: string | null;
}

interface KnowledgeTermInput {
  term: string;
  normalizedTerm: string;
  termType: 'title' | 'standard_term' | 'alias' | 'keyword' | 'field' | 'formula';
  weight: number;
}

const storageUnavailable = () =>
  NextResponse.json(
    { success: false, error: '未配置 PostgreSQL，知识中心暂不可用' },
    { status: 503 }
  );

export async function GET(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: true, data: [] });
    }

    const category = request.nextUrl.searchParams.get('category');
    const status = request.nextUrl.searchParams.get('status') || 'all';
    const where: string[] = [];
    const params: unknown[] = [];

    if (category && categories.includes(category as KnowledgeCategory)) {
      params.push(category);
      where.push(`category = $${params.length}`);
    }

    if (status === 'active' || status === 'inactive') {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    const result = await query<KnowledgeItemRow>(
      `SELECT id, title, category, standard_term, aliases, keywords, content, field_name,
              formula, business_domain, applicable_intents, metadata, priority, status,
              created_at, updated_at
       FROM knowledge_items
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY priority DESC, updated_at DESC NULLS LAST, created_at DESC
       LIMIT 300`,
      params
    );

    return NextResponse.json({ success: true, data: result.rows.map(normalizeKnowledgeItem) });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) return storageUnavailable();

    const body = await request.json();
    const title = String(body.title || '').trim();
    const category = normalizeCategory(body.category);
    const content = String(body.content || '').trim();

    if (!title) {
      return NextResponse.json({ success: false, error: '标题不能为空' }, { status: 400 });
    }
    if (!content) {
      return NextResponse.json({ success: false, error: '知识内容不能为空' }, { status: 400 });
    }

    const result = await transaction(async (client) => {
      const inserted = await client.query<KnowledgeItemRow>(
        `INSERT INTO knowledge_items (
            title, category, standard_term, aliases, keywords, content, field_name, formula,
            business_domain, applicable_intents, metadata, priority, status
         )
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13)
         RETURNING id, title, category, standard_term, aliases, keywords, content, field_name,
                   formula, business_domain, applicable_intents, metadata, priority, status,
                   created_at, updated_at`,
        [
          title,
          category,
          normalizeOptionalString(body.standardTerm),
          JSON.stringify(normalizeStringList(body.aliases)),
          JSON.stringify(normalizeStringList(body.keywords)),
          content,
          normalizeOptionalString(body.fieldName),
          normalizeOptionalString(body.formula),
          normalizeOptionalString(body.businessDomain) || '汽车VOC',
          JSON.stringify(normalizeStringList(body.applicableIntents)),
          JSON.stringify({ source: 'knowledge-center' }),
          clampPriority(body.priority),
          normalizeStatus(body.status),
        ]
      );

      await replaceKnowledgeTerms(client, inserted.rows[0]);
      return inserted;
    });

    return NextResponse.json({ success: true, data: normalizeKnowledgeItem(result.rows[0]) });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) return storageUnavailable();

    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少 id 参数' }, { status: 400 });
    }

    const body = await request.json();
    const title = String(body.title || '').trim();
    const category = normalizeCategory(body.category);
    const content = String(body.content || '').trim();

    if (!title) {
      return NextResponse.json({ success: false, error: '标题不能为空' }, { status: 400 });
    }
    if (!content) {
      return NextResponse.json({ success: false, error: '知识内容不能为空' }, { status: 400 });
    }

    const result = await transaction(async (client) => {
      const updated = await client.query<KnowledgeItemRow>(
        `UPDATE knowledge_items
         SET title = $2,
             category = $3,
             standard_term = $4,
             aliases = $5::jsonb,
             keywords = $6::jsonb,
             content = $7,
             field_name = $8,
             formula = $9,
             business_domain = $10,
             applicable_intents = $11::jsonb,
             metadata = COALESCE(metadata, '{}'::jsonb) || $12::jsonb,
             priority = $13,
             status = $14,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, title, category, standard_term, aliases, keywords, content, field_name,
                   formula, business_domain, applicable_intents, metadata, priority, status,
                   created_at, updated_at`,
        [
          id,
          title,
          category,
          normalizeOptionalString(body.standardTerm),
          JSON.stringify(normalizeStringList(body.aliases)),
          JSON.stringify(normalizeStringList(body.keywords)),
          content,
          normalizeOptionalString(body.fieldName),
          normalizeOptionalString(body.formula),
          normalizeOptionalString(body.businessDomain) || '汽车VOC',
          JSON.stringify(normalizeStringList(body.applicableIntents)),
          JSON.stringify({ source: 'knowledge-center' }),
          clampPriority(body.priority),
          normalizeStatus(body.status),
        ]
      );

      if (updated.rows[0]) {
        await replaceKnowledgeTerms(client, updated.rows[0]);
      }

      return updated;
    });

    if (!result.rows[0]) {
      return NextResponse.json({ success: false, error: '知识条目不存在' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: normalizeKnowledgeItem(result.rows[0]) });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) return storageUnavailable();

    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少 id 参数' }, { status: 400 });
    }

    const body = await request.json();
    const status = normalizeStatus(body.status);
    const result = await query<KnowledgeItemRow>(
      `UPDATE knowledge_items
       SET status = $2, updated_at = NOW()
       WHERE id = $1
       RETURNING id, title, category, standard_term, aliases, keywords, content, field_name,
                 formula, business_domain, applicable_intents, metadata, priority, status,
                 created_at, updated_at`,
      [id, status]
    );

    if (!result.rows[0]) {
      return NextResponse.json({ success: false, error: '知识条目不存在' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: normalizeKnowledgeItem(result.rows[0]) });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) return storageUnavailable();

    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少 id 参数' }, { status: 400 });
    }

    const result = await query<{ id: string }>(
      'DELETE FROM knowledge_items WHERE id = $1 RETURNING id',
      [id]
    );

    if (!result.rows[0]) {
      return NextResponse.json({ success: false, error: '知识条目不存在' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: { id: result.rows[0].id } });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

function normalizeKnowledgeItem(row: KnowledgeItemRow) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    standardTerm: row.standard_term || '',
    aliases: normalizeStringList(row.aliases),
    keywords: normalizeStringList(row.keywords),
    content: row.content,
    fieldName: row.field_name || '',
    formula: row.formula || '',
    businessDomain: row.business_domain || '汽车VOC',
    applicableIntents: normalizeStringList(row.applicable_intents),
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function replaceKnowledgeTerms(client: PoolClient, row: KnowledgeItemRow): Promise<void> {
  await client.query('DELETE FROM knowledge_item_terms WHERE item_id = $1', [row.id]);

  const terms = collectKnowledgeTerms(row);
  if (terms.length === 0) return;

  const values: unknown[] = [];
  const placeholders = terms.map((term, index) => {
    const offset = index * 5;
    values.push(row.id, term.term, term.normalizedTerm, term.termType, term.weight);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`;
  });

  await client.query(
    `INSERT INTO knowledge_item_terms (item_id, term, normalized_term, term_type, weight)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (item_id, normalized_term, term_type)
     DO UPDATE SET term = EXCLUDED.term, weight = EXCLUDED.weight`,
    values
  );
}

function collectKnowledgeTerms(row: KnowledgeItemRow): KnowledgeTermInput[] {
  const terms: KnowledgeTermInput[] = [];
  const seen = new Set<string>();
  const pushTerm = (value: unknown, termType: KnowledgeTermInput['termType'], weight: number) => {
    const term = String(value || '').trim();
    const normalizedTerm = normalizeKnowledgeTerm(term);
    if (!term || normalizedTerm.length < 2) return;
    const key = `${termType}:${normalizedTerm}`;
    if (seen.has(key)) return;
    seen.add(key);
    terms.push({
      term: term.slice(0, 160),
      normalizedTerm: normalizedTerm.slice(0, 160),
      termType,
      weight,
    });
  };

  pushTerm(row.title, 'title', 4);
  pushTerm(row.standard_term, 'standard_term', 5);
  pushTerm(row.field_name, 'field', 4);
  for (const alias of normalizeStringList(row.aliases)) pushTerm(alias, 'alias', 4);
  for (const keyword of normalizeStringList(row.keywords)) pushTerm(keyword, 'keyword', 5);
  if (String(row.formula || '').trim().length <= 160) pushTerm(row.formula, 'formula', 2);

  return terms;
}

function normalizeKnowledgeTerm(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, '').toLowerCase();
}

function normalizeCategory(value: unknown): KnowledgeCategory {
  return categories.includes(value as KnowledgeCategory) ? value as KnowledgeCategory : 'concept';
}

function normalizeStatus(value: unknown): KnowledgeStatus {
  return value === 'inactive' ? 'inactive' : 'active';
}

function normalizeStringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(/[,，、\n]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function normalizeOptionalString(value: unknown): string | null {
  const text = String(value || '').trim();
  return text || null;
}

function clampPriority(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 50;
  return Math.min(Math.max(Math.round(numeric), 0), 100);
}
