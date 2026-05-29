import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured, query } from '@/storage/database/pg-client';

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface SmartTablePreviewRow {
  id: string;
  name: string;
  physical_table_name: string | null;
  is_enabled: boolean;
}

type DataRow = Record<string, unknown>;

export async function GET(_request: NextRequest, context: RouteContext) {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: false, error: '未配置 PostgreSQL' }, { status: 503 });
    }

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少表 ID' }, { status: 400 });
    }

    const tableResult = await query<SmartTablePreviewRow>(
      `SELECT id, name, physical_table_name, is_enabled
       FROM smart_tables
       WHERE id = $1
       LIMIT 1`,
      [id]
    );
    const table = tableResult.rows[0];

    if (!table || !table.is_enabled || !table.physical_table_name) {
      return NextResponse.json({ success: false, error: '智能问数表不存在或未启用' }, { status: 404 });
    }

    const rowsResult = await query<DataRow>(
      `SELECT * FROM ${quoteIdent(table.physical_table_name)} LIMIT 20`
    );
    const rows = rowsResult.rows.map((row) => {
      const visibleRow: DataRow = {};
      for (const [key, value] of Object.entries(row)) {
        if (!key.startsWith('_')) visibleRow[key] = value;
      }
      return visibleRow;
    });
    const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));

    return NextResponse.json({
      success: true,
      data: {
        table: {
          id: table.id,
          name: table.name,
          physical_table_name: table.physical_table_name,
        },
        columns,
        rows,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
