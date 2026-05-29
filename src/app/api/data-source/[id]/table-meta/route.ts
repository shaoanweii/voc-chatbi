import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/storage/database/pg-client';
import mysql from 'mysql2/promise';

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

// GET /api/data-source/[id]/table-meta?table=xxx - 获取 MySQL 表的字段元数据 + 前10条预览
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const tableName = request.nextUrl.searchParams.get('table');

    if (!tableName) {
      return NextResponse.json({ success: false, error: '缺少 table 参数' }, { status: 400 });
    }

    const result = await query<MySqlSourceRow>(
      `SELECT id, type, host, port, database_name, username, password, is_enabled
       FROM databases_metadata
       WHERE id = $1`,
      [id]
    );
    const source = result.rows[0];

    if (!source) {
      return NextResponse.json({ success: false, error: '数据源不存在' }, { status: 404 });
    }

    if (!source.is_enabled) {
      return NextResponse.json({ success: false, error: '数据源已禁用' }, { status: 400 });
    }

    if (source.type !== 'mysql') {
      return NextResponse.json({ success: false, error: '仅支持 MySQL 数据源' }, { status: 400 });
    }

    const connection = await mysql.createConnection({
      host: source.host || undefined,
      port: source.port || 3306,
      user: source.username || undefined,
      password: source.password || undefined,
      database: source.database_name || undefined,
      connectTimeout: 10000,
    });

    try {
      // 获取列信息
      const [columns] = await connection.query(
        `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, COLUMN_COMMENT, IS_NULLABLE, COLUMN_KEY
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
         ORDER BY ORDINAL_POSITION`,
        [source.database_name, tableName]
      );

      // 获取前10条预览数据
      const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, '');
      const [preview] = await connection.query(`SELECT * FROM \`${safeTable}\` LIMIT 10`);

      return NextResponse.json({
        success: true,
        data: {
          columns,
          preview,
        },
      });
    } finally {
      await connection.end();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
