// ══════════════════════════════════════════════
//  SHADOW AI — WhatsApp Bot
//  QR Code يُرسل لبوت تيليغرام كل 90 ثانية
// ══════════════════════════════════════════════

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');

const axios  = require('axios');
const pino   = require('pino');
const QRCode = require('qrcode');

// ══════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════
const GEMINI_API_KEY   = process.env.GEMINI_API_KEY || 'AIzaSyCYZsmOHKx6v6MBDDOFzL1BSG7inUvHBPQ';
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN || '8050164926:AAHwnYuIVhOUudXFkUjjJ5TqLnbm-A_Qz2s';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || ''; // سيُحدَّد تلقائياً

const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;
const TG_API     = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ══════════════════════════════════════════════
//  TELEGRAM — إرسال QR Code
// ══════════════════════════════════════════════
let adminChatId    = TELEGRAM_CHAT_ID;
let qrMessageId    = null; // ID آخر رسالة QR لحذفها عند التحديث
let qrInterval     = null;
let currentQrData  = null;

// جلب chat_id تلقائياً من أول رسالة يرسلها المشرف للبوت
async function fetchAdminChatId() {
  try {
    const res = await axios.get(`${TG_API}/getUpdates?limit=1&timeout=5`);
    const updates = res.data?.result;
    if (updates?.length > 0) {
      const chatId = updates[updates.length - 1]?.message?.chat?.id;
      if (chatId) {
        adminChatId = chatId.toString();
        console.log(`✅ Telegram Chat ID: ${adminChatId}`);
      }
    }
  } catch (e) {
    console.error('خطأ في جلب Chat ID:', e.message);
  }
}

// إرسال QR Code كصورة لتيليغرام
async function sendQRToTelegram(qrData) {
  if (!adminChatId) {
    console.log('⚠️ Chat ID غير معروف — أرسل أي رسالة لبوت تيليغرام أولاً');
    return;
  }

  try {
    // تحويل QR إلى Buffer صورة PNG
    const qrBuffer = await QRCode.toBuffer(qrData, {
      width: 512,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });

    // حذف رسالة QR القديمة إن وجدت
    if (qrMessageId) {
      try {
        await axios.post(`${TG_API}/deleteMessage`, {
          chat_id: adminChatId,
          message_id: qrMessageId,
        });
      } catch (_) {}
      qrMessageId = null;
    }

    // إرسال الصورة
    const FormData = require('form-data');
    const form = new FormData();
    form.append('chat_id', adminChatId);
    form.append('photo', qrBuffer, { filename: 'qr.png', contentType: 'image/png' });
    form.append('caption',
      '🌑 *Shadow AI — ربط واتساب*\n\n' +
      '📱 افتح واتساب ← النقاط الثلاث\n' +
      '← الأجهزة المرتبطة ← ربط جهاز\n' +
      '← امسح هذا الكود\n\n' +
      '⏱ ينتهي خلال 90 ثانية'
    );
    form.append('parse_mode', 'Markdown');

    const res = await axios.post(`${TG_API}/sendPhoto`, form, {
      headers: form.getHeaders(),
      timeout: 15000,
    });

    qrMessageId = res.data?.result?.message_id;
    console.log('📤 تم إرسال QR Code لتيليغرام ✅');

  } catch (e) {
    console.error('خطأ في إرسال QR لتيليغرام:', e.message);
  }
}

// إرسال رسالة نصية لتيليغرام
async function sendTextToTelegram(text) {
  if (!adminChatId) return;
  try {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: adminChatId,
      text,
      parse_mode: 'Markdown',
    });
  } catch (e) {
    console.error('خطأ في إرسال رسالة تيليغرام:', e.message);
  }
}

// تحديث QR كل 90 ثانية
function startQRRefresh(qrData) {
  currentQrData = qrData;

  // إرسال فوري
  sendQRToTelegram(qrData);

  // إيقاف المؤقت القديم
  if (qrInterval) clearInterval(qrInterval);

  // تحديث كل 90 ثانية
  qrInterval = setInterval(() => {
    if (currentQrData) {
      console.log('🔄 تحديث QR Code...');
      sendQRToTelegram(currentQrData);
    }
  }, 90 * 1000);
}

function stopQRRefresh() {
  if (qrInterval) {
    clearInterval(qrInterval);
    qrInterval = null;
  }
  currentQrData = null;
}

// ══════════════════════════════════════════════
//  SYSTEM PROMPT
// ══════════════════════════════════════════════
const SYSTEM_PROMPT = `أنت Shadow، ذكاء اصطناعي متقدم يعيش داخل مجموعة واتساب.

هويتك:
- اسمك Shadow 🌑
- أنت مساعد ذكي، ودود، وسريع الرد
- تم تطويرك بواسطة مطور مغربي شاب
- مدعوم بأحدث تقنيات الذكاء الاصطناعي

قواعدك:
- أجب دائماً بنفس لغة الشخص الذي يكلمك
- ردودك مختصرة ومناسبة لواتساب
- استخدم إيموجي باعتدال
- إذا سألك أحد من أنت، عرّف بنفسك باختصار
- إذا أرسل أحد صورة، حللها واشرح ما تراه
- لا تقل أبداً أنك ChatGPT أو Gemini، أنت Shadow فقط
- تذكر سياق المحادثة السابقة في المجموعة`;

// ══════════════════════════════════════════════
//  GEMINI
// ══════════════════════════════════════════════
const groupHistories = new Map();
const MAX_HISTORY    = 14;

async function askGemini(groupId, userMessage, userName, imageBase64, imageMime) {
  try {
    if (!groupHistories.has(groupId)) groupHistories.set(groupId, []);
    const history = groupHistories.get(groupId);

    const contents = [];
    contents.push({ role: 'user',  parts: [{ text: SYSTEM_PROMPT }] });
    contents.push({ role: 'model', parts: [{ text: 'مفهوم! أنا Shadow جاهز 🌑' }] });
    for (const item of history.slice(-MAX_HISTORY)) contents.push(item);

    const currentParts = [];
    if (userMessage?.trim()) currentParts.push({ text: `${userName}: ${userMessage.trim()}` });
    if (imageBase64) {
      currentParts.push({
        inlineData: { mimeType: imageMime || 'image/jpeg', data: imageBase64 }
      });
    }
    contents.push({ role: 'user', parts: currentParts });

    const response = await axios.post(GEMINI_URL, {
      contents,
      generationConfig: { temperature: 0.85, maxOutputTokens: 800 }
    }, { timeout: 30000, headers: { 'Content-Type': 'application/json' } });

    const reply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (reply?.trim()) {
      history.push({ role: 'user',  parts: currentParts });
      history.push({ role: 'model', parts: [{ text: reply }] });
      if (history.length > MAX_HISTORY * 2) history.splice(0, 2);
      return reply.trim();
    }
    return '⚠️ لم أتمكن من الرد، حاول مرة أخرى.';
  } catch (error) {
    console.error('Gemini Error:', error.message);
    if (error.response?.status === 429) return '⏳ كثرة الطلبات، انتظر قليلاً.';
    return '❌ خطأ في الاتصال.';
  }
}

// ══════════════════════════════════════════════
//  WHATSAPP BOT
// ══════════════════════════════════════════════
const processedMessages = new Set();

async function startBot() {
  console.log('🌑 Shadow AI Bot يبدأ التشغيل...');

  // جلب Chat ID من تيليغرام
  await fetchAdminChatId();

  // إذا لم يُعثر على Chat ID، انتظر رسالة من المشرف
  if (!adminChatId) {
    console.log('⚠️ أرسل أي رسالة لبوت تيليغرام الآن للحصول على Chat ID...');
    // محاولة كل 5 ثوانٍ
    await new Promise(resolve => {
      const interval = setInterval(async () => {
        await fetchAdminChatId();
        if (adminChatId) { clearInterval(interval); resolve(); }
      }, 5000);
    });
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
    printQRInTerminal: true,
    browser: ['Shadow AI', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 QR Code جديد — جاري الإرسال لتيليغرام...');
      startQRRefresh(qr);
    }

    if (connection === 'close') {
      stopQRRefresh();
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔄 إعادة الاتصال...');
        await sendTextToTelegram('🔄 Shadow AI: انقطع الاتصال، جاري إعادة الربط...');
        setTimeout(startBot, 5000);
      } else {
        console.log('⛔ تم تسجيل الخروج.');
        await sendTextToTelegram('⛔ Shadow AI: تم تسجيل الخروج. أعد تشغيل السيرفر.');
      }
    }

    if (connection === 'open') {
      stopQRRefresh();
      // حذف رسالة QR الأخيرة
      if (qrMessageId && adminChatId) {
        try {
          await axios.post(`${TG_API}/deleteMessage`, {
            chat_id: adminChatId,
            message_id: qrMessageId,
          });
        } catch (_) {}
        qrMessageId = null;
      }
      console.log('✅ Shadow AI متصل بنجاح!');
      await sendTextToTelegram('✅ *Shadow AI متصل بواتساب!*\n\n🌑 البوت يعمل في المجموعات الآن.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;

        const jid = msg.key.remoteJid;
        if (!jid?.endsWith('@g.us')) continue;

        const msgId = msg.key.id;
        if (processedMessages.has(msgId)) continue;
        processedMessages.add(msgId);
        if (processedMessages.size > 1000) {
          processedMessages.delete(processedMessages.values().next().value);
        }

        const messageContent = msg.message;
        if (!messageContent) continue;

        let text        = '';
        let imageBase64 = null;
        let imageMime   = null;

        if (messageContent.conversation) {
          text = messageContent.conversation;
        } else if (messageContent.extendedTextMessage?.text) {
          text = messageContent.extendedTextMessage.text;
        } else if (messageContent.imageMessage) {
          text = messageContent.imageMessage.caption || 'ما الذي تراه في هذه الصورة؟';
          try {
            const buffer = await sock.downloadMediaMessage(msg);
            imageBase64  = buffer.toString('base64');
            imageMime    = messageContent.imageMessage.mimetype || 'image/jpeg';
          } catch (e) { console.error('خطأ صورة:', e.message); }
        } else {
          continue;
        }

        if (!text?.trim() && !imageBase64) continue;

        const senderJid  = msg.key.participant || msg.key.remoteJid;
        const senderName = msg.pushName || senderJid.split('@')[0];

        console.log(`📨 ${senderName}: ${text || '[صورة]'}`);

        await sock.sendPresenceUpdate('composing', jid);
        const reply = await askGemini(jid, text, senderName, imageBase64, imageMime);
        await sock.sendMessage(jid, { text: reply }, { quoted: msg });
        await sock.sendPresenceUpdate('paused', jid);

      } catch (error) {
        console.error('❌ خطأ:', error.message);
      }
    }
  });
}

// ══════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════
startBot().catch(console.error);

process.on('uncaughtException',  (err) => console.error('خطأ:', err.message));
process.on('unhandledRejection', (err) => console.error('Rejection:', err));
