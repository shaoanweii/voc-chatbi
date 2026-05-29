import { pgTable, serial, timestamp, varchar, text, boolean, integer, jsonb, index } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const healthCheck = pgTable("health_check", {
  id: serial().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
});

// VOC 登录用户与个人资料
export const vocUsers = pgTable(
  "voc_users",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    account_id: varchar("account_id", { length: 128 }).notNull().unique(),
    account_name: varchar("account_name", { length: 128 }).notNull(),
    user_type: varchar("user_type", { length: 20 }).notNull().default("account"),
    password_hash: varchar("password_hash", { length: 255 }),
    avatar_url: text("avatar_url"),
    email: varchar("email", { length: 255 }),
    phone: varchar("phone", { length: 50 }),
    phone_verified_at: timestamp("phone_verified_at", { withTimezone: true }),
    company: varchar("company", { length: 128 }).default("富通科技"),
    company_role: varchar("company_role", { length: 128 }),
    bio: text("bio"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }),
    last_login_at: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [
    index("voc_users_account_id_idx").on(table.account_id),
    index("voc_users_phone_idx").on(table.phone),
  ]
);

export const vocUserIdentities = pgTable(
  "voc_user_identities",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    user_id: varchar("user_id", { length: 36 }).notNull(),
    identity_type: varchar("identity_type", { length: 32 }).notNull(),
    identifier: varchar("identifier", { length: 255 }).notNull(),
    credential_hash: varchar("credential_hash", { length: 255 }),
    verified_at: timestamp("verified_at", { withTimezone: true }),
    is_primary: boolean("is_primary").notNull().default(false),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [
    index("voc_user_identities_user_id_idx").on(table.user_id),
  ]
);

// 文件夹表
export const folders = pgTable(
  "folders",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 128 }).notNull(),
    parent_id: varchar("parent_id", { length: 36 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [
    index("folders_parent_id_idx").on(table.parent_id),
  ]
);

// 数据库元数据表（MySQL 连接 + 文件上传统一存储）
export const databasesMetadata = pgTable(
  "databases_metadata",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 128 }).notNull(),              // 显示名称
    type: varchar("type", { length: 20 }).notNull(),               // mysql | excel | csv
    status: varchar("status", { length: 20 }).notNull().default("active"), // active | inactive | error
    is_enabled: boolean("is_enabled").notNull().default(true),     // 是否启用（禁用后首页不显示）

    // MySQL 连接配置（仅 type=mysql 时有值）
    host: varchar("host", { length: 255 }),
    port: integer("port"),
    database_name: varchar("database_name", { length: 128 }),
    username: varchar("username", { length: 128 }),
    password: varchar("password", { length: 255 }),

    // 文件相关（仅 type=excel/csv 时有值）
    file_key: varchar("file_key", { length: 500 }),                // S3 对象存储 key
    file_name: varchar("file_name", { length: 255 }),              // 原始文件名
    file_size: integer("file_size"),                                // 文件大小 (bytes)

    // 元数据
    folder: varchar("folder", { length: 128 }).default("VBI根目录"), // 所属文件夹（仅文件类型使用）
    remark: varchar("remark", { length: 500 }),                     // 备注
    table_count: integer("table_count").default(0),                 // 已建表数量

    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [
    index("databases_metadata_type_idx").on(table.type),
    index("databases_metadata_is_enabled_idx").on(table.is_enabled),
  ]
);

// 智能问数表 - 从数据源或文件创建的分析用表
export const smartTables = pgTable(
  "smart_tables",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    name: varchar("name", { length: 128 }).notNull(),
    source_id: varchar("source_id", { length: 36 }).notNull(),
    source_type: varchar("source_type", { length: 20 }).notNull(),
    source_table_name: varchar("source_table_name", { length: 128 }),
    file_key: varchar("file_key", { length: 500 }),
    file_name: varchar("file_name", { length: 255 }),
    folder: varchar("folder", { length: 128 }).default("VBI根目录"),
    remark: varchar("remark", { length: 500 }),
    columns: jsonb("columns").notNull().default(sql`'[]'`),
    row_count: integer("row_count").default(0),
    is_enabled: boolean("is_enabled").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }),
  },
  (table) => [
    index("smart_tables_source_id_idx").on(table.source_id),
    index("smart_tables_source_type_idx").on(table.source_type),
    index("smart_tables_is_enabled_idx").on(table.is_enabled),
  ]
);

// 智能问数对话会话
export const chatSessions = pgTable(
  "chat_sessions",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    title: varchar("title", { length: 255 }).default("新对话"),
    selected_table_ids: jsonb("selected_table_ids").notNull().default(sql`'[]'`),
    selected_table_names: jsonb("selected_table_names").notNull().default(sql`'[]'`),
    user_id: varchar("user_id", { length: 36 }),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp("updated_at", { withTimezone: true }).defaultNow(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull().default(sql`NOW() + INTERVAL '30 days'`),
  },
  (table) => [
    index("chat_sessions_created_at_idx").on(table.created_at),
    index("chat_sessions_updated_at_idx").on(table.updated_at),
    index("chat_sessions_expires_at_idx").on(table.expires_at),
  ]
);

// 智能问数对话消息
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    session_id: varchar("session_id", { length: 36 }).notNull(),
    role: varchar("role", { length: 20 }).notNull(),
    content: text("content").notNull(),
    thinking: text("thinking"),
    sql_text: text("sql_text"),
    sources: jsonb("sources").notNull().default(sql`'[]'`),
    chart: jsonb("chart"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'`),
    status: varchar("status", { length: 20 }).notNull().default("success"),
    error_message: text("error_message"),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("chat_messages_session_id_idx").on(table.session_id),
    index("chat_messages_created_at_idx").on(table.created_at),
    index("chat_messages_session_created_at_idx").on(table.session_id, table.created_at),
    index("chat_messages_status_idx").on(table.status),
  ]
);

// 审计事件表
export const auditEvents = pgTable(
  "audit_events",
  {
    id: varchar("id", { length: 36 }).primaryKey().default(sql`gen_random_uuid()`),
    user_id: varchar("user_id", { length: 36 }),
    session_id: varchar("session_id", { length: 36 }),
    message_id: varchar("message_id", { length: 36 }),
    event_type: varchar("event_type", { length: 32 }).notNull().default("qa_request"),
    intent: varchar("intent", { length: 32 }),
    status: varchar("status", { length: 20 }).notNull().default("success"),
    error_message: text("error_message"),
    token_usage: integer("token_usage").default(0),
    query_text: text("query_text"),
    sql_text: text("sql_text"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'`),
    created_at: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("audit_events_user_id_idx").on(table.user_id),
    index("audit_events_session_id_idx").on(table.session_id),
    index("audit_events_created_at_idx").on(table.created_at),
    index("audit_events_status_idx").on(table.status),
    index("audit_events_intent_idx").on(table.intent),
  ]
);
