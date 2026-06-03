-- 一次性执行：为知识中心创建关键词倒排索引表，并回填已有语料关键词
-- psql "postgresql://USER:PASSWORD@HOST:5432/DB_NAME" -f scripts/sql/add_knowledge_item_terms.sql

CREATE EXTENSION IF NOT EXISTS pgcrypto;

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
