import { NextRequest, NextResponse } from 'next/server';

// POST /api/data-source/parse-file - 解析上传的 Excel/CSV 文件，返回字段定义 + 前10条预览
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ success: false, error: '请上传文件' }, { status: 400 });
    }

    const fileName = file.name.toLowerCase();
    const isCsv = fileName.endsWith('.csv');
    const isExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');

    if (!isCsv && !isExcel) {
      return NextResponse.json(
        { success: false, error: '仅支持 xlsx、csv 格式文件' },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    let columns: Array<{ name: string; type: string; source_type: string; source_name: string }> = [];
    let rows: Array<Record<string, unknown>> = [];
    let preview: Array<Record<string, unknown>> = [];

    if (isCsv) {
      const result = parseCsv(buffer);
      columns = result.columns;
      rows = result.rows;
      preview = result.preview;
    } else {
      // Excel 解析 - 使用动态 import
      try {
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const jsonData = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: true });

        if (jsonData.length === 0) {
          return NextResponse.json({ success: false, error: '文件内容为空' }, { status: 400 });
        }

        const headers = Object.keys(jsonData[0]);
        columns = headers.map((h) => {
          const inferredType = inferType(h, jsonData.slice(0, 100).map((r) => r[h]));
          return {
            name: h.trim(),
            type: inferredType,
            source_type: inferredType,
            source_name: h.trim(),
          };
        });

        rows = normalizeRows(jsonData, columns);
        preview = rows.slice(0, 10);
      } catch (xlsxErr) {
        const msg = xlsxErr instanceof Error ? xlsxErr.message : 'Excel 解析失败';
        return NextResponse.json({ success: false, error: msg }, { status: 500 });
      }
    }

    // 上传到 S3
    let fileKey = '';
    try {
      const { S3Storage } = await import('coze-coding-dev-sdk');
      const s3 = new S3Storage({
        endpointUrl: process.env.COZE_BUCKET_ENDPOINT_URL,
        accessKey: "",
        secretKey: "",
        bucketName: process.env.COZE_BUCKET_NAME,
        region: "cn-beijing",
      });
      fileKey = await s3.uploadFile({
        fileContent: buffer,
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
      });
    } catch (s3Err) {
      console.warn('S3 上传失败，仅保存元数据:', s3Err);
    }

    return NextResponse.json({
      success: true,
      data: {
        file_key: fileKey,
        file_name: file.name,
        file_size: file.size,
        columns,
        rows,
        preview,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

// 简单 CSV 解析器
function parseCsv(buffer: Buffer) {
  const text = buffer.toString('utf-8');
  const lines = text.split(/\r?\n/).filter((l) => l.trim());

  if (lines.length === 0) {
    return {
      columns: [] as Array<{ name: string; type: string; source_type: string; source_name: string }>,
      rows: [] as Array<Record<string, unknown>>,
      preview: [] as Array<Record<string, unknown>>,
    };
  }

  const headers = parseCsvLine(lines[0]);
  const dataRows = lines.slice(1).map((line) => parseCsvLine(line));

  const columns = headers.map((h, i) => {
    const values = dataRows.slice(0, 100).map((r) => r[i]).filter((v) => v !== undefined && v !== '');
    const inferredType = inferType(h, values);
    return {
      name: h.trim(),
      type: inferredType,
      source_type: inferredType,
      source_name: h.trim(),
    };
  });

  const rawRows = dataRows.map((row) => {
    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      obj[h.trim()] = row[i] ?? '';
    });
    return obj;
  });

  const rows = normalizeRows(rawRows, columns);
  const preview = rows.slice(0, 10);

  return { columns, rows, preview };
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// 默认字段类型为 string，仅当表头/样本明确是日期或时间时识别为 date。
function inferType(header: string, values: unknown[]): string {
  const nonEmpty = values.filter((v) => v !== null && v !== undefined && v !== '');
  if (nonEmpty.length === 0) return 'string';

  const sample = nonEmpty.slice(0, 50);
  const headerLooksDate = /(date|time|日期|时间|创建|更新|发生|完成)/i.test(header);

  const dateCount = sample.filter((v) => parseDateValue(v) !== null).length;

  if (dateCount > sample.length * 0.7 || (headerLooksDate && dateCount > 0)) return 'date';

  return 'string';
}

function normalizeRows(
  rows: Array<Record<string, unknown>>,
  columns: Array<{ type: string; source_name: string }>
): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const next: Record<string, unknown> = { ...row };
    for (const column of columns) {
      if (column.type === 'date') {
        next[column.source_name] = formatDateTime(row[column.source_name]);
      }
    }
    return next;
  });
}

function parseDateValue(value: unknown): Date | null {
  if (value instanceof Date && !isNaN(value.getTime())) return value;

  if (typeof value === 'number') {
    if (value > 20000 && value < 80000) {
      const excelEpoch = Date.UTC(1899, 11, 30);
      return new Date(excelEpoch + value * 86400000);
    }
    return null;
  }

  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = trimmed
    .replace(/\./g, '-')
    .replace(/\//g, '-')
    .replace('T', ' ')
    .replace(/Z$/, '');

  if (!/\d{4}-\d{1,2}-\d{1,2}/.test(normalized)) return null;

  const date = new Date(normalized);
  return isNaN(date.getTime()) ? null : date;
}

function formatDateTime(value: unknown): string {
  const date = parseDateValue(value);
  if (!date) return value === null || value === undefined ? '' : String(value);

  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');

  return `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
}
