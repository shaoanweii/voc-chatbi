import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured, query, transaction } from '@/storage/database/pg-client';
import type { PoolClient } from 'pg';
import mysql from 'mysql2/promise';

const storageUnavailable = () =>
  NextResponse.json(
    { success: false, error: '未配置 PostgreSQL，智能表持久化暂不可用' },
    { status: 503 }
  );

interface SmartTableColumn {
  name: string;
  type?: string;
  sourceName?: string;
  sourceType?: string;
  comment?: string;
  defaultValue?: string;
  dateFormat?: 'long' | 'short';
}

interface MySqlSourceRow {
  id: string;
  type: string;
  host: string | null;
  port: number | null;
  database_name: string | null;
  username: string | null;
  password: string | null;
  is_enabled: boolean;
}

interface ImportResult {
  rowCount: number;
  insertSqlTemplate: string;
}

interface SmartTableRow {
  id: string;
  name: string;
  source_id: string;
  source_type: string;
  source_table_name: string | null;
  file_name: string | null;
  physical_table_name: string | null;
  folder: string | null;
  remark: string | null;
  columns: SmartTableColumn[];
  row_count: number;
  is_enabled: boolean;
  sync_status?: string | null;
  sync_job_type?: string | null;
  sync_error_message?: string | null;
  sync_updated_at?: string | null;
  created_at: string;
  updated_at: string | null;
}

// GET /api/smart-table - 列出所有智能问数表
export async function GET(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: true, data: [] });
    }

    const sourceId = request.nextUrl.searchParams.get('source_id');
    const params: unknown[] = [];
    const where = sourceId ? 'WHERE smart_tables.source_id = $1' : '';
    if (sourceId) params.push(sourceId);

    const result = await query<SmartTableRow>(
      `SELECT smart_tables.id,
              smart_tables.name,
              smart_tables.source_id,
              smart_tables.source_type,
              smart_tables.source_table_name,
              smart_tables.file_name,
              smart_tables.physical_table_name,
              smart_tables.folder,
              smart_tables.remark,
              smart_tables.columns,
              smart_tables.row_count,
              smart_tables.is_enabled,
              smart_tables.created_at,
              smart_tables.updated_at,
              latest_job.status AS sync_status,
              latest_job.job_type AS sync_job_type,
              latest_job.error_message AS sync_error_message,
              latest_job.updated_at AS sync_updated_at
       FROM smart_tables
       LEFT JOIN LATERAL (
         SELECT status, job_type, error_message, COALESCE(updated_at, finished_at, started_at, created_at) AS updated_at
         FROM sync_jobs
         WHERE sync_jobs.smart_table_id = smart_tables.id
         ORDER BY created_at DESC
         LIMIT 1
       ) latest_job ON TRUE
       ${where}
       ORDER BY smart_tables.created_at DESC`,
      params
    );

    return NextResponse.json({ success: true, data: result.rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// POST /api/smart-table - 创建智能问数表
export async function POST(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) return storageUnavailable();

    const body = await request.json();
    const { name, source_id, source_type, source_table_name, file_key, file_name, folder, remark } = body;
    const columns = normalizeColumns(body.columns);
    const fileRows = normalizeFileRows(body.file_rows);

    if (!name || !source_id || !source_type || columns.length === 0) {
      return NextResponse.json(
        { success: false, error: '名称、来源、类型和字段定义为必填项' },
        { status: 400 }
      );
    }

    const { data, createSql } = await transaction(async (client) => {
      const insertResult = await client.query<SmartTableRow>(
        `INSERT INTO smart_tables (
          name, source_id, source_type, source_table_name, file_key, file_name,
          folder, remark, columns, row_count, is_enabled
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 0, TRUE
        )
        RETURNING id, name, source_id, source_type, source_table_name, file_name, physical_table_name,
                  folder, remark, columns, row_count, is_enabled, created_at, updated_at`,
        [
          name,
          source_id,
          source_type,
          source_table_name || null,
          file_key || null,
          file_name || null,
          folder || 'VBI根目录',
          remark || null,
          JSON.stringify(columns),
        ]
      );

      const smartTable = insertResult.rows[0];
      const physicalTableName = await makePhysicalTableName(client, name, smartTable.id);
      const createSql = buildCreateTableSql(physicalTableName, columns, source_type, source_table_name);

      await client.query(createSql);
      await client.query(
        'UPDATE smart_tables SET physical_table_name = $2 WHERE id = $1',
        [smartTable.id, physicalTableName]
      );

      for (const [index, column] of columns.entries()) {
        await client.query(
          `INSERT INTO smart_table_columns (
            table_id, source_name, display_name, data_type, source_type, description, sort_order
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (table_id, source_name) DO UPDATE
          SET display_name = EXCLUDED.display_name,
              data_type = EXCLUDED.data_type,
              source_type = EXCLUDED.source_type,
              description = EXCLUDED.description,
              sort_order = EXCLUDED.sort_order`,
          [
            smartTable.id,
            column.sourceName || column.name,
            column.name,
            normalizeSemanticType(column.type),
            column.sourceType || column.type || null,
            buildColumnDescription(column),
            index,
          ]
        );
      }

      await client.query(
        `UPDATE databases_metadata
         SET table_count = COALESCE(table_count, 0) + 1,
             name = CASE WHEN $2 THEN $3 ELSE name END
         WHERE id = $1`,
        [source_id, isFileSourceType(source_type), name]
      );

      return {
        data: {
          ...smartTable,
          physical_table_name: physicalTableName,
        },
        createSql,
      };
    });

    if (source_type === 'mysql' && source_table_name && data.physical_table_name) {
      try {
        const importResult = await importMySqlRows({
          sourceId: source_id,
          sourceTableName: source_table_name,
          physicalTableName: data.physical_table_name,
          columns,
        });

        await query(
          `UPDATE smart_tables
           SET row_count = $2
           WHERE id = $1`,
          [data.id, importResult.rowCount]
        );
        data.row_count = importResult.rowCount;

        await query(
          `INSERT INTO sync_jobs (
            source_id, smart_table_id, job_type, status, started_at, finished_at, row_count, metadata
          ) VALUES ($1, $2, 'full_import', 'success', NOW(), NOW(), $3, $4::jsonb)`,
          [
            source_id,
            data.id,
            importResult.rowCount,
            JSON.stringify({
              physical_table_name: data.physical_table_name,
              source_table_name,
              create_sql: createSql,
              insert_sql_template: importResult.insertSqlTemplate,
            }),
          ]
        );
      } catch (importErr) {
        const message = importErr instanceof Error ? importErr.message : '导入数据失败';
        await query(
          `INSERT INTO sync_jobs (
            source_id, smart_table_id, job_type, status, started_at, finished_at, row_count, error_message, metadata
          ) VALUES ($1, $2, 'full_import', 'failed', NOW(), NOW(), 0, $3, $4::jsonb)`,
          [
            source_id,
            data.id,
            message,
            JSON.stringify({
              physical_table_name: data.physical_table_name,
              source_table_name,
              create_sql: createSql,
            }),
          ]
        );
        throw new Error(`中间表已创建，但导入 MySQL 数据失败: ${message}`);
      }
    }

    if (isFileSourceType(source_type) && data.physical_table_name) {
      try {
        const importResult = await importFileRows({
          physicalTableName: data.physical_table_name,
          columns,
          rows: fileRows,
        });

        await query(
          `UPDATE smart_tables
           SET row_count = $2
           WHERE id = $1`,
          [data.id, importResult.rowCount]
        );
        data.row_count = importResult.rowCount;

        await query(
          `INSERT INTO sync_jobs (
            source_id, smart_table_id, job_type, status, started_at, finished_at, row_count, metadata
          ) VALUES ($1, $2, 'file_import', 'success', NOW(), NOW(), $3, $4::jsonb)`,
          [
            source_id,
            data.id,
            importResult.rowCount,
            JSON.stringify({
              physical_table_name: data.physical_table_name,
              file_name,
              insert_sql_template: importResult.insertSqlTemplate,
            }),
          ]
        );
      } catch (importErr) {
        const message = importErr instanceof Error ? importErr.message : '导入文件数据失败';
        await query(
          `INSERT INTO sync_jobs (
            source_id, smart_table_id, job_type, status, started_at, finished_at, row_count, error_message, metadata
          ) VALUES ($1, $2, 'file_import', 'failed', NOW(), NOW(), 0, $3, $4::jsonb)`,
          [
            source_id,
            data.id,
            message,
            JSON.stringify({
              physical_table_name: data.physical_table_name,
              file_name,
            }),
          ]
        );
        throw new Error(`中间表已创建，但导入文件数据失败: ${message}`);
      }
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// DELETE /api/smart-table?id=xxx - 删除智能问数表
export async function DELETE(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) return storageUnavailable();

    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少 id 参数' }, { status: 400 });
    }

    await transaction(async (client) => {
      const existing = await client.query<Pick<SmartTableRow, 'source_id' | 'physical_table_name'>>(
        'SELECT source_id, physical_table_name FROM smart_tables WHERE id = $1',
        [id]
      );

      const row = existing.rows[0];
      if (!row) return;

      if (row.physical_table_name) {
        await client.query(`DROP TABLE IF EXISTS ${quoteIdent(row.physical_table_name)}`);
      }

      await client.query('DELETE FROM smart_tables WHERE id = $1', [id]);
      await client.query(
        `UPDATE databases_metadata
         SET table_count = GREATEST(COALESCE(table_count, 0) - 1, 0)
         WHERE id = $1`,
        [row.source_id]
      );
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// PATCH /api/smart-table?id=xxx - 更新智能问数表（启用/禁用/移动/重命名/字段元数据）
export async function PATCH(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) return storageUnavailable();

    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少 id 参数' }, { status: 400 });
    }

    const body = await request.json();
    const updates: Record<string, unknown> = {};
    const nextColumns = body.columns !== undefined ? normalizeColumns(body.columns) : undefined;

    if (body.is_enabled !== undefined) updates.is_enabled = body.is_enabled;
    if (body.folder !== undefined) updates.folder = body.folder;
    if (body.name !== undefined) updates.name = body.name;
    if (body.remark !== undefined) updates.remark = body.remark;
    if (nextColumns !== undefined) updates.columns = JSON.stringify(nextColumns);

    const entries = Object.entries(updates);
    if (entries.length === 0) {
      return NextResponse.json({ success: false, error: '没有可更新字段' }, { status: 400 });
    }

    const result = await transaction(async (client) => {
      const currentResult = await client.query<SmartTableRow>(
        `SELECT id, name, source_id, source_type, source_table_name, file_name, physical_table_name,
                folder, remark, columns, row_count, is_enabled, created_at, updated_at
         FROM smart_tables
         WHERE id = $1
         LIMIT 1`,
        [id]
      );
      const current = currentResult.rows[0];
      if (!current) return null;

      if (nextColumns && current.physical_table_name) {
        await syncSmartTableColumns(client, {
          tableId: current.id,
          physicalTableName: current.physical_table_name,
          previousColumns: normalizeColumns(current.columns),
          nextColumns,
        });
      }

      const assignments = entries.map(([field], index) => (
        field === 'columns' ? `${field} = $${index + 2}::jsonb` : `${field} = $${index + 2}`
      ));
      const updateResult = await client.query<SmartTableRow>(
        `UPDATE smart_tables
         SET ${assignments.join(', ')}
         WHERE id = $1
         RETURNING id, name, source_id, source_type, source_table_name, file_name, physical_table_name,
                   folder, remark, columns, row_count, is_enabled, created_at, updated_at`,
        [id, ...entries.map(([, value]) => value)]
      );

      const updated = updateResult.rows[0] || null;
      if (updated && body.name !== undefined && isFileSourceType(updated.source_type)) {
        await client.query(
          `UPDATE databases_metadata
           SET name = $2
           WHERE id = $1`,
          [updated.source_id, updated.name]
        );
      }

      return updated;
    });

    if (!result) {
      return NextResponse.json({ success: false, error: '智能表不存在' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

function normalizeColumns(value: unknown): SmartTableColumn[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item): SmartTableColumn | null => {
      if (!item || typeof item !== 'object') return null;
      const raw = item as Record<string, unknown>;
      const name = String(raw.name || raw.COLUMN_NAME || '').trim();
      if (!name) return null;

      return {
        name,
        type: String(raw.type || raw.DATA_TYPE || 'string').trim(),
        sourceName: raw.sourceName ? String(raw.sourceName) : raw.source_name ? String(raw.source_name) : name,
        sourceType: raw.sourceType
          ? String(raw.sourceType)
          : raw.source_type
            ? String(raw.source_type)
            : raw.COLUMN_TYPE
              ? String(raw.COLUMN_TYPE)
              : raw.DATA_TYPE
                ? String(raw.DATA_TYPE)
                : undefined,
        comment: raw.comment ? String(raw.comment) : raw.COLUMN_COMMENT ? String(raw.COLUMN_COMMENT) : undefined,
        defaultValue: raw.defaultValue ? String(raw.defaultValue) : raw.default_value ? String(raw.default_value) : '',
        dateFormat: raw.dateFormat === 'short' || raw.date_format === 'short' ? 'short' : 'long',
      };
    })
    .filter((item): item is SmartTableColumn => Boolean(item));
}

async function syncSmartTableColumns(
  client: PoolClient,
  {
    tableId,
    physicalTableName,
    previousColumns,
    nextColumns,
  }: {
    tableId: string;
    physicalTableName: string;
    previousColumns: SmartTableColumn[];
    nextColumns: SmartTableColumn[];
  }
): Promise<void> {
  const nextNames = nextColumns.map((column) => column.name.trim()).filter(Boolean);
  if (new Set(nextNames).size !== nextNames.length) {
    throw new Error('字段显示名称不能重复');
  }

  const existingColumnsResult = await client.query<{ column_name: string }>(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1`,
    [physicalTableName]
  );
  const existingColumnNames = new Set(existingColumnsResult.rows.map((row) => row.column_name));

  for (const nextColumn of nextColumns) {
    const sourceName = nextColumn.sourceName || nextColumn.name;
    const previousColumn = previousColumns.find((column) => (
      (column.sourceName || column.name) === sourceName
    ));
    const previousName = previousColumn?.name;
    const nextName = nextColumn.name;

    if (!previousName || previousName === nextName) continue;
    if (!existingColumnNames.has(previousName)) continue;
    if (existingColumnNames.has(nextName)) {
      throw new Error(`字段名称已存在：${nextName}`);
    }

    await client.query(
      `ALTER TABLE ${quoteIdent(physicalTableName)}
       RENAME COLUMN ${quoteIdent(previousName)} TO ${quoteIdent(nextName)}`
    );
    existingColumnNames.delete(previousName);
    existingColumnNames.add(nextName);
  }

  for (const [index, column] of nextColumns.entries()) {
    await client.query(
      `INSERT INTO smart_table_columns (
        table_id, source_name, display_name, data_type, source_type, description, sort_order
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (table_id, source_name) DO UPDATE
      SET display_name = EXCLUDED.display_name,
          data_type = EXCLUDED.data_type,
          source_type = EXCLUDED.source_type,
          description = EXCLUDED.description,
          sort_order = EXCLUDED.sort_order`,
      [
        tableId,
        column.sourceName || column.name,
        column.name,
        normalizeSemanticType(column.type),
        column.sourceType || column.type || null,
        buildColumnDescription(column),
        index,
      ]
    );
  }
}

function normalizeFileRows(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({ ...item }));
}

async function makePhysicalTableName(client: PoolClient, displayName: string, tableId: string): Promise<string> {
  const baseName = toEnglishTableName(displayName) || `smart_table_${tableId.replace(/-/g, '_').slice(0, 8)}`;
  const trimmedBase = baseName.slice(0, 54);

  for (let index = 0; index < 100; index += 1) {
    const candidate = index === 0 ? trimmedBase : `${trimmedBase}_${index + 1}`.slice(0, 63);
    const existing = await client.query(
      `SELECT 1
       FROM information_schema.tables
       WHERE table_schema = current_schema()
         AND table_name = $1
       LIMIT 1`,
      [candidate]
    );

    if (existing.rowCount === 0) return candidate;
  }

  return `smart_table_${tableId.replace(/-/g, '_')}`.slice(0, 63);
}

function toEnglishTableName(displayName: string): string {
  const withoutExt = displayName.replace(/\.(xlsx|xls|csv)$/i, '').trim();
  const exactNameMap: Record<string, string> = {
    '产研侧数据样例': 'product_analysis',
  };

  if (exactNameMap[withoutExt]) return exactNameMap[withoutExt];

  const hasLatin = /[a-zA-Z]/.test(withoutExt);
  if (hasLatin) return normalizeIdentifier(withoutExt);

  const terms: Array<[RegExp, string]> = [
    [/产研侧/g, 'product_analysis'],
    [/产研/g, 'product_analysis'],
    [/产品/g, 'product'],
    [/研发/g, 'research'],
    [/分析/g, 'analysis'],
    [/用户/g, 'user'],
    [/客户/g, 'customer'],
    [/订单/g, 'order'],
    [/销售/g, 'sales'],
    [/零售/g, 'retail'],
    [/教育/g, 'education'],
    [/工单/g, 'ticket'],
    [/线索/g, 'lead'],
    [/问卷/g, 'survey'],
    [/评价/g, 'review'],
    [/反馈/g, 'feedback'],
    [/测试/g, 'test'],
    [/样例/g, 'sample'],
    [/示例/g, 'sample'],
    [/明细/g, 'detail'],
    [/汇总/g, 'summary'],
    [/数据/g, 'data'],
    [/表/g, 'table'],
  ];

  let translated = withoutExt;
  for (const [pattern, replacement] of terms) {
    translated = translated.replace(pattern, `_${replacement}_`);
  }

  return normalizeIdentifier(translated);
}

function normalizeIdentifier(value: string): string {
  const normalized = value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();

  if (!normalized) return '';
  return /^[a-z_]/.test(normalized) ? normalized : `t_${normalized}`;
}

function buildCreateTableSql(
  tableName: string,
  columns: SmartTableColumn[],
  sourceType: string,
  sourceTableName?: string
): string {
  const seen = new Map<string, number>();
  const columnDefs = columns.map((column) => {
    const uniqueName = makeUniqueColumnName(column.name, seen);
    const defaultSql = buildDefaultSql(column);
    return `${quoteIdent(uniqueName)} ${toPostgresType(column)}${defaultSql ? ` DEFAULT ${defaultSql}` : ''}`;
  });
  const sourceTableDefault = sourceTableName ? `'${sourceTableName.replace(/'/g, "''")}'` : 'NULL';

  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(tableName)} (
    _id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    _source_id VARCHAR(36),
    _source_type VARCHAR(20) DEFAULT '${sourceType.replace(/'/g, "''")}',
    _source_table VARCHAR(128) DEFAULT ${sourceTableDefault},
    ${columnDefs.join(',\n    ')},
    _created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    _updated_at TIMESTAMPTZ
  )`;
}

async function importMySqlRows({
  sourceId,
  sourceTableName,
  physicalTableName,
  columns,
}: {
  sourceId: string;
  sourceTableName: string;
  physicalTableName: string;
  columns: SmartTableColumn[];
}): Promise<ImportResult> {
  const sourceResult = await query<MySqlSourceRow>(
    `SELECT id, type, host, port, database_name, username, password, is_enabled
     FROM databases_metadata
     WHERE id = $1`,
    [sourceId]
  );
  const source = sourceResult.rows[0];

  if (!source || !source.is_enabled || source.type !== 'mysql') {
    throw new Error('MySQL 数据源不存在或已禁用');
  }

  const connection = await mysql.createConnection({
    host: source.host || undefined,
    port: source.port || 3306,
    user: source.username || undefined,
    password: source.password || undefined,
    database: source.database_name || undefined,
    connectTimeout: 10_000,
  });

  const mappings = buildColumnMappings(columns);
  const selectColumns = Array.from(new Set(mappings.map((mapping) => mapping.sourceName)))
    .map(quoteMysqlIdent)
    .join(', ');
  const insertSqlTemplate = buildInsertSqlTemplate(physicalTableName, mappings.map((mapping) => mapping.targetName));

  try {
    const [rows] = await connection.query(
      `SELECT ${selectColumns} FROM ${quoteMysqlIdent(sourceTableName)}`
    );
    const sourceRows = rows as Array<Record<string, unknown>>;

    await query(`TRUNCATE TABLE ${quoteIdent(physicalTableName)}`);
    await insertRowsIntoPg(physicalTableName, mappings, sourceRows);

    return {
      rowCount: sourceRows.length,
      insertSqlTemplate,
    };
  } finally {
    await connection.end();
  }
}

async function importFileRows({
  physicalTableName,
  columns,
  rows,
}: {
  physicalTableName: string;
  columns: SmartTableColumn[];
  rows: Array<Record<string, unknown>>;
}): Promise<ImportResult> {
  const mappings = buildColumnMappings(columns);
  const insertSqlTemplate = buildInsertSqlTemplate(physicalTableName, mappings.map((mapping) => mapping.targetName));

  await query(`TRUNCATE TABLE ${quoteIdent(physicalTableName)}`);
  await insertRowsIntoPg(physicalTableName, mappings, rows);

  return {
    rowCount: rows.length,
    insertSqlTemplate,
  };
}

function buildColumnMappings(columns: SmartTableColumn[]) {
  const seen = new Map<string, number>();
  return columns.map((column) => ({
    sourceName: column.sourceName || column.name,
    targetName: makeUniqueColumnName(column.name, seen),
    column,
  }));
}

async function insertRowsIntoPg(
  tableName: string,
  mappings: ReturnType<typeof buildColumnMappings>,
  rows: Array<Record<string, unknown>>
): Promise<void> {
  if (rows.length === 0) return;

  const batchSize = 200;
  const targetColumns = mappings.map((mapping) => quoteIdent(mapping.targetName)).join(', ');

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const values: unknown[] = [];
    const rowPlaceholders = batch.map((row, rowIndex) => {
      const placeholders = mappings.map((mapping, columnIndex) => {
        values.push(normalizeValue(row[mapping.sourceName], mapping.column));
        return `$${rowIndex * mappings.length + columnIndex + 1}`;
      });
      return `(${placeholders.join(', ')})`;
    });

    await query(
      `INSERT INTO ${quoteIdent(tableName)} (${targetColumns}) VALUES ${rowPlaceholders.join(', ')}`,
      values
    );
  }
}

function buildInsertSqlTemplate(tableName: string, targetColumns: string[]): string {
  const quotedColumns = targetColumns.map(quoteIdent).join(', ');
  const placeholders = targetColumns.map((column) => `:${column}`).join(', ');
  return `INSERT INTO ${quoteIdent(tableName)} (${quotedColumns}) VALUES (${placeholders});`;
}

function normalizeValue(value: unknown, column: SmartTableColumn): unknown {
  const fallback = column.defaultValue?.trim();
  const rawValue = value === null || value === undefined || value === '' ? fallback || null : value;
  if (rawValue === null || rawValue === undefined || rawValue === '') return null;

  const semanticType = normalizeSemanticType(column.type);
  if (semanticType === 'integer') {
    const numberValue = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    return Number.isInteger(numberValue) ? numberValue : null;
  }
  if (semanticType === 'number') {
    const numberValue = typeof rawValue === 'number' ? rawValue : Number(rawValue);
    return Number.isFinite(numberValue) ? numberValue : null;
  }
  if (semanticType === 'date') {
    return column.dateFormat === 'short' ? formatShortDate(rawValue) : formatLongDate(rawValue);
  }
  if (semanticType === 'boolean') {
    if (typeof rawValue === 'boolean') return rawValue;
    if (typeof rawValue === 'number') return rawValue === 1;
    if (/^(true|1|yes|y)$/i.test(String(rawValue))) return true;
    if (/^(false|0|no|n)$/i.test(String(rawValue))) return false;
    return null;
  }
  if (semanticType === 'json') {
    if (typeof rawValue === 'object') return JSON.stringify(rawValue);
    return String(rawValue);
  }

  return String(rawValue);
}

function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date && !isNaN(value.getTime())) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed.replace(/\./g, '-').replace(/\//g, '-').replace('T', ' ').replace(/Z$/, '');
  const date = new Date(normalized);
  return isNaN(date.getTime()) ? null : date;
}

function formatShortDate(value: unknown): string | null {
  const date = parseDateValue(value);
  if (!date) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatLongDate(value: unknown): string | null {
  const date = parseDateValue(value);
  if (!date) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`;
}

function makeUniqueColumnName(name: string, seen: Map<string, number>): string {
  const currentCount = seen.get(name) || 0;
  seen.set(name, currentCount + 1);
  return currentCount === 0 ? name : `${name}_${currentCount + 1}`;
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteMysqlIdent(value: string): string {
  return `\`${value.replace(/`/g, '``')}\``;
}

function buildColumnDescription(column: SmartTableColumn): string | null {
  const parts = [
    column.comment,
    column.defaultValue ? `默认值: ${column.defaultValue}` : '',
    column.type === 'date' ? `日期格式: ${column.dateFormat === 'short' ? '短日期' : '长日期'}` : '',
  ].filter(Boolean);

  return parts.length > 0 ? parts.join('；') : null;
}

function normalizeSemanticType(type: string | undefined): string {
  const lower = type?.toLowerCase() || 'string';
  if (['integer', 'int', 'bigint', 'smallint', 'tinyint', 'mediumint'].includes(lower)) {
    return 'integer';
  }
  if (['number', 'decimal', 'float', 'double', 'numeric'].includes(lower)) {
    return 'number';
  }
  if (['date', 'datetime', 'timestamp', 'time'].includes(lower)) {
    return 'date';
  }
  if (['boolean', 'bool'].includes(lower)) {
    return 'boolean';
  }
  if (['json', 'jsonb'].includes(lower)) {
    return 'json';
  }
  return 'string';
}

function toPostgresType(column: SmartTableColumn): string {
  const lower = column.type?.toLowerCase() || 'string';
  if (lower === 'date') {
    return column.dateFormat === 'short' ? 'DATE' : 'TIMESTAMPTZ';
  }

  const typeMapping: Record<string, string> = {
    string: 'TEXT',
    varchar: 'TEXT',
    text: 'TEXT',
    char: 'TEXT',
    number: 'NUMERIC',
    decimal: 'NUMERIC',
    numeric: 'NUMERIC',
    float: 'DOUBLE PRECISION',
    double: 'DOUBLE PRECISION',
    int: 'BIGINT',
    integer: 'BIGINT',
    bigint: 'BIGINT',
    mediumint: 'INTEGER',
    smallint: 'SMALLINT',
    tinyint: 'SMALLINT',
    datetime: 'TIMESTAMPTZ',
    timestamp: 'TIMESTAMPTZ',
    time: 'TIME',
    boolean: 'BOOLEAN',
    bool: 'BOOLEAN',
    json: 'JSONB',
    jsonb: 'JSONB',
  };

  return typeMapping[lower] || 'TEXT';
}

function buildDefaultSql(column: SmartTableColumn): string {
  const value = column.defaultValue?.trim();
  if (!value) return '';

  const type = normalizeSemanticType(column.type);
  if (type === 'integer') {
    return /^-?\d+$/.test(value) ? value : '';
  }
  if (type === 'number') {
    return /^-?\d+(\.\d+)?$/.test(value) ? value : '';
  }
  if (type === 'date') {
    const escaped = escapeSqlLiteral(value);
    return column.dateFormat === 'short' ? `'${escaped}'::date` : `'${escaped}'::timestamptz`;
  }
  if (type === 'boolean') {
    if (/^(true|false)$/i.test(value)) return value.toLowerCase();
    if (value === '1') return 'true';
    if (value === '0') return 'false';
    return '';
  }
  if (type === 'json') {
    return `'${escapeSqlLiteral(value)}'::jsonb`;
  }
  return `'${escapeSqlLiteral(value)}'`;
}

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function isFileSourceType(type: string): boolean {
  return type === 'file' || type === 'excel' || type === 'csv';
}
