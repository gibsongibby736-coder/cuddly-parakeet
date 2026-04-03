// ══════════════════════════════════════════════
//  SHADOW AI — WhatsApp Bot
//  يرد على كل رسائل المجموعات
//  QR Code يُرسل لتيليغرام كل 90 ثانية
// ══════════════════════════════════════════════

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const axios    = require('axios');
const pino     = require('pino');
const QRCode   = require('qrcode');
const FormData = require('form-data');

// ══════════════════════════════════════════════
//  CONFIG — ضع مفاتيحك هنا أو في Railway Variables
// ══════════════════════════════════════════════
const GEMINI_KEY    = process.env.GEMINI_API_KEY   || 'AIzaSyDdg-s7y58ZsWPcfs0rhfNHyY4bFGf7314';
const TG_TOKEN      = process.env.TELEGRAM_TOKEN   || '8050164926:AAHwnYuIVhOUudXFkUjjJ5TqLnbm-A_Qz2s';
const TG_CHAT_ID    = process.env.TELEGRAM_CHAT_ID || '';

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`;
const TG_API     = `https://api.telegram.org/bot${TG_TOKEN}`;

// ══════════════════════════════════════════════
//  SYSTEM PROMPT
// ══════════════════════════════════════════════
const SYSTEM_PROMPT =
  'أنت Shadow، ذكاء اصطناعي متقدم داخل مجموعة واتساب.\n' +
  'اسمك Shadow 🌑. تم تطويرك بواسطة مطور مغربي شاب.\n' +
  'قواعدك:\n' +
  '- أجب دائماً بنفس لغة المستخدم (عربية، فرنسية، إنجليزية...)\n' +
  '- ردودك مختصرة ومناسبة لواتساب\n' +
  '- استخدم إيموجي باعتدال لتكون ودوداً\n' +
  '- إذا سألوك من أنت: عرّف بنفسك باختصار\n' +
  '- إذا أرسلوا صورة: حللها بدقة\n' +
  '- لا تقل أنك Gemini أو ChatGPT، أنت Shadow فقط\n' +
  '- تذكر سياق المحادثة السابقة';

// ══════════════════════════════════════════════
//  TELEGRAM
// ══════════════════════════════════════════════
let adminChatId  = TG_CHAT_ID;
let qrMsgId      = null;
let qrTimer      = null;
let lastQrData   = null;

async function getAdminChatId() {
  try {
    const res = await axios.get(`${TG_API}/getUpdates?limit=5&timeout=3`, { timeout: 8000 });
    const updates = res.data?.result || [];
    for (const u of updates.reverse()) {
      const id = u?.message?.chat?.id || u?.callback_query?.message?.chat?.id;
      if (id) { adminChatId = String(id); return true; }
    }
  } catch (e) {
    // 409 = instance conflict, تجاهل
  }
  return false;
}

async function tgSendPhoto(buffer, caption) {
  if (!adminChatId) return null;
  try {
    const form = new FormData();
    form.append('chat_id', adminChatId);
    form.append('photo', buffer, { filename: 'qr.png', contentType: 'image/png' });
    form.append('caption', caption);
    form.append('parse_mode', 'Markdown');
    const res = await axios.post(`${TG_API}/sendPhoto`, form, {
      headers: form.getHeaders(), timeout: 15000,
    });
    return res.data?.result?.message_id || null;
  } catch (e) {
    console.error('TG sendPhoto error:', e.message);
    return null;
  }
}

async function tgDeleteMsg(msgId) {
  if (!adminChatId || !msgId) return;
  try {
    await axios.post(`${TG_API}/deleteMessage`, {
      chat_id: adminChatId, message_id: msgId,
    }, { timeout: 5000 });
  } catch (_) {}
}

async function tgSendText(text) {
  if (!adminChatId) return;
  try {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: adminChatId, text, parse_mode: 'Markdown',
    }, { timeout: 8000 });
  } catch (e) {
    console.error('TG sendText error:', e.message);
  }
}

async function sendQR(qrData) {
  if (!adminChatId) return;
  try {
    const buf = await QRCode.toBuffer(qrData, {
      width: 512, margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
    // حذف QR القديم
    if (qrMsgId) { await tgDeleteMsg(qrMsgId); qrMsgId = null; }

    const caption =
      '🌑 *Shadow AI — ربط واتساب*\n\n' +
      '📱 افتح واتساب ← النقاط الثلاث\n' +
      '← الأجهزة المرتبطة ← ربط جهاز\n' +
      '← امسح هذا الكود\n\n' +
      '⏱ _ينتهي خلال 60 ثانية_';

    qrMsgId = await tgSendPhoto(buf, caption);
    console.log('📤 QR أُرسل لتيليغرام ✅');
  } catch (e) {
    console.error('sendQR error:', e.message);
  }
}

function startQRTimer(qrData) {
  lastQrData = qrData;
  sendQR(qrData);

  if (qrTimer) clearInterval(qrTimer);
  qrTimer = setInterval(() => {
    if (lastQrData) {
      console.log('🔄 تحديث QR...');
      sendQR(lastQrData);
    }
  }, 90 * 1000);
}

function stopQRTimer() {
  if (qrTimer) { clearInterval(qrTimer); qrTimer = null; }
  lastQrData = null;
}

// ══════════════════════════════════════════════
//  GEMINI
// ══════════════════════════════════════════════
const histories  = new Map(); // groupId → messages[]
const MAX_HIST   = 12;

async function askGemini(groupId, text, name, imgB64, imgMime) {
  if (!histories.has(groupId)) histories.set(groupId, []);
  const hist = histories.get(groupId);

  const contents = [
    { role: 'user',  parts: [{ text: SYSTEM_PROMPT }] },
    { role: 'model', parts: [{ text: 'مفهوم! أنا Shadow جاهز 🌑' }] },
    ...hist.slice(-MAX_HIST),
  ];

  const parts = [];
  if (text?.trim()) parts.push({ text: `${name}: ${text.trim()}` });
  if (imgB64)       parts.push({ inlineData: { mimeType: imgMime || 'image/jpeg', data: imgB64 } });

  if (!parts.length) return null;
  contents.push({ role: 'user', parts });

  try {
    const res = await axios.post(GEMINI_URL, {
      contents,
      generationConfig: { temperature: 0.85, maxOutputTokens: 800 },
    }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });

    const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (reply) {
      hist.push({ role: 'user',  parts });
      hist.push({ role: 'model', parts: [{ text: reply }] });
      if (hist.length > MAX_HIST * 2) hist.splice(0, 2);
    }
    return reply || '⚠️ لم أتمكن من الرد، حاول مرة أخرى.';
  } catch (e) {
    console.error('Gemini error:', e.response?.data || e.message);
    if (e.response?.status === 429) return '⏳ كثرة الطلبات، انتظر لحظة.';
    if (e.response?.status === 400) return '⚠️ طلب غير صالح، حاول مرة أخرى.';
    return '❌ خطأ في الاتصال بـ Shadow، حاول لاحقاً.';
  }
}

// ══════════════════════════════════════════════
//  WHATSAPP
// ══════════════════════════════════════════════
const seen = new Set();

async function startBot() {
  console.log('🌑 Shadow AI يبدأ...');

  // جلب Chat ID إذا لم يكن موجوداً
  if (!adminChatId) {
    console.log('⚠️ أرسل أي رسالة لبوت تيليغرام...');
    let attempts = 0;
    while (!adminChatId && attempts < 12) {
      await getAdminChatId();
      if (!adminChatId) await new Promise(r => setTimeout(r, 5000));
      attempts++;
    }
    if (!adminChatId) console.log('⚠️ لم يُعثر على Chat ID — أضفه في TELEGRAM_CHAT_ID');
  }

  const { state, saveCreds } = await useMultiFileAuthState('./auth_info');
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' })),
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false, // نستخدم تيليغرام بدلاً من الـ terminal
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
        console.log('⛔ تسجيل الخروج. احذف مجلد auth_info.');
        await tgSendText('⛔ *Shadow AI:* تم تسجيل الخروج.\nاحذف مجلد `auth_info` وأعد التشغيل.');
      } else {
        await tgSendText('🔄 *Shadow AI:* انقطع الاتصال، جاري إعادة الربط...');
        setTimeout(startBot, 5000);
      }
    }

    if (connection === 'open') {
      stopQRTimer();
      if (qrMsgId) { await tgDeleteMsg(qrMsgId); qrMsgId = null; }
      console.log('✅ Shadow AI متصل!');
      await tgSendText('✅ *Shadow AI متصل بواتساب!*\n🌑 البوت يعمل في المجموعات الآن.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;

        // فقط المجموعات
        const jid = msg.key.remoteJid;
        if (!jid?.endsWith('@g.us')) continue;

        // منع التكرار
        if (seen.has(msg.key.id)) continue;
        seen.add(msg.key.id);
        if (seen.size > 2000) {
          const first = seen.values().next().value;
          seen.delete(first);
        }

        const mc = msg.message;
        if (!mc) continue;

        let text  = '';
        let imgB64 = null;
        let imgMime = null;

        if (mc.conversation) {
          text = mc.conversation;
        } else if (mc.extendedTextMessage?.text) {
          text = mc.extendedTextMessage.text;
        } else if (mc.imageMessage) {
          text = mc.imageMessage.caption || 'حلل هذه الصورة';
          try {
            const buf = await sock.downloadMediaMessage(msg);
            imgB64  = buf.toString('base64');
            imgMime = mc.imageMessage.mimetype || 'image/jpeg';
          } catch (e) {
            console.error('خطأ تحميل صورة:', e.message);
          }
        } else {
          // تجاهل: صوت، فيديو، sticker، وثائق
          continue;
        }

        if (!text?.trim() && !imgB64) continue;

        const sender = msg.key.participant || jid;
        const name   = msg.pushName || sender.split('@')[0];

        console.log(`📨 [${jid.split('@')[0]}] ${name}: ${text || '[صورة]'}`);

        // أظهر "يكتب..."
        await sock.sendPresenceUpdate('composing', jid);

        const reply = await askGemini(jid, text, name, imgB64, imgMime);
        if (!reply) continue;

        // أرسل الرد مع اقتباس للرسالة الأصلية
        await sock.sendMessage(jid, { text: reply }, { quoted: msg });
        await sock.sendPresenceUpdate('paused', jid);

        console.log(`🌑 Shadow → ${reply.substring(0, 80)}...`);

      } catch (e) {
        console.error('❌ خطأ في معالجة رسالة:', e.message);
      }
    }
  });
}

// ══════════════════════════════════════════════
//  RUN
// ══════════════════════════════════════════════
startBot().catch(console.error);

process.on('uncaughtException',  e => console.error('uncaughtException:', e.message));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
