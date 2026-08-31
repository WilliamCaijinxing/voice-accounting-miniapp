// cloudfunctions/voiceASR/index.js
// 语音识别云函数 — 使用微信同声传译或腾讯云 ASR
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

/**
 * MVP 方案：
 * 微信同声传译插件只支持小程序端实时流式识别，不支持云端离线识别。
 *
 * 推荐方案（按优先级）：
 * 1. 【推荐】微信同声传译插件 — 小程序端实时识别
 *    使用 record.js 中集成的 WechatSI 插件，在小程序端完成语音识别
 *    此云函数仅作为降级方案
 *
 * 2. 腾讯云 ASR 一句话识别 — 云端离线识别
 *    需要开通腾讯云语音识别服务，配置 SecretId/SecretKey
 *    适合短语音（< 60s）识别场景
 */
exports.main = async (event) => {
  const { fileID } = event;

  if (!fileID) {
    return { code: -1, message: '缺少文件ID' };
  }

  try {
    // 获取云存储文件临时链接
    const fileRes = await cloud.getTempFileURL({
      fileList: [fileID],
    });

    const tempFileURL = fileRes.fileList[0].tempFileURL;

    // === 方案A：使用微信同声传译（推荐） ===
    // 同声传译插件不支持云端调用，请在客户端使用 plugin
    // 这里返回提示引导降级到客户端插件
    return {
      code: 0,
      data: {
        text: '',
        method: 'client_plugin',
        message: '请使用小程序端 WechatSI 插件进行实时识别',
      },
    };

    // === 方案B：腾讯云 ASR（需要配置） ===
    // 取消注释以下代码并配置 SecretId/SecretKey 后使用
    /*
    const tencentcloud = require('tencentcloud-sdk-nodejs');
    const AsrClient = tencentcloud.asr.v20190614.Client;

    const client = new AsrClient({
      credential: {
        secretId: process.env.TENCENT_SECRET_ID,
        secretKey: process.env.TENCENT_SECRET_KEY,
      },
      region: 'ap-guangzhou',
    });

    const params = {
      EngineModelType: '16k_zh',    // 中文普通话
      SourceType: 0,                 // URL方式
      VoiceFormat: 'mp3',
      Url: tempFileURL,
    };

    const result = await client.SentenceRecognition(params);

    return {
      code: 0,
      data: {
        text: result.Result || '',
        requestId: result.RequestId,
        method: 'tencent_asr',
      },
    };
    */
  } catch (err) {
    console.error('ASR error:', err);
    return { code: -1, message: '语音识别失败' };
  }
};
