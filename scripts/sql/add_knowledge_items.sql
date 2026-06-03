-- 一次性执行：创建汽车 VOC 知识中心语料表
-- psql "postgresql://USER:PASSWORD@HOST:5432/DB_NAME" -f scripts/sql/add_knowledge_items.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS knowledge_items (
    id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    title VARCHAR(160) NOT NULL,
    category VARCHAR(32) NOT NULL CHECK (category IN (
        'concept',
        'synonym',
        'field_mapping',
        'metric',
        'scenario',
        'example',
        'rule'
    )),
    standard_term VARCHAR(120),
    aliases JSONB NOT NULL DEFAULT '[]',
    keywords JSONB NOT NULL DEFAULT '[]',
    content TEXT NOT NULL,
    field_name VARCHAR(120),
    formula TEXT,
    business_domain VARCHAR(80) DEFAULT '汽车VOC',
    applicable_intents JSONB NOT NULL DEFAULT '[]',
    metadata JSONB NOT NULL DEFAULT '{}',
    priority INTEGER NOT NULL DEFAULT 50,
    status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS knowledge_items_category_idx ON knowledge_items(category);
CREATE INDEX IF NOT EXISTS knowledge_items_status_idx ON knowledge_items(status);
CREATE INDEX IF NOT EXISTS knowledge_items_priority_idx ON knowledge_items(priority DESC);
CREATE INDEX IF NOT EXISTS knowledge_items_standard_term_idx ON knowledge_items(standard_term);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_items_category_title_uidx ON knowledge_items(category, title);

INSERT INTO knowledge_items (
    title,
    category,
    standard_term,
    aliases,
    keywords,
    content,
    field_name,
    applicable_intents,
    priority
) VALUES
(
    '五级标签业务解释',
    'concept',
    '五级标签',
    '["末级标签", "问题点", "最细标签"]',
    '["五级", "末级", "问题点", "标签分布"]',
    '五级标签通常表示汽车 VOC 中最细粒度的问题点，适合用于问题构成、竞品差异、根因线索和 Top 问题分析。用户提到末级标签、问题点时，优先理解为五级标签维度。',
    '五级标签',
    '["chart", "report"]',
    95
),
(
    '三级渠道业务解释',
    'concept',
    '三级渠道',
    '["渠道来源", "触点来源", "来源渠道"]',
    '["三级渠道", "渠道", "来源", "触点"]',
    '三级渠道表示用户反馈来源或触点层级，适合分析不同渠道的问题集中度、竞品渠道差异和负面反馈来源。',
    '三级渠道',
    '["chart", "report"]',
    90
),
(
    '投诉量指标口径',
    'metric',
    '投诉量',
    '["反馈数", "客诉数", "记录数", "声量"]',
    '["投诉量", "反馈数", "客诉数", "记录数", "声量"]',
    '投诉量在当前智能问数中默认按命中记录数统计，SQL 通常使用 COUNT(*) 或按明细行聚合；除非用户明确指定去重口径，不要自行改成去重用户数或去重车辆数。',
    NULL,
    '["simple_query", "chart", "report"]',
    100
),
(
    '竞品分析场景规则',
    'scenario',
    '竞品分析',
    '["横向对比", "对比分析", "竞对分析"]',
    '["竞品", "对比", "车系A", "车系B", "横向"]',
    '用户要求多个车系或车型做竞品分析时，应优先围绕同一维度生成多系列对比图，不要把每个车系拆成多张相同图。常见维度包括五级标签、三级渠道、投诉意图、情感和用户原声关键词。',
    NULL,
    '["report", "chart"]',
    100
),
(
    '用户词云字段映射',
    'field_mapping',
    '用户词云',
    '["高频词", "关键词分布", "用户怎么说", "原声词云"]',
    '["词云", "高频词", "关键词", "原声", "用户怎么说"]',
    '用户提到词云、高频词、关键词分布时，优先从原声片段、用户原声、反馈内容、评论内容等文本字段提取关键词，而不是从标签字段直接替代。',
    '原声片段',
    '["report"]',
    85
) ON CONFLICT (category, title) DO NOTHING;

CREATE TABLE IF NOT EXISTS knowledge_item_terms (
    id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
    item_id VARCHAR(36) NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
    term VARCHAR(160) NOT NULL,
    normalized_term VARCHAR(160) NOT NULL,
    term_type VARCHAR(32) NOT NULL,
    weight INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT knowledge_item_terms_type_check
        CHECK (term_type IN ('title', 'standard_term', 'alias', 'keyword', 'field', 'formula'))
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_item_terms_item_term_type_uidx
    ON knowledge_item_terms(item_id, normalized_term, term_type);
CREATE INDEX IF NOT EXISTS knowledge_item_terms_normalized_idx
    ON knowledge_item_terms(normalized_term);
CREATE INDEX IF NOT EXISTS knowledge_item_terms_item_idx
    ON knowledge_item_terms(item_id);

WITH source_terms AS (
    SELECT
        id AS item_id,
        title AS term,
        LEFT(REGEXP_REPLACE(LOWER(title), '\s+', '', 'g'), 160) AS normalized_term,
        'title' AS term_type,
        4 AS weight
    FROM knowledge_items
    WHERE NULLIF(TRIM(title), '') IS NOT NULL

    UNION ALL

    SELECT
        id AS item_id,
        standard_term AS term,
        LEFT(REGEXP_REPLACE(LOWER(standard_term), '\s+', '', 'g'), 160) AS normalized_term,
        'standard_term' AS term_type,
        5 AS weight
    FROM knowledge_items
    WHERE NULLIF(TRIM(COALESCE(standard_term, '')), '') IS NOT NULL

    UNION ALL

    SELECT
        id AS item_id,
        field_name AS term,
        LEFT(REGEXP_REPLACE(LOWER(field_name), '\s+', '', 'g'), 160) AS normalized_term,
        'field' AS term_type,
        4 AS weight
    FROM knowledge_items
    WHERE NULLIF(TRIM(COALESCE(field_name, '')), '') IS NOT NULL

    UNION ALL

    SELECT
        k.id AS item_id,
        alias_term.value AS term,
        LEFT(REGEXP_REPLACE(LOWER(alias_term.value), '\s+', '', 'g'), 160) AS normalized_term,
        'alias' AS term_type,
        4 AS weight
    FROM knowledge_items k
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(k.aliases, '[]'::jsonb)) AS alias_term(value)
    WHERE NULLIF(TRIM(alias_term.value), '') IS NOT NULL

    UNION ALL

    SELECT
        k.id AS item_id,
        keyword_term.value AS term,
        LEFT(REGEXP_REPLACE(LOWER(keyword_term.value), '\s+', '', 'g'), 160) AS normalized_term,
        'keyword' AS term_type,
        5 AS weight
    FROM knowledge_items k
    CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(k.keywords, '[]'::jsonb)) AS keyword_term(value)
    WHERE NULLIF(TRIM(keyword_term.value), '') IS NOT NULL
),
deduped_terms AS (
    SELECT DISTINCT ON (item_id, normalized_term, term_type)
        item_id,
        LEFT(term, 160) AS term,
        normalized_term,
        term_type,
        weight
    FROM source_terms
    WHERE LENGTH(normalized_term) >= 2
    ORDER BY item_id, normalized_term, term_type, weight DESC
)
INSERT INTO knowledge_item_terms (item_id, term, normalized_term, term_type, weight)
SELECT item_id, term, normalized_term, term_type, weight
FROM deduped_terms
ON CONFLICT (item_id, normalized_term, term_type)
DO UPDATE SET term = EXCLUDED.term, weight = EXCLUDED.weight;
