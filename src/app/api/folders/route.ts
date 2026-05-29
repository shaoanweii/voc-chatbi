import { NextRequest, NextResponse } from 'next/server';
import { isPostgresConfigured, query, transaction } from '@/storage/database/pg-client';

const storageUnavailable = () =>
  NextResponse.json(
    { success: false, error: '未配置 PostgreSQL，文件夹持久化暂不可用' },
    { status: 503 }
  );

interface FolderRow {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string | null;
}

// GET /api/folders - 列出所有文件夹
export async function GET() {
  try {
    if (!isPostgresConfigured()) {
      return NextResponse.json({ success: true, data: [] });
    }

    const result = await query<FolderRow>(
      'SELECT id, name, parent_id, created_at, updated_at FROM folders ORDER BY name ASC'
    );

    return NextResponse.json({ success: true, data: result.rows });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// POST /api/folders - 创建文件夹
export async function POST(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) return storageUnavailable();

    const body = await request.json();
    const { name, parent_id } = body;

    if (!name) {
      return NextResponse.json({ success: false, error: '文件夹名称为必填项' }, { status: 400 });
    }

    const result = await query<FolderRow>(
      `INSERT INTO folders (name, parent_id)
       VALUES ($1, $2)
       RETURNING id, name, parent_id, created_at, updated_at`,
      [name, parent_id || null]
    );

    return NextResponse.json({ success: true, data: result.rows[0] });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// PATCH /api/folders?id=xxx - 重命名文件夹
export async function PATCH(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) return storageUnavailable();

    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少 id 参数' }, { status: 400 });
    }
    if (id === 'vbi-root') {
      return NextResponse.json({ success: false, error: '无法修改根目录' }, { status: 400 });
    }

    const body = await request.json();
    const { name } = body;
    if (!name) {
      return NextResponse.json({ success: false, error: '文件夹名称不能为空' }, { status: 400 });
    }

    const data = await transaction(async (client) => {
      const oldFolder = await client.query<Pick<FolderRow, 'name'>>(
        'SELECT name FROM folders WHERE id = $1',
        [id]
      );

      const updateResult = await client.query<FolderRow>(
        `UPDATE folders
         SET name = $2
         WHERE id = $1
         RETURNING id, name, parent_id, created_at, updated_at`,
        [id, name]
      );

      const oldName = oldFolder.rows[0]?.name;
      if (oldName) {
        await client.query('UPDATE databases_metadata SET folder = $2 WHERE folder = $1', [oldName, name]);
        await client.query('UPDATE smart_tables SET folder = $2 WHERE folder = $1', [oldName, name]);
      }

      return updateResult.rows[0];
    });

    if (!data) {
      return NextResponse.json({ success: false, error: '文件夹不存在' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// DELETE /api/folders?id=xxx - 删除文件夹
export async function DELETE(request: NextRequest) {
  try {
    if (!isPostgresConfigured()) return storageUnavailable();

    const id = request.nextUrl.searchParams.get('id');
    if (!id) {
      return NextResponse.json({ success: false, error: '缺少 id 参数' }, { status: 400 });
    }
    if (id === 'vbi-root') {
      return NextResponse.json({ success: false, error: '无法删除根目录' }, { status: 400 });
    }

    await transaction(async (client) => {
      const folder = await client.query<Pick<FolderRow, 'name'>>(
        'SELECT name FROM folders WHERE id = $1',
        [id]
      );
      const folderName = folder.rows[0]?.name;

      if (folderName) {
        await client.query('UPDATE databases_metadata SET folder = $2 WHERE folder = $1', [folderName, 'VBI根目录']);
        await client.query('UPDATE smart_tables SET folder = $2 WHERE folder = $1', [folderName, 'VBI根目录']);
      }

      await client.query("UPDATE folders SET parent_id = 'vbi-root' WHERE parent_id = $1", [id]);
      await client.query('DELETE FROM folders WHERE id = $1', [id]);
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
