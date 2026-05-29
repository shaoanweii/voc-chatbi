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

// GET /api/data-source/[id]/tables - 获取 MySQL 数据源的表列表
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // 从 databases_metadata 查询连接信息
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

    // 动态连接 MySQL 获取表列表
    const connection = await mysql.createConnection({
      host: source.host || undefined,
      port: source.port || 3306,
      user: source.username || undefined,
      password: source.password || undefined,
      database: source.database_name || undefined,
      connectTimeout: 10000,
    });

    try {
      const [rows] = await connection.query(
        `SELECT TABLE_NAME as table_name, TABLE_COMMENT as table_comment, TABLE_ROWS as table_rows
         FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
         ORDER BY TABLE_NAME`,
        [source.database_name]
      );

      return NextResponse.json({ success: true, data: rows });
    } finally {
      await connection.end();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
