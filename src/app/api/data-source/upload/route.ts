import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ success: false, error: '未选择文件' }, { status: 400 });
    }

    const validExtensions = ['.xlsx', '.xls', '.csv'];
    const validTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'text/csv',
      'application/csv',
    ];
    const fileName = file.name.toLowerCase();
    const ext = fileName.substring(fileName.lastIndexOf('.'));

    if (!validExtensions.includes(ext) && !validTypes.includes(file.type)) {
      return NextResponse.json({
        success: false,
        error: '仅支持 xlsx、csv 格式文件',
      }, { status: 400 });
    }

    const maxSize = 500 * 1024 * 1024;
    if (file.size > maxSize) {
      return NextResponse.json({
        success: false,
        error: '文件大小不能超过 500MB',
      }, { status: 400 });
    }

    const { S3Storage } = await import('coze-coding-dev-sdk');
    const storage = new S3Storage({
      endpointUrl: process.env.COZE_BUCKET_ENDPOINT_URL,
      accessKey: '',
      secretKey: '',
      bucketName: process.env.COZE_BUCKET_NAME,
      region: 'cn-beijing',
    });

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileKey = await storage.uploadFile({
      fileContent: buffer,
      fileName: `data-source/${file.name}`,
      contentType: file.type || 'application/octet-stream',
    });

    return NextResponse.json({
      success: true,
      data: {
        file_key: fileKey,
        file_name: file.name,
        file_size: file.size,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '未知错误';
    return NextResponse.json({ success: false, error: `上传失败: ${message}` }, { status: 500 });
  }
}
