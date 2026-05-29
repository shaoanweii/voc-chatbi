import Dypnsapi20170525, {
  SendSmsVerifyCodeRequest,
  CheckSmsVerifyCodeRequest,
} from '@alicloud/dypnsapi20170525';
import { $OpenApiUtil } from '@alicloud/openapi-core';
import { RuntimeOptions } from '@darabonba/typescript';

const smsEndpoint = 'dypnsapi.aliyuncs.com';
const smsSignName = '速通互联验证服务';
const smsSchemeName = '富通智能问数平台';
const smsTemplateCode = '100001';
const smsTemplateParam = '{"code":"##code##","min":"5"}';

function createSmsClient() {
  return new Dypnsapi20170525(
    new $OpenApiUtil.Config({
      accessKeyId: process.env.ALIBABA_CLOUD_ACCESS_KEY_ID,
      accessKeySecret: process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
      securityToken: process.env.ALIBABA_CLOUD_SECURITY_TOKEN,
      endpoint: smsEndpoint,
    })
  );
}

function getRuntimeOptions(): RuntimeOptions {
  return new RuntimeOptions({});
}

export async function sendPhoneVerifyCode(phoneNumber: string) {
  const client = createSmsClient();
  const request = new SendSmsVerifyCodeRequest({
    phoneNumber,
    signName: smsSignName,
    schemeName: smsSchemeName,
    templateCode: smsTemplateCode,
    templateParam: smsTemplateParam,
  });

  const response = await client.sendSmsVerifyCodeWithOptions(request, getRuntimeOptions());
  const body = response.body;
  if (!body?.success) {
    throw new Error(body?.message || body?.code || '短信验证码发送失败');
  }

  return {
    requestId: body.requestId || body.model?.requestId || '',
    bizId: body.model?.bizId || '',
  };
}

export async function checkPhoneVerifyCode(phoneNumber: string, verifyCode: string) {
  const client = createSmsClient();
  const request = new CheckSmsVerifyCodeRequest({
    schemeName: smsSchemeName,
    phoneNumber,
    verifyCode,
  });

  const response = await client.checkSmsVerifyCodeWithOptions(request, getRuntimeOptions());
  const body = response.body;
  if (!body?.success) {
    return false;
  }

  return body.model?.verifyResult === 'PASS';
}
