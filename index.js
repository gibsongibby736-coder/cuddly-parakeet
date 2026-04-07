// حذف auth_info القديم تلقائياً عند كل تشغيل
const fs = require('fs');
if (fs.existsSync('./auth_info')) {
  fs.rmSync('./auth_info', { recursive: true, force: true });
  console.log('🗑 تم حذف auth_info القديم — جاري طلب QR جديد...');
}

// ══════════════════════════════════════════════
//  SHADOW AI — WhatsApp Bot v8 (Gemini 2.5 Flash)
//  يدعم: صور | صوتيات | ردود طويلة | سياق لكل مستخدم | طوابير متزامنة
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
const { GoogleGenerativeAI } = require('@google/generative-ai');

// ══════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════
const TG_TOKEN   = process.env.TELEGRAM_TOKEN   || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TG_API     = `https://api.telegram.org/bot${TG_TOKEN}`;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

if (!GEMINI_API_KEY) {
  console.error('❌ GEMINI_API_KEY غير موجود!');
  console.log('📌 احصل على مفتاح من: https://aistudio.google.com');
  process.exit(1);
}

// ══════════════════════════════════════════════
//  تهيئة Gemini (باستخدام gemini-2.5-flash)
// ══════════════════════════════════════════════
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-2.5-flash",
  generationConfig: {
    temperature: 0.7,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 8192,
  }
});

// ══════════════════════════════════════════════
//  SYSTEM PROMPT
// ══════════════════════════════════════════════
const SYSTEM_PROMPT = `أنت Shadow، مساعد ذكاء اصطناعي متقدم داخل مجموعة واتساب.
اسمك Shadow 🌑. تم تطويرك بواسطة مطور مغربي شاب إسمه Hicham تذكر ذلك و لا تخلط بيني و بين شخص في المجموعة .

القواعد المهمة:
1. دائماً رد بنفس لغة المستخدم (عربية، فرنسية، إنجليزية، دارجة).
2. إذا سأل المستخدم سؤالاً قصيراً أو تحية، أعط رداً قصيراً.
3. إذا أرسل المستخدم اختباراً، تمريناً، امتحاناً، أو محتوى تعليمياً طويلاً — أعط رداً كاملاً ومفصلاً.
4. إذا أرسل المستخدم صورة بها أسئلة أو تمارين، اقرأ الصورة بعناية وأجب على كل الأسئلة.
5. استخدم الإيموجي بشكل معتدل.
6. لا تقل أبداً أنك Gemini أو ChatGPT. أنت Shadow فقط.
7. تذكر سياق المحادثة لكل مستخدم على حدة.
8. نظم إجابتك بوضوح باستخدام أرقام أو نقاط.
9. عندما تستقبل رسالة صوتية، قم بفهمها والرد عليها بشكل طبيعي.`;

// ══════════════════════════════════════════════
//  نظام الطوابير (Queue) لكل مستخدم
// ══════════════════════════════════════════════
const userQueues = new Map();      // طابور لكل مستخدم
const userProcessing = new Map();  // من يعالج حالياً

async function processUserQueue(userId) {
  if (userProcessing.get(userId)) return;
  
  const queue = userQueues.get(userId);
  if (!queue || queue.length === 0) return;
  
  userProcessing.set(userId, true);
  
  while (userQueues.get(userId)?.length > 0) {
    const task = userQueues.get(userId).shift();
    if (task) {
      try {
        await task();
      } catch (e) {
        console.error(`❌ خطأ في معالجة طلب المستخدم ${userId}:`, e.message);
      }
      await new Promise(r => setTimeout(r, 800)); // تأخير بين رسائل نفس المستخدم
    }
  }
  
  userProcessing.set(userId, false);
}

function addToQueue(userId, callback) {
  if (!userQueues.has(userId)) {
    userQueues.set(userId, []);
  }
  userQueues.get(userId).push(callback);
  processUserQueue(userId);
}

// ══════════════════════════════════════════════
//  ذاكرة المحادثات (لكل مستخدم على حدة)
// ══════════════════════════════════════════════
const histories = new Map();  // مفتاح = userId

// ══════════════════════════════════════════════
//  تحويل الصوت إلى نص
// ══════════════════════════════════════════════
async function convertAudioToText(audioBuffer, mimeType) {
  try {
    console.log('🎤 جاري تحويل الصوت إلى نص...');
    const base64Audio = audioBuffer.toString('base64');
    const audioModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    
    const result = await audioModel.generateContent([
      {
        inlineData: {
          mimeType: mimeType || 'audio/ogg',
          data: base64Audio
        }
      },
      { text: "هذه رسالة صوتية من واتساب. حولها إلى نص مكتوب باللغة الأصلية للمتحدث. اكتب فقط النص بدون أي تعليقات إضافية." }
    ]);
    
    const transcribedText = result.response.text();
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
//  AI — Gemini مع سياق لكل مستخدم
// ══════════════════════════════════════════════
async function askAI(userId, groupId, text, userName, imgB64, imgMime, audioText) {
  let finalText = text || '';
  
  if (audioText) {
    finalText = `[رسالة صوتية محولة إلى نص]: "${audioText}"\n\n${finalText}`;
  }
  
  if (!finalText.trim() && !imgB64) {
    return "👋 مرحباً! كيف يمكنني مساعدتك؟ يمكنك إرسال نص، صورة، أو رسالة صوتية.";
  }
  
  // لكل مستخدم ذاكرة منفصلة (حتى داخل نفس المجموعة)
  const userKey = `${groupId}_${userName}`;
  
  if (!histories.has(userKey)) {
    histories.set(userKey, []);
  }
  const hist = histories.get(userKey);
  
  // إنشاء جلسة محادثة مع السياق
  const chat = model.startChat({
    history: hist,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
    }
  });
  
  const parts = [];
  const userPrompt = `${SYSTEM_PROMPT}\n\nالمستخدم (${userName}) يقول: ${finalText}`;
  parts.push({ text: userPrompt });
  
  if (imgB64) {
    parts.push({
      inlineData: {
        mimeType: imgMime || 'image/jpeg',
        data: imgB64
      }
    });
    console.log('📷 تم إرفاق صورة مع الطلب');
  }
  
  try {
    console.log(`🤖 جاري الرد على ${userName}...`);
    const result = await chat.sendMessage(parts);
    const reply = result.response.text();
    
    if (reply && reply.trim()) {
      // حفظ السياق (بدون النظام برومبت)
      hist.push({ role: "user", parts: [{ text: finalText.substring(0, 500) + (imgB64 ? ' [صورة]' : '') + (audioText ? ' [صوت]' : '') }] });
      hist.push({ role: "model", parts: [{ text: reply }] });
      
      // الاحتفاظ بآخر 30 رسالة فقط
      while (hist.length > 30) {
        hist.shift();
      }
      
      console.log(`✅ رد على ${userName} (${reply.length} حرف)`);
      return reply;
    }
    return '⚠️ عذراً، لم أتمكن من معالجة طلبك. حاول مرة أخرى.';
    
  } catch (e) {
    console.error('❌ Gemini error:', e.message);
    if (e.message.includes('safety')) {
      return '⚠️ تعذرت معالجة المحتوى بسبب قيود الأمان. يرجى إعادة صياغة السؤال.';
    }
    if (e.message.includes('429')) {
      return '⚠️ تم تجاوز عدد الطلبات المسموح بها. انتظر قليلاً ثم حاول مرة أخرى.';
    }
    return '⚠️ حدث خطأ في الاتصال بالذكاء الاصطناعي. حاول لاحقاً.';
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
    if (cutAt < MAX_LEN * 0.5) cutAt = remaining.lastIndexOf('۔', MAX_LEN);
    if (cutAt < MAX_LEN * 0.5) cutAt = remaining.lastIndexOf(' ', MAX_LEN);
    if (cutAt < MAX_LEN * 0.5) cutAt = MAX_LEN;
    
    parts.push(remaining.substring(0, cutAt));
    remaining = remaining.substring(cutAt).trim();
  }
  
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.length > 1 ? `📄 (${i + 1}/${parts.length})\n━━━━━━━━━━━━━━━\n\n` : '';
    await sock.sendMessage(jid, { text: prefix + parts[i] },
      i === 0 ? { quoted: quotedMsg } : undefined);
    
    if (i < parts.length - 1) await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log(`✉️ تم إرسال الرد مقسماً على ${parts.length} أجزاء`);
}

// ══════════════════════════════════════════════
//  TELEGRAM (لإرسال QR فقط)
// ══════════════════════════════════════════════
let qrMsgId = null;
let qrTimer = null;
let lastQR  = null;

async function tgSendText(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: TG_CHAT_ID, text, parse_mode: 'Markdown',
    }, { timeout: 8000 });
  } catch (_) {}
}

async function tgDeleteMsg(id) {
  if (!TG_TOKEN || !TG_CHAT_ID || !id) return;
  try {
    await axios.post(`${TG_API}/deleteMessage`, {
      chat_id: TG_CHAT_ID, message_id: id,
    }, { timeout: 5000 });
  } catch (_) {}
}

async function sendQR(qrData) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    const buf = await QRCode.toBuffer(qrData, {
      width: 512, margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
    if (qrMsgId) { await tgDeleteMsg(qrMsgId); qrMsgId = null; }
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    form.append('photo', buf, { filename: 'qr.png', contentType: 'image/png' });
    form.append('caption',
      '🌑 *Shadow AI — امسح للربط*\n\n' +
      '📱 واتساب ← النقاط الثلاث\n' +
      '← الأجهزة المرتبطة ← ربط جهاز\n' +
      '← امسح هذا الكود\n\n' +
      '✨ *المميزات:*\n' +
      '• 📷 قراءة الصور والجداول\n' +
      '• 🎤 تحويل الصوتيات إلى نص\n' +
      '• 📝 ردود طويلة جداً\n' +
      '• 🧠 سياق محادثة لكل مستخدم\n\n' +
      '⏱ _ينتهي خلال 60 ثانية_'
    );
    form.append('parse_mode', 'Markdown');
    const res = await axios.post(`${TG_API}/sendPhoto`, form, {
      headers: form.getHeaders(), timeout: 15000,
    });
    qrMsgId = res.data?.result?.message_id || null;
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
    if (lastQR) { console.log('🔄 تحديث QR...'); sendQR(lastQR); }
  }, 90 * 1000);
}

function stopQRTimer() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  lastQR = null;
}

// ══════════════════════════════════════════════
//  WHATSAPP
// ══════════════════════════════════════════════
const seen = new Set();

async function startBot() {
  console.log('🌑 Shadow AI يبدأ...');
  console.log('🤖 باستخدام Gemini 2.5 Flash (يدعم الصور + الصوتيات + سياق لكل مستخدم)');
  console.log('📡 انتظار ظهور QR Code في تيليغرام...');

  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['Shadow AI', 'Chrome', '120.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('📱 QR جديد — إرسال لتيليغرام...');
      startQRTimer(qr);
    }
    if (connection === 'close') {
      stopQRTimer();
      if (qrMsgId) { await tgDeleteMsg(qrMsgId); qrMsgId = null; }
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔌 انقطع الاتصال (${code})`);
      if (code === DisconnectReason.loggedOut) {
        await tgSendText('⛔ *Shadow AI:* تم تسجيل الخروج.\nاحذف مجلد `auth_info` وأعد التشغيل.');
      } else {
        await tgSendText('🔄 *Shadow AI:* انقطع الاتصال، جاري إعادة الربط...');
        setTimeout(startBot, 5000);
      }
    }
    if (connection === 'open') {
      stopQRTimer();
      if (qrMsgId) { await tgDeleteMsg(qrMsgId); qrMsgId = null; }
      console.log('✅ Shadow AI متصل بنجاح!');
      await tgSendText('✅ *Shadow AI متصل بواتساب!*\n\n🌑 البوت يعمل الآن في المجموعات.\n\n📌 *الميزات:*\n• قراءة الصور والجداول\n• تحويل الرسائل الصوتية\n• ردود طويلة ومفصلة\n• سياق محادثة لكل مستخدم');
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

        // معالجة النص العادي
        if (mc.conversation) {
          text = mc.conversation;
        } 
        // معالجة النص الممتد
        else if (mc.extendedTextMessage?.text) {
          text = mc.extendedTextMessage.text;
        } 
        // معالجة الصور
        else if (mc.imageMessage) {
          text = mc.imageMessage.caption || '';
          try {
            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
            );
            imgB64 = buffer.toString('base64');
            imgMime = mc.imageMessage.mimetype || 'image/jpeg';
            console.log(`📸 صورة محمّلة: ${Math.round(buffer.length / 1024)}KB`);
          } catch (e) {
            console.error('خطأ تحميل الصورة:', e.message);
            await sock.sendMessage(jid,
              { text: '⚠️ لم أتمكن من تحميل الصورة، حاول إعادة إرسالها.' },
              { quoted: msg }
            );
            continue;
          }
        }
        // معالجة الرسائل الصوتية
        else if (mc.audioMessage) {
          text = '';
          try {
            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
            );
            const audioMime = mc.audioMessage.mimetype || 'audio/ogg';
            console.log(`🎤 صوت محمّل: ${Math.round(buffer.length / 1024)}KB`);
            
            audioText = await convertAudioToText(buffer, audioMime);
            
            if (!audioText) {
              await sock.sendMessage(jid,
                { text: '🎤 لم أتمكن من تحويل الصوت إلى نص. تأكد من وضوح الصوت.' },
                { quoted: msg }
              );
              continue;
            }
            
            text = `[رسالة صوتية]: ${audioText}`;
            console.log(`📝 النص المستخرج: "${audioText.substring(0, 80)}..."`);
            
          } catch (e) {
            console.error('خطأ معالجة الصوت:', e.message);
            await sock.sendMessage(jid,
              { text: '⚠️ حدث خطأ أثناء معالجة الرسالة الصوتية.' },
              { quoted: msg }
            );
            continue;
          }
        }
        else {
          continue;
        }

        if (!text?.trim() && !imgB64) {
          continue;
        }

        const sender = msg.key.participant || jid;
        const name = msg.pushName || sender.split('@')[0];
        const userId = `${jid}_${sender}`; // معرف فريد لكل مستخدم

        console.log(`📨 ${name}: ${text?.substring(0, 100) || '[صورة]'}${audioText ? ' 🎤' : ''}${imgB64 ? ' 📷' : ''}`);

        // إضافة الطلب إلى طابور المستخدم
        addToQueue(userId, async () => {
          await sock.sendPresenceUpdate('composing', jid);
          const reply = await askAI(userId, jid, text, name, imgB64, imgMime, audioText);
          await sendLongMessage(sock, jid, reply, msg);
          await sock.sendPresenceUpdate('paused', jid);
          console.log(`🌑 رد على ${name}: ${reply.substring(0, 80)}... (${reply.length} حرف)`);
        });

      } catch (e) {
        console.error('❌ خطأ:', e.message);
      }
    }
  });
}

startBot().catch(console.error);
process.on('uncaughtException', e => console.error('uncaughtException:', e.message));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));