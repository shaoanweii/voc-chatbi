-- VOC 智能问数 PostgreSQL 初始化脚本
-- 适用场景：本地/云 PostgreSQL 作为元数据库 + 轻量中间数据仓库
-- 执行方式：
--   psql "postgresql://USER:PASSWORD@HOST:5432/DB_NAME" -f scripts/sql/init_pg.sql
--
-- 如果还没有创建数据库，可先用管理员账号执行：
--   CREATE DATABASE voc_chatbi WITH ENCODING 'UTF8';

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ========= 通用更新时间触发器 =========

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ========= 基础健康检查 =========

CREATE TABLE IF NOT EXISTS health_check (
  id SERIAL PRIMARY KEY,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO health_check (id)
VALUES (1)
ON CONFLICT (id) DO UPDATE SET updated_at = NOW();

-- ========= VOC 登录用户 =========

CREATE TABLE IF NOT EXISTS voc_users (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  account_id VARCHAR(128) NOT NULL UNIQUE,
  account_name VARCHAR(128) NOT NULL UNIQUE,
  user_type VARCHAR(20) NOT NULL DEFAULT 'account',
  password_hash VARCHAR(255),
  avatar_url TEXT,
  email VARCHAR(255),
  phone VARCHAR(50),
  phone_verified_at TIMESTAMPTZ,
  company VARCHAR(128) DEFAULT '富通科技',
  company_role VARCHAR(128),
  bio TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ
);

ALTER TABLE voc_users
ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE voc_users
ADD COLUMN IF NOT EXISTS user_type VARCHAR(20) NOT NULL DEFAULT 'account';
ALTER TABLE voc_users
ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'voc_users_user_type_check'
  ) THEN
    ALTER TABLE voc_users
    ADD CONSTRAINT voc_users_user_type_check
    CHECK (user_type IN ('account', 'phone'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS voc_users_account_id_idx ON voc_users(account_id);
CREATE INDEX IF NOT EXISTS voc_users_phone_idx ON voc_users(phone);

DROP TRIGGER IF EXISTS voc_users_set_updated_at ON voc_users;
CREATE TRIGGER voc_users_set_updated_at
BEFORE UPDATE ON voc_users
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS voc_user_identities (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id VARCHAR(36) NOT NULL REFERENCES voc_users(id) ON DELETE CASCADE,
  identity_type VARCHAR(32) NOT NULL,
  identifier VARCHAR(255) NOT NULL,
  credential_hash VARCHAR(255),
  verified_at TIMESTAMPTZ,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,

  CONSTRAINT voc_user_identities_type_check
    CHECK (identity_type IN ('account_id', 'phone'))
);

CREATE UNIQUE INDEX IF NOT EXISTS voc_user_identities_type_identifier_uidx
  ON voc_user_identities(identity_type, identifier);
CREATE INDEX IF NOT EXISTS voc_user_identities_user_id_idx
  ON voc_user_identities(user_id);

DROP TRIGGER IF EXISTS voc_user_identities_set_updated_at ON voc_user_identities;
CREATE TRIGGER voc_user_identities_set_updated_at
BEFORE UPDATE ON voc_user_identities
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

INSERT INTO voc_user_identities (
  user_id, identity_type, identifier, credential_hash, verified_at, is_primary
)
SELECT id, 'account_id', account_id, password_hash, created_at, TRUE
FROM voc_users
ON CONFLICT (identity_type, identifier) DO UPDATE
SET credential_hash = EXCLUDED.credential_hash;

INSERT INTO voc_user_identities (
  user_id, identity_type, identifier, verified_at, is_primary
)
SELECT id, 'phone', phone, COALESCE(phone_verified_at, last_login_at, created_at), user_type = 'phone'
FROM voc_users
WHERE phone IS NOT NULL AND phone <> ''
ON CONFLICT (identity_type, identifier) DO NOTHING;

-- ========= 文件夹 =========

CREATE TABLE IF NOT EXISTS folders (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name VARCHAR(128) NOT NULL,
  parent_id VARCHAR(36),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS folders_parent_id_idx ON folders(parent_id);

DROP TRIGGER IF EXISTS folders_set_updated_at ON folders;
CREATE TRIGGER folders_set_updated_at
BEFORE UPDATE ON folders
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

INSERT INTO folders (id, name, parent_id)
VALUES ('vbi-root', 'VBI根目录', NULL)
ON CONFLICT (id) DO NOTHING;

-- ========= 数据源元数据 =========
-- type:
--   mysql: 外部 MySQL 数据源
--   file/excel/csv: 本地文件上传来源
--
-- password 当前为兼容现有代码保留明文字段。
-- 后续建议改为 password_encrypted + APP_SECRET 加密。

CREATE TABLE IF NOT EXISTS databases_metadata (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name VARCHAR(128) NOT NULL,
  type VARCHAR(20) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,

  host VARCHAR(255),
  port INTEGER,
  database_name VARCHAR(128),
  username VARCHAR(128),
  password VARCHAR(255),

  file_key VARCHAR(500),
  file_name VARCHAR(255),
  file_size INTEGER,

  folder VARCHAR(128) DEFAULT 'VBI根目录',
  remark VARCHAR(500),
  table_count INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,

  CONSTRAINT databases_metadata_type_check
    CHECK (type IN ('mysql', 'file', 'excel', 'csv', 'hive', 'sqlserver', 'clickhouse', 'selectdb')),
  CONSTRAINT databases_metadata_status_check
    CHECK (status IN ('active', 'inactive', 'error'))
);

CREATE INDEX IF NOT EXISTS databases_metadata_type_idx ON databases_metadata(type);
CREATE INDEX IF NOT EXISTS databases_metadata_is_enabled_idx ON databases_metadata(is_enabled);
CREATE INDEX IF NOT EXISTS databases_metadata_created_at_idx ON databases_metadata(created_at DESC);

DROP TRIGGER IF EXISTS databases_metadata_set_updated_at ON databases_metadata;
CREATE TRIGGER databases_metadata_set_updated_at
BEFORE UPDATE ON databases_metadata
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ========= 智能问数表 =========
-- 每条记录对应一张“可被智能问数使用”的逻辑表。
-- physical_table_name 指向 PostgreSQL 中实际承载数据的中间表，例如 product_analysis。

CREATE TABLE IF NOT EXISTS smart_tables (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name VARCHAR(128) NOT NULL,
  source_id VARCHAR(36) NOT NULL REFERENCES databases_metadata(id) ON DELETE CASCADE,
  source_type VARCHAR(20) NOT NULL,
  source_table_name VARCHAR(128),
  file_key VARCHAR(500),
  file_name VARCHAR(255),
  physical_table_name VARCHAR(128),
  folder VARCHAR(128) DEFAULT 'VBI根目录',
  remark VARCHAR(500),
  columns JSONB NOT NULL DEFAULT '[]'::jsonb,
  row_count INTEGER NOT NULL DEFAULT 0,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,

  CONSTRAINT smart_tables_source_type_check
    CHECK (source_type IN ('mysql', 'file', 'excel', 'csv', 'hive', 'sqlserver', 'clickhouse', 'selectdb'))
);

CREATE INDEX IF NOT EXISTS smart_tables_source_id_idx ON smart_tables(source_id);
CREATE INDEX IF NOT EXISTS smart_tables_source_type_idx ON smart_tables(source_type);
CREATE INDEX IF NOT EXISTS smart_tables_is_enabled_idx ON smart_tables(is_enabled);
CREATE INDEX IF NOT EXISTS smart_tables_physical_table_name_idx ON smart_tables(physical_table_name);
CREATE INDEX IF NOT EXISTS smart_tables_created_at_idx ON smart_tables(created_at DESC);

DROP TRIGGER IF EXISTS smart_tables_set_updated_at ON smart_tables;
CREATE TRIGGER smart_tables_set_updated_at
BEFORE UPDATE ON smart_tables
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ========= 字段映射/语义配置 =========
-- 当前代码把字段配置存在 smart_tables.columns JSONB。
-- 这张表用于后续更细粒度编辑字段别名、业务含义、是否参与问数。

CREATE TABLE IF NOT EXISTS smart_table_columns (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  table_id VARCHAR(36) NOT NULL REFERENCES smart_tables(id) ON DELETE CASCADE,
  source_name VARCHAR(128) NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  data_type VARCHAR(20) NOT NULL DEFAULT 'string',
  source_type VARCHAR(64),
  description TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,

  CONSTRAINT smart_table_columns_data_type_check
    CHECK (data_type IN ('string', 'integer', 'number', 'date', 'boolean', 'json'))
);

CREATE UNIQUE INDEX IF NOT EXISTS smart_table_columns_table_source_uidx
  ON smart_table_columns(table_id, source_name);
CREATE INDEX IF NOT EXISTS smart_table_columns_table_id_idx ON smart_table_columns(table_id);
CREATE INDEX IF NOT EXISTS smart_table_columns_is_enabled_idx ON smart_table_columns(is_enabled);

DROP TRIGGER IF EXISTS smart_table_columns_set_updated_at ON smart_table_columns;
CREATE TRIGGER smart_table_columns_set_updated_at
BEFORE UPDATE ON smart_table_columns
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ========= 数据同步任务 =========
-- 用于记录 MySQL/文件导入到 PostgreSQL 中间表的任务。

CREATE TABLE IF NOT EXISTS sync_jobs (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  source_id VARCHAR(36) REFERENCES databases_metadata(id) ON DELETE SET NULL,
  smart_table_id VARCHAR(36) REFERENCES smart_tables(id) ON DELETE SET NULL,
  job_type VARCHAR(32) NOT NULL DEFAULT 'full_import',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  row_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,

  CONSTRAINT sync_jobs_job_type_check
    CHECK (job_type IN ('full_import', 'file_import', 'refresh', 'schema_scan')),
  CONSTRAINT sync_jobs_status_check
    CHECK (status IN ('pending', 'running', 'success', 'failed'))
);

CREATE INDEX IF NOT EXISTS sync_jobs_source_id_idx ON sync_jobs(source_id);
CREATE INDEX IF NOT EXISTS sync_jobs_smart_table_id_idx ON sync_jobs(smart_table_id);
CREATE INDEX IF NOT EXISTS sync_jobs_status_idx ON sync_jobs(status);
CREATE INDEX IF NOT EXISTS sync_jobs_created_at_idx ON sync_jobs(created_at DESC);

DROP TRIGGER IF EXISTS sync_jobs_set_updated_at ON sync_jobs;
CREATE TRIGGER sync_jobs_set_updated_at
BEFORE UPDATE ON sync_jobs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

-- ========= 对话记录 =========
-- 后续接入大模型问数后使用。

CREATE TABLE IF NOT EXISTS chat_sessions (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title VARCHAR(255) DEFAULT '新对话',
  selected_table_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  selected_table_names JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')
);

CREATE INDEX IF NOT EXISTS chat_sessions_created_at_idx ON chat_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS chat_sessions_updated_at_idx ON chat_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS chat_sessions_expires_at_idx ON chat_sessions(expires_at);

DROP TRIGGER IF EXISTS chat_sessions_set_updated_at ON chat_sessions;
CREATE TRIGGER chat_sessions_set_updated_at
BEFORE UPDATE ON chat_sessions
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS chat_messages (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id VARCHAR(36) NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL,
  content TEXT NOT NULL,
  thinking TEXT,
  sql_text TEXT,
  sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  chart JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(20) NOT NULL DEFAULT 'success',
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT chat_messages_role_check
    CHECK (role IN ('user', 'assistant', 'system')),
  CONSTRAINT chat_messages_status_check
    CHECK (status IN ('success', 'failure'))
);

-- 兼容旧表：如果字段不存在则新增
ALTER TABLE chat_messages
ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'success';
ALTER TABLE chat_messages
ADD COLUMN IF NOT EXISTS error_message TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_status_check'
  ) THEN
    ALTER TABLE chat_messages
    ADD CONSTRAINT chat_messages_status_check
    CHECK (status IN ('success', 'failure'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS chat_messages_session_id_idx ON chat_messages(session_id);
CREATE INDEX IF NOT EXISTS chat_messages_created_at_idx ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS chat_messages_session_created_at_idx ON chat_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_status_idx ON chat_messages(status);

-- ========= 智能问数结构化产物表 =========
-- 用于保存新对话生成的 SQL、图表、报告等结构化结果，支撑多轮追问上下文管理

CREATE TABLE IF NOT EXISTS chat_artifacts (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  session_id VARCHAR(36) NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  message_id VARCHAR(36) REFERENCES chat_messages(id) ON DELETE CASCADE,
  artifact_type VARCHAR(30) NOT NULL,
  title TEXT,
  summary TEXT,
  sql_text TEXT,
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  dimensions JSONB NOT NULL DEFAULT '[]'::jsonb,
  measures JSONB NOT NULL DEFAULT '[]'::jsonb,
  data JSONB,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS chat_artifacts_session_idx ON chat_artifacts(session_id);
CREATE INDEX IF NOT EXISTS chat_artifacts_message_idx ON chat_artifacts(message_id);
CREATE INDEX IF NOT EXISTS chat_artifacts_type_idx ON chat_artifacts(artifact_type);
CREATE INDEX IF NOT EXISTS chat_artifacts_session_created_at_idx ON chat_artifacts(session_id, created_at DESC);

-- ========= 知识中心语料 =========
-- 用于维护汽车 VOC 业务概念、字段映射、指标口径、场景规则和语料案例。

CREATE TABLE IF NOT EXISTS knowledge_items (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title VARCHAR(160) NOT NULL,
  category VARCHAR(32) NOT NULL,
  standard_term VARCHAR(120),
  aliases JSONB NOT NULL DEFAULT '[]'::jsonb,
  keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  content TEXT NOT NULL,
  field_name VARCHAR(120),
  formula TEXT,
  business_domain VARCHAR(80) DEFAULT '汽车VOC',
  applicable_intents JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  priority INTEGER NOT NULL DEFAULT 50,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,

  CONSTRAINT knowledge_items_category_check
    CHECK (category IN ('concept', 'synonym', 'field_mapping', 'metric', 'scenario', 'example', 'rule')),
  CONSTRAINT knowledge_items_status_check
    CHECK (status IN ('active', 'inactive'))
);

CREATE INDEX IF NOT EXISTS knowledge_items_category_idx ON knowledge_items(category);
CREATE INDEX IF NOT EXISTS knowledge_items_status_idx ON knowledge_items(status);
CREATE INDEX IF NOT EXISTS knowledge_items_priority_idx ON knowledge_items(priority DESC);
CREATE INDEX IF NOT EXISTS knowledge_items_standard_term_idx ON knowledge_items(standard_term);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_items_category_title_uidx ON knowledge_items(category, title);

DROP TRIGGER IF EXISTS knowledge_items_set_updated_at ON knowledge_items;
CREATE TRIGGER knowledge_items_set_updated_at
BEFORE UPDATE ON knowledge_items
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();

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
CREATE INDEX IF NOT EXISTS knowledge_item_terms_normalized_idx ON knowledge_item_terms(normalized_term);
CREATE INDEX IF NOT EXISTS knowledge_item_terms_item_idx ON knowledge_item_terms(item_id);

-- ========= 审计事件表 =========
-- 用于记录每次问答的审计信息，支撑数据报表页面

CREATE TABLE IF NOT EXISTS audit_events (
  id VARCHAR(36) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id VARCHAR(36) REFERENCES voc_users(id) ON DELETE SET NULL,
  session_id VARCHAR(36),
  message_id VARCHAR(36),
  event_type VARCHAR(32) NOT NULL DEFAULT 'qa_request',
  intent VARCHAR(32),
  status VARCHAR(20) NOT NULL DEFAULT 'success',
  error_message TEXT,
  token_usage INTEGER DEFAULT 0,
  query_text TEXT,
  sql_text TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT audit_events_event_type_check
    CHECK (event_type IN ('qa_request', 'chart_generation', 'report_generation', 'error')),
  CONSTRAINT audit_events_status_check
    CHECK (status IN ('success', 'failure'))
);

CREATE INDEX IF NOT EXISTS audit_events_user_id_idx ON audit_events(user_id);
CREATE INDEX IF NOT EXISTS audit_events_session_id_idx ON audit_events(session_id);
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_status_idx ON audit_events(status);
CREATE INDEX IF NOT EXISTS audit_events_intent_idx ON audit_events(intent);

-- 可选：触发器自动更新 chat_sessions 的 updated_at
CREATE OR REPLACE FUNCTION touch_chat_session()
RETURNS trigger AS $$
BEGIN
  UPDATE chat_sessions SET updated_at = NOW() WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS chat_messages_touch_session ON chat_messages;
CREATE TRIGGER chat_messages_touch_session
AFTER INSERT ON chat_messages
FOR EACH ROW
EXECUTE FUNCTION touch_chat_session();

-- ========= 兼容/辅助函数 =========

CREATE OR REPLACE FUNCTION increment_table_count(source_id_input TEXT)
RETURNS VOID AS $$
BEGIN
  UPDATE databases_metadata
  SET table_count = COALESCE(table_count, 0) + 1,
      updated_at = NOW()
  WHERE id = source_id_input;
END;
$$ LANGUAGE plpgsql;

-- 开发期辅助函数：用于执行动态 DDL。
-- 注意：生产环境应限制调用方权限，避免开放任意 SQL 执行能力。
CREATE OR REPLACE FUNCTION execute_sql(sql TEXT)
RETURNS VOID AS $$
BEGIN
  EXECUTE sql;
END;
$$ LANGUAGE plpgsql;

-- 生成中间物理表名，应用层也可以自己生成。
-- 这里只做英文/数字/下划线清洗，不再拼接 raw_uuid。
CREATE OR REPLACE FUNCTION make_smart_table_name(display_name TEXT, table_id TEXT DEFAULT NULL)
RETURNS TEXT AS $$
DECLARE
  cleaned_name TEXT;
BEGIN
  cleaned_name := regexp_replace(COALESCE(display_name, ''), '[^a-zA-Z0-9_]+', '_', 'g');
  cleaned_name := lower(trim(both '_' from cleaned_name));

  IF cleaned_name = '' THEN
    RETURN left('smart_table_' || replace(COALESCE(table_id, gen_random_uuid()::text), '-', '_'), 63);
  END IF;

  IF cleaned_name !~ '^[a-z_]' THEN
    cleaned_name := 't_' || cleaned_name;
  END IF;

  RETURN left(cleaned_name, 63);
END;
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS make_raw_table_name(TEXT, TEXT);

COMMIT;
