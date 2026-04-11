// حذف auth_info القديم تلقائياً عند كل تشغيل
const fs = require('fs');
if (fs.existsSync('./auth_info')) {
  fs.rmSync('./auth_info', { recursive: true, force: true });
  console.log('🗑 تم حذف auth_info القديم — جاري طلب QR جديد...');
}

// ══════════════════════════════════════════════
//  SHADOW AI — WhatsApp Bot (Hugging Face API)
//  نموذج واحد يدعم الصور + نماذج احتياطية
// ══════════════════════════════════════════════

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');

const axios    = require('axios');
const pino     = require('pino');
const QRCode   = require('qrcode');
const FormData = require('form-data');

// ══════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════
const TG_TOKEN   = process.env.TELEGRAM_TOKEN   || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TG_API     = `https://api.telegram.org/bot${TG_TOKEN}`;
const HF_API_KEY = process.env.HF_API_KEY || '';

if (!HF_API_KEY) {
  console.error('❌ HF_API_KEY غير موجود!');
  console.log('📌 احصل على مفتاح من: https://huggingface.co/settings/tokens');
  process.exit(1);
}

// ══════════════════════════════════════════════
//  النماذج (أساسي + احتياطية)
// ══════════════════════════════════════════════
const MODELS = {
  // النموذج الأساسي (يدعم الصور والنصوص)
  primary: "Qwen/Qwen3-VL-8B-Instruct",
  
  // النماذج الاحتياطية (نصوص فقط، لكن تعمل إذا فشل الأساسي)
  fallbacks: [
    "deepseek-ai/DeepSeek-V3",
    "openai/gpt-oss-20b",
    "meta-llama/Llama-3.3-70B-Instruct",
    "Qwen/Qwen2.5-7B-Instruct"
  ]
};

// ══════════════════════════════════════════════
//  SYSTEM PROMPT
// ══════════════════════════════════════════════
const SYSTEM_PROMPT = `أنت مساعد ذكاء اصطناعي متقدم داخل مجموعة واتساب.

القواعد المهمة:
1. رد بنفس لغة المستخدم (عربية، فرنسية، إنجليزية، دارجة).
2. إذا سأل المستخدم سؤالاً قصيراً أو تحية، أعط رداً قصيراً.
3. إذا أرسل المستخدم اختباراً أو تمريناً طويلاً — أعط رداً كاملاً ومفصلاً.
4. إذا أرسل المستخدم صورة، اقرأها بعناية وأجب على كل الأسئلة.
5. تذكر سياق المحادثة (آخر 10 رسائل فقط).`;

// ══════════════════════════════════════════════
//  دالة الاتصال بـ Hugging Face (مع إعادة المحاولة)
// ══════════════════════════════════════════════
async function callHuggingFace(model, messages, timeout = 60000) {
  const url = "https://router.huggingface.co/v1/chat/completions";
  
  const response = await axios.post(url, {
    model: model,
    messages: messages,
    max_tokens: 2048,
    temperature: 0.7,
  }, {
    headers: {
      "Authorization": `Bearer ${HF_API_KEY}`,
      "Content-Type": "application/json"
    },
    timeout: timeout
  });
  
  return response.data.choices[0].message.content;
}

// ══════════════════════════════════════════════
//  دالة الرد مع احتياطي
// ══════════════════════════════════════════════
async function askAIWithFallback(messages, hasImage = false) {
  let lastError = null;
  
  // 1. حاول بالنموذج الأساسي (يدعم الصور)
  try {
    console.log(`🤖 محاولة بالنموذج الأساسي: ${MODELS.primary}`);
    return await callHuggingFace(MODELS.primary, messages, 60000);
  } catch (e) {
    console.error(`❌ فشل النموذج الأساسي:`, e.message);
    lastError = e;
  }
  
  // 2. إذا فشل وجرب بالنماذج الاحتياطية (نصوص فقط)
  //    لكن فقط إذا لم تكن هناك صورة (لأن الاحتياطية لا تدعم الصور)
  if (!hasImage) {
    for (const fallbackModel of MODELS.fallbacks) {
      try {
        console.log(`🔄 محاولة بالنموذج الاحتياطي: ${fallbackModel}`);
        return await callHuggingFace(fallbackModel, messages, 60000);
      } catch (e) {
        console.error(`❌ فشل النموذج ${fallbackModel}:`, e.message);
        lastError = e;
      }
    }
  }
  
  // 3. كل النماذج فشلت
  console.error('❌ جميع النماذج فشلت');
  return '⚠️ عذراً، جميع النماذج متعطلة حالياً. حاول لاحقاً.';
}

// ══════════════════════════════════════════════
//  نظام الطوابير (Queue) لكل مستخدم
// ══════════════════════════════════════════════
const userQueues = new Map();
const userProcessing = new Map();
const MAX_QUEUE_SIZE = 20;

async function processUserQueue(userId) {
  if (userProcessing.get(userId)) return;
  
  const queue = userQueues.get(userId);
  if (!queue || queue.length === 0) return;
  
  userProcessing.set(userId, true);
  
  while (userQueues.get(userId)?.length > 0) {
    const task = userQueues.get(userId).shift();
    if (task) {
      try {
        await Promise.race([
          task(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Task timeout')), 90000))
        ]);
      } catch (e) {
        console.error(`❌ خطأ في معالجة الطلب:`, e.message);
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  userProcessing.set(userId, false);
}

function addToQueue(userId, callback) {
  if (!userQueues.has(userId)) {
    userQueues.set(userId, []);
  }
  
  const queue = userQueues.get(userId);
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift();
  }
  
  queue.push(callback);
  processUserQueue(userId);
}

// ══════════════════════════════════════════════
//  ذاكرة المحادثات (لكل مستخدم)
// ══════════════════════════════════════════════
const histories = new Map();
const MAX_HISTORY = 15;

// ══════════════════════════════════════════════
//  تحويل الصوت إلى نص (باستخدام Hugging Face)
// ══════════════════════════════════════════════
async function convertAudioToText(audioBuffer, mimeType) {
  try {
    console.log('🎤 جاري تحويل الصوت إلى نص...');
    
    // تحويل الصوت إلى base64
    const base64Audio = audioBuffer.toString('base64');
    
    const url = "https://router.huggingface.co/v1/chat/completions";
    
    const response = await axios.post(url, {
      model: "openai/whisper-large-v3-turbo",  // نموذج تحويل الصوت
      messages: [
        {
          role: "user",
          content: [
            {
              type: "audio_url",
              audio_url: { url: `data:${mimeType || 'audio/ogg'};base64,${base64Audio}` }
            }
          ]
        }
      ]
    }, {
      headers: {
        "Authorization": `Bearer ${HF_API_KEY}`,
        "Content-Type": "application/json"
      },
      timeout: 30000
    });
    
    const transcribedText = response.data.choices[0].message.content;
    if (transcribedText && transcribedText.trim()) {
      console.log(`✅ تم تحويل الصوت: ${transcribedText.substring(0, 80)}...`);
      return transcribedText.trim();
    }
    return null;
  } catch (e) {
    console.error('❌ خطأ في تحويل الصوت:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════
//  دالة الرد الرئيسية
// ══════════════════════════════════════════════
async function askAI(userId, groupId, text, userName, imgB64, imgMime, audioText) {
  let finalText = text || '';
  
  if (audioText) {
    finalText = `[رسالة صوتية محولة إلى نص]: "${audioText}"\n\n${finalText}`;
  }
  
  if (!finalText.trim() && !imgB64) {
    return "👋 مرحباً! كيف يمكنني مساعدتك؟ يمكنك إرسال نص، صورة، أو رسالة صوتية.";
  }
  
  const userKey = `${groupId}_${userName}`;
  
  if (!histories.has(userKey)) {
    histories.set(userKey, []);
  }
  const hist = histories.get(userKey);
  
  // بناء الرسائل للـ API
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...hist.slice(-MAX_HISTORY)
  ];
  
  // بناء محتوى المستخدم
  let userContent = [];
  
  // إضافة النص
  userContent.push({
    type: "text",
    text: `المستخدم (${userName}) يقول: ${finalText}`
  });
  
  // إضافة الصورة (إذا وجدت) - تحويلها إلى base64
  if (imgB64) {
    userContent.push({
      type: "image_url",
      image_url: {
        url: `data:${imgMime || 'image/jpeg'};base64,${imgB64}`
      }
    });
    console.log('📷 تم إرفاق صورة مع الطلب');
  }
  
  messages.push({
    role: "user",
    content: userContent.length === 1 ? userContent[0].text : userContent
  });
  
  try {
    console.log(`🤖 جاري الرد على ${userName}...`);
    
    const hasImage = !!imgB64;
    const reply = await askAIWithFallback(messages, hasImage);
    
    if (reply && reply.trim()) {
      // حفظ السياق
      hist.push({ role: "user", content: finalText.substring(0, 300) + (imgB64 ? ' [صورة]' : '') + (audioText ? ' [صوت]' : '') });
      hist.push({ role: "assistant", content: reply });
      
      while (hist.length > MAX_HISTORY * 2) {
        hist.shift();
      }
      
      console.log(`✅ رد على ${userName} (${reply.length} حرف)`);
      return reply;
    }
    return '⚠️ عذراً، لم أتمكن من معالجة طلبك. حاول مرة أخرى.';
    
  } catch (e) {
    console.error('❌ خطأ في الرد:', e.message);
    return '⚠️ حدث خطأ في الاتصال. حاول لاحقاً.';
  }
}

// ══════════════════════════════════════════════
//  إرسال رد طويل (تقسيم إذا تجاوز 3800 حرف)
// ══════════════════════════════════════════════
async function sendLongMessage(sock, jid, text, quotedMsg) {
  const MAX_LEN = 3800;
  
  if (text.length <= MAX_LEN) {
    await sock.sendMessage(jid, { text }, { quoted: quotedMsg });
    return;
  }
  
  const parts = [];
  let remaining = text;
  
  while (remaining.length > 0) {
    if (remaining.length <= MAX_LEN) {
      parts.push(remaining);
      break;
    }
    
    let cutAt = remaining.lastIndexOf('\n\n', MAX_LEN);
    if (cutAt < MAX_LEN * 0.5) cutAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (cutAt < MAX_LEN * 0.5) cutAt = remaining.lastIndexOf(' ', MAX_LEN);
    if (cutAt < MAX_LEN * 0.5) cutAt = MAX_LEN;
    
    parts.push(remaining.substring(0, cutAt));
    remaining = remaining.substring(cutAt).trim();
  }
  
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.length > 1 ? `📄 (${i + 1}/${parts.length})\n━━━━━━━━━━━━━━━\n\n` : '';
    await sock.sendMessage(jid, { text: prefix + parts[i] },
      i === 0 ? { quoted: quotedMsg } : undefined);
    
    if (i < parts.length - 1) await new Promise(r => setTimeout(r, 800));
  }
  
  console.log(`✉️ تم إرسال الرد مقسماً على ${parts.length} أجزاء`);
}

// ══════════════════════════════════════════════
//  TELEGRAM (لإرسال QR فقط)
// ══════════════════════════════════════════════
let qrMsgId = null;
let qrTimer = null;
let lastQR = null;

async function tgSendText(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text: text,
      parse_mode: 'Markdown'
    }, { timeout: 8000 });
  } catch (_) {}
}

async function tgDeleteMsg(id) {
  if (!TG_TOKEN || !TG_CHAT_ID || !id) return;
  try {
    await axios.post(`${TG_API}/deleteMessage`, {
      chat_id: TG_CHAT_ID,
      message_id: id
    }, { timeout: 5000 });
  } catch (_) {}
}

async function sendQR(qrData) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    const buf = await QRCode.toBuffer(qrData, {
      width: 512, margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    
    if (qrMsgId) await tgDeleteMsg(qrMsgId);
    
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    form.append('photo', buf, { filename: 'qr.png', contentType: 'image/png' });
    form.append('caption', '🤖 *البوت — امسح للربط*\n\n⏱ ينتهي خلال 60 ثانية');
    form.append('parse_mode', 'Markdown');
    
    const res = await axios.post(`${TG_API}/sendPhoto`, form, {
      headers: form.getHeaders(),
      timeout: 15000
    });
    qrMsgId = res.data?.result?.message_id;
    console.log('📤 QR أُرسل لتيليغرام ✅');
  } catch (e) {
    console.error('TG error:', e.message);
  }
}

function startQRTimer(qrData) {
  lastQR = qrData;
  sendQR(qrData);
  if (qrTimer) clearInterval(qrTimer);
  qrTimer = setInterval(() => {
    if (lastQR) sendQR(lastQR);
  }, 90000);
}

function stopQRTimer() {
  if (qrTimer) clearInterval(qrTimer);
  qrTimer = null;
  lastQR = null;
}

// ══════════════════════════════════════════════
//  WHATSAPP
// ══════════════════════════════════════════════
const seen = new Set();

async function startBot() {
  console.log('🤖 البوت يبدأ...');
  console.log('📡 انتظار QR Code...');

  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['AI Bot', 'Chrome', '120.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) startQRTimer(qr);
    if (connection === 'close') {
      stopQRTimer();
      setTimeout(startBot, 5000);
    }
    if (connection === 'open') {
      stopQRTimer();
      if (qrMsgId) await tgDeleteMsg(qrMsgId);
      console.log('✅ البوت متصل!');
      await tgSendText('✅ *البوت متصل بواتساب!*\n\n🤖 يعمل الآن في جميع المجموعات.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        
        const jid = msg.key.remoteJid;
        if (!jid?.endsWith('@g.us')) continue;
        
        if (seen.has(msg.key.id)) continue;
        seen.add(msg.key.id);
        if (seen.size > 2000) seen.delete(seen.values().next().value);
        
        const mc = msg.message;
        if (!mc) continue;
        
        let text = '';
        let imgB64 = null;
        let imgMime = null;
        let audioText = null;
        
        // معالجة النص
        if (mc.conversation) {
          text = mc.conversation;
        } else if (mc.extendedTextMessage?.text) {
          text = mc.extendedTextMessage.text;
        } 
        // معالجة الصور
        else if (mc.imageMessage) {
          text = mc.imageMessage.caption || '';
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, {});
            imgB64 = buffer.toString('base64');
            imgMime = mc.imageMessage.mimetype || 'image/jpeg';
            console.log(`📸 صورة محمّلة: ${Math.round(buffer.length / 1024)}KB`);
          } catch (e) {
            console.error('خطأ تحميل الصورة:', e.message);
            continue;
          }
        }
        // معالجة الصوت
        else if (mc.audioMessage) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, {});
            const audioMime = mc.audioMessage.mimetype || 'audio/ogg';
            console.log(`🎤 صوت محمّل: ${Math.round(buffer.length / 1024)}KB`);
            
            audioText = await convertAudioToText(buffer, audioMime);
            if (audioText) {
              text = `[رسالة صوتية]: ${audioText}`;
            } else {
              continue;
            }
          } catch (e) {
            console.error('خطأ معالجة الصوت:', e.message);
            continue;
          }
        }
        else {
          continue;
        }
        
        if (!text?.trim() && !imgB64) continue;
        
        const sender = msg.key.participant || jid;
        const name = msg.pushName || sender.split('@')[0];
        const userId = `${jid}_${sender}`;
        
        console.log(`📨 ${name}: ${text.substring(0, 50)}`);
        
        addToQueue(userId, async () => {
          await sock.sendPresenceUpdate('composing', jid);
          const reply = await askAI(userId, jid, text, name, imgB64, imgMime, audioText);
          await sendLongMessage(sock, jid, reply, msg);
          await sock.sendPresenceUpdate('paused', jid);
        });
        
      } catch (e) {
        console.error('❌ خطأ:', e.message);
      }
    }
  });
}

startBot().catch(console.error);