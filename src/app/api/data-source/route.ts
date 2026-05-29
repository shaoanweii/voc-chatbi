import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured, query, transaction } from '@/storage/database/pg-client';

const storageUnavailable = () =>
  NextResponse.json(
    { success: false, error: '未配置 PostgreSQL，数据源持久化暂不可用' },
    { status: 503 }
  );

interface DataSourceRow {
  id: string;
  name: string;
  type: string;
  status: string;
  is_enabled: boolean;
  host: string | null;
  port: number | null;
  database_name: string | null;
  username: string | null;
  file_name: string | null;
  file_size: number | null;
  folder: string | null;
  remark: string | null;
  table_count: number;
  created_at: string;
  updated_at: string | null;
}

// GET /api/data-source - 列出所有数据源（从 databases_metadata 查询）
export async function GET(request: NextRequest) {
  try {
    const enabledOnly = request.nextUrl.searchParams.get('enabled') === 'true';
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: true, data: [] });
    }

    const selectColumns = enabledOnly
      ? 'id, name, type, host, database_name, file_name'
      : 'id, name, type, status, is_enabled, host, port, database_name, username, file_name, file_size, folder, remark, table_count, created_at, updated_at';
    const where = enabledOnly ? 'WHERE is_enabled = TRUE' : '';
    const result = await query<DataSourceRow>(
      `SELECT ${selectColumns} FROM databases_metadata ${where} ORDER BY created_at DESC`
    );

    return NextResponse.json({ success: true, data: result.rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// POST /api/data-source - 保存数据源到 databases_metadata
export async function POST(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) return storageUnavailable();

    const body = await request.json();
    const { name, type, host, port, database_name, username, password, file_key, file_name, file_size, folder, remark } = body;

    if (!name || !type) {
      return NextResponse.json({ success: false, error: '名称和类型为必填项' }, { status: 400 });
    }

    const values: Record<string, unknown> = {
      name,
      type,
      host: null,
      port: null,
      database_name: null,
      username: null,
      password: null,
      file_key: null,
      file_name: null,
      file_size: null,
      folder: null,
      remark: remark || null,
    };

    if (type === 'mysql' || type === 'hive' || type === 'sqlserver' || type === 'clickhouse') {
      if (!host || !port || !database_name || !username) {
        return NextResponse.json({ success: false, error: '数据源链接信息不完整' }, { status: 400 });
      }
      values.host = host;
      values.port = Number(port);
      values.database_name = database_name;
      values.username = username;
      values.password = password || '';
    } else if (type === 'file' || type === 'excel' || type === 'csv') {
      if (!file_name) {
        return NextResponse.json({ success: false, error: '文件信息不完整' }, { status: 400 });
      }
      values.file_key = file_key || '';
      values.file_name = file_name;
      values.file_size = Number(file_size || 0);
      values.folder = folder || 'VBI根目录';
    } else {
      return NextResponse.json({ success: false, error: '不支持的数据源类型' }, { status: 400 });
    }

    const result = await query<DataSourceRow>(
      `INSERT INTO databases_metadata (
        name, type, status, is_enabled, host, port, database_name, username, password,
        file_key, file_name, file_size, folder, remark
      ) VALUES (
        $1, $2, 'active', TRUE, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      )
      RETURNING id, name, type, status, is_enabled, created_at`,
      [
        values.name,
        values.type,
        values.host,
        values.port,
        values.database_name,
        values.username,
        values.password,
        values.file_key,
        values.file_name,
        values.file_size,
        values.folder,
        values.remark,
      ]
    );

    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// DELETE /api/data-source?id=xxx - 删除数据源及关联的物理中间表
export async function DELETE(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) return storageUnavailable();

    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少 id 参数' }, { status: 400 });
    }

    await transaction(async (client) => {
      const tables = await client.query<{ physical_table_name: string | null }>(
        'SELECT physical_table_name FROM smart_tables WHERE source_id = $1 AND physical_table_name IS NOT NULL',
        [id]
      );

      for (const row of tables.rows) {
        const safeName = `"${(row.physical_table_name || '').replace(/"/g, '""')}"`;
        await client.query(`DROP TABLE IF EXISTS ${safeName}`);
      }

      await client.query('DELETE FROM databases_metadata WHERE id = $1', [id]);
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// PATCH /api/data-source?id=xxx - 更新数据源（移动文件夹、启用/禁用等）
export async function PATCH(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) return storageUnavailable();

    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少 id 参数' }, { status: 400 });
    }

    const body = await request.json();

    const updateData: Record<string, unknown> = {};
    if (body.folder !== undefined) updateData.folder = body.folder;
    if (body.name !== undefined) updateData.name = body.name;
    if (body.remark !== undefined) updateData.remark = body.remark;
    if (body.is_enabled !== undefined) updateData.is_enabled = body.is_enabled;
    if (body.status !== undefined) updateData.status = body.status;
    if (body.type !== undefined) updateData.type = body.type;
    if (body.host !== undefined) updateData.host = body.host;
    if (body.port !== undefined) updateData.port = Number(body.port);
    if (body.database_name !== undefined) updateData.database_name = body.database_name;
    if (body.username !== undefined) updateData.username = body.username;
    if (body.password !== undefined && body.password !== '') updateData.password = body.password;
    if (body.file_key !== undefined) updateData.file_key = body.file_key;
    if (body.file_name !== undefined) updateData.file_name = body.file_name;
    if (body.file_size !== undefined) updateData.file_size = body.file_size;

    const entries = Object.entries(updateData);
    if (entries.length === 0) {
      return NextResponse.json({ success: false, error: '没有可更新字段' }, { status: 400 });
    }

    const assignments = entries.map(([field], index) => `${field} = $${index + 2}`);
    const result = await query<DataSourceRow>(
      `UPDATE databases_metadata
       SET ${assignments.join(', ')}
       WHERE id = $1
       RETURNING id, name, type, is_enabled, status, folder, remark, host, port, database_name, username, file_name, file_size`,
      [id, ...entries.map(([, value]) => value)]
    );

    if (!result.rows[0]) {
      return NextResponse.json({ success: false, error: '数据源不存在' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
