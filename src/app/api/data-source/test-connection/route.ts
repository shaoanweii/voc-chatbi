import { NextRequest, NextResponse } from 'next/server';

// POST /api/data-source/test-connection - 测试数据源链接
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { host, port, database_name, username, password, type } = body;

    if (!host || !port || !database_name || !username) {
      return NextResponse.json({ success: false, error: '连接信息不完整' }, { status: 400 });
    }

    // 仅 MySQL 支持连通性测试，其他类型直接透传保存
    if (type && type !== 'mysql') {
      return NextResponse.json({
        success: true,
        message: `数据源类型 ${type} 连接信息已收录，实际连通性待运行时验证`,
        tables: [],
      });
    }

    // 动态加载 mysql2（仅在需要时加载）
    let mysql: typeof import('mysql2/promise');
    try {
      mysql = await import('mysql2/promise');
    } catch {
      return NextResponse.json({
        success: false,
        error: 'MySQL 驱动未安装，请联系管理员安装 mysql2 依赖',
      }, { status: 500 });
    }

    let connection: import('mysql2/promise').Connection | null = null;
    try {
      connection = await mysql.createConnection({
        host,
        port: Number(port),
        user: username,
        password: password || '',
        database: database_name,
        connectTimeout: 10000, // 10 秒超时
      });

      // 执行简单查询验证连接
      const [rows] = await connection.execute('SELECT 1 AS test');
      const resultRows = rows as Array<{ test: number }>;

      if (resultRows.length > 0 && resultRows[0].test === 1) {
        // 获取数据库表列表
        const [tables] = await connection.execute(
          'SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
          [database_name]
        );
        await connection.end();
        return NextResponse.json({
          success: true,
          message: '连接成功',
          tables: tables,
        });
      }

      await connection.end();
      return NextResponse.json({ success: false, error: '连接验证失败' }, { status: 500 });
    } catch (connErr) {
      if (connection) {
        try { await connection.end(); } catch { /* ignore */ }
      }
      const message = connErr instanceof Error ? connErr.message : '连接失败';
      return NextResponse.json({ success: false, error: `连接失败: ${message}` }, { status: 500 });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
