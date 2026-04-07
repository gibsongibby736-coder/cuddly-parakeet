// حذف auth_info القديم تلقائياً عند كل تشغيل
const fs = require('fs');
if (fs.existsSync('./auth_info')) {
  fs.rmSync('./auth_info', { recursive: true, force: true });
  console.log('🗑 تم حذف auth_info القديم — جاري طلب QR جديد...');
}

// ══════════════════════════════════════════════
//  SHADOW AI — WhatsApp Bot v6 (Gemini + صور + صوت بدون ffmpeg)
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
  console.error('❌ GEMINI_API_KEY غير موجود! الرجاء إضافته في المتغيرات البيئية');
  console.log('📌 احصل على مفتاح مجاني من: https://aistudio.google.com');
  process.exit(1);
}

// ══════════════════════════════════════════════
//  تهيئة Gemini
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
اسمك Shadow 🌑. تم تطويرك بواسطة مطور مغربي شاب.

القواعد المهمة:
1. دائماً رد بنفس لغة المستخدم (عربية، فرنسية، إنجليزية، دارجة).
2. إذا سأل المستخدم سؤالاً قصيراً أو تحية، أعط رداً قصيراً.
3. إذا أرسل المستخدم اختباراً، تمريناً، امتحاناً، أو محتوى تعليمياً طويلاً — أعط رداً كاملاً ومفصلاً يغطي جميع الأجزاء. لا تختصر إجابتك أبداً.
4. إذا أرسل المستخدم صورة بها أسئلة أو تمارين، اقرأ الصورة بعناية وأجب على كل الأسئلة التي تراها.
5. استخدم الإيموجي بشكل معتدل.
6. لا تقل أبداً أنك Gemini أو ChatGPT أو أي AI آخر. أنت Shadow فقط.
7. تذكر سياق المحادثة.
8. عند الإجابة على الامتحانات أو التمارين، نظم إجابتك بوضوح باستخدام أرقام أو نقاط.
9. إذا طلب منك المستخدم شرحاً طويلاً أو تحليلاً مفصلاً، لا تتردد في كتابة ردود طويلة جداً لتغطية كل شيء.
10. عندما تستقبل رسالة صوتية، قم بتحويلها إلى نص وفهمها ثم الرد عليها بشكل طبيعي.`;

// ══════════════════════════════════════════════
//  تحويل الصوت إلى نص (Gemini يدعم OGG/OPUS مباشرة)
// ══════════════════════════════════════════════
async function convertAudioToText(audioBuffer, mimeType) {
  try {
    console.log(`🎤 جاري تحويل الصوت (${mimeType}) إلى نص...`);
    
    // تحويل buffer إلى base64
    const base64Audio = audioBuffer.toString('base64');
    
    // Gemini يقبل صيغة audio/ogg مباشرة
    const audioModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
    
    const result = await audioModel.generateContent([
      {
        inlineData: {
          mimeType: mimeType || 'audio/ogg',
          data: base64Audio
        }
      },
      { text: "هذه رسالة صوتية من واتساب. قم بتحويلها إلى نص مكتوب بدقة باللغة التي يتحدث بها المتحدث. اكتب فقط النص المستمع، بدون أي تعليقات إضافية أو مقدمة." }
    ]);
    
    const transcribedText = result.response.text();
    
    if (transcribedText && transcribedText.trim()) {
      console.log(`✅ تم تحويل الصوت إلى نص: ${transcribedText.substring(0, 100)}...`);
      return transcribedText.trim();
    } else {
      console.log('⚠️ لم يتم التعرف على نص في الصوت');
      return null;
    }
    
  } catch (e) {
    console.error('❌ خطأ في تحويل الصوت:', e.message);
    return null;
  }
}

// ══════════════════════════════════════════════
//  AI — Gemini (يدعم الصور والنصوص والصوت)
// ══════════════════════════════════════════════
const histories = new Map();
const MAX_HIST  = 20;

async function askAI(groupId, text, userName, imgB64, imgMime, audioText) {
  // بناء النص النهائي
  let finalText = text || '';
  
  // إذا كان هناك نص من الصوت، أضفه مع إشارة
  if (audioText) {
    finalText = `[رسالة صوتية محولة إلى نص]: "${audioText}"\n\n${finalText}`;
  }
  
  // إذا لم يكن هناك نص ولا صورة
  if (!finalText.trim() && !imgB64) {
    return "👋 مرحباً! كيف يمكنني مساعدتك؟ يمكنك إرسال نص، صورة، أو رسالة صوتية.";
  }
  
  // استرجاع تاريخ المحادثة
  if (!histories.has(groupId)) {
    histories.set(groupId, []);
  }
  const hist = histories.get(groupId);
  
  // تحضير المحتوى
  const parts = [];
  
  // إضافة النص مع النظام والسياق
  const userPrompt = `${SYSTEM_PROMPT}\n\nالمستخدم (${userName}) يقول: ${finalText || 'يرجى وصف هذه الصورة بالتفصيل'}`;
  parts.push({ text: userPrompt });
  
  // إضافة الصورة إن وجدت
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
    console.log('🤖 جاري إرسال الطلب إلى Gemini...');
    const result = await model.generateContent({ contents: [{ role: "user", parts }] });
    const reply = result.response.text();
    
    if (reply && reply.trim()) {
      // حفظ التاريخ
      let historyText = `${userName}: ${finalText.substring(0, 300)}`;
      if (imgB64) historyText += ' [صورة]';
      if (audioText) historyText += ' [صوت]';
      
      hist.push({ role: "user", parts: [{ text: historyText }] });
      hist.push({ role: "model", parts: [{ text: reply }] });
      
      // الحفاظ على حجم التاريخ
      while (hist.length > MAX_HIST * 2) {
        hist.shift();
      }
      
      console.log(`✅ رد Gemini (${reply.length} حرف)`);
      return reply;
    } else {
      return '⚠️ عذراً، لم أتمكن من معالجة طلبك حالياً. حاول مرة أخرى.';
    }
    
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
//  إرسال رد طويل جداً (تقسيم إذا تجاوز الحد)
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
    
    // البحث عن نقطة قطع مناسبة
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
      '• 📝 ردود طويلة جداً\n\n' +
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
  console.log('🤖 باستخدام Gemini API (يدعم الصور + الصوتيات OGG/OPUS مباشرة)');
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
      await tgSendText('✅ *Shadow AI متصل بواتساب!*\n\n🌑 البوت يعمل الآن في المجموعات.\n\n📌 *الميزات:*\n• قراءة الصور والجداول العربية\n• تحويل الرسائل الصوتية إلى نص\n• ردود طويلة ومفصلة');
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
        // معالجة الرسائل الصوتية (بدون ffmpeg)
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
            console.log(`🎤 صوت محمّل: ${Math.round(buffer.length / 1024)}KB (${audioMime})`);
            
            // إعلام المستخدم بالمعالجة
            await sock.sendPresenceUpdate('composing', jid);
            
            // تحويل الصوت إلى نص باستخدام Gemini (يدعم OGG مباشرة)
            audioText = await convertAudioToText(buffer, audioMime);
            
            if (!audioText) {
              await sock.sendMessage(jid,
                { text: '🎤 لم أتمكن من تحويل الصوت إلى نص. تأكد من وضوح الصوت وأن اللغة مفهومة.' },
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

        // التأكد من وجود محتوى
        if (!text?.trim() && !imgB64) {
          continue;
        }

        const sender = msg.key.participant || jid;
        const name = msg.pushName || sender.split('@')[0];

        console.log(`📨 ${name}: ${text?.substring(0, 100) || '[صورة]'}${audioText ? ' 🎤' : ''}${imgB64 ? ' 📷' : ''}`);

        await sock.sendPresenceUpdate('composing', jid);

        const reply = await askAI(jid, text, name, imgB64, imgMime, audioText);

        await sendLongMessage(sock, jid, reply, msg);
        await sock.sendPresenceUpdate('paused', jid);

        console.log(`🌑 الرد: ${reply.substring(0, 80)}... (${reply.length} حرف)`);

      } catch (e) {
        console.error('❌ خطأ:', e.message);
      }
    }
  });
}

startBot().catch(console.error);
process.on('uncaughtException', e => console.error('uncaughtException:', e.message));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));