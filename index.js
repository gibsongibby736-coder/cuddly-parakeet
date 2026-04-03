// ══════════════════════════════════════════════
//  SHADOW AI — WhatsApp Bot
//  يرد على كل رسالة في المجموعات
//  مدعوم بـ Gemini 2.5 Flash
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
const qrcode = require('qrcode-terminal');

// ══════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'AIzaSyCYZsmOHKx6v6MBDDOFzL1BSG7inUvHBPQ';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

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
- أجب دائماً بنفس لغة الشخص الذي يكلمك (عربية، فرنسية، إنجليزية...)
- ردودك مختصرة ومناسبة لواتساب، لا تطول كثيراً
- استخدم إيموجي باعتدال لتكون ردودك حيوية
- إذا سألك أحد من أنت، عرّف بنفسك باختصار
- إذا أرسل أحد صورة، حللها واشرح ما تراه فيها
- لا تقل أبداً أنك ChatGPT أو Gemini أو أي ذكاء آخر، أنت Shadow فقط
- تذكر سياق المحادثة السابقة في المجموعة
- إذا كان السؤال لا يحتاج رداً (مثل أحد يحيي آخر فقط) يمكنك الرد بإيموجي بسيط`;

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

    // System prompt
    contents.push({ role: 'user',  parts: [{ text: SYSTEM_PROMPT }] });
    contents.push({ role: 'model', parts: [{ text: 'مفهوم! أنا Shadow جاهز 🌑' }] });

    // السجل السابق
    for (const item of history.slice(-MAX_HISTORY)) {
      contents.push(item);
    }

    // الرسالة الحالية
    const currentParts = [];
    if (userMessage && userMessage.trim()) {
      currentParts.push({ text: `${userName}: ${userMessage.trim()}` });
    }
    if (imageBase64) {
      currentParts.push({
        inlineData: { mimeType: imageMime || 'image/jpeg', data: imageBase64 }
      });
    }
    contents.push({ role: 'user', parts: currentParts });

    const response = await axios.post(GEMINI_URL, {
      contents,
      generationConfig: {
        temperature: 0.85,
        maxOutputTokens: 800,
      }
    }, {
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' }
    });

    const reply = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (reply && reply.trim()) {
      // حفظ في السجل
      history.push({ role: 'user',  parts: currentParts });
      history.push({ role: 'model', parts: [{ text: reply }] });
      // تقليص السجل
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

// رسائل يتجاهلها البوت (لا تحتاج رد)
const IGNORE_PATTERNS = [
  /^(https?:\/\/[^\s]+)$/i,  // روابط فقط
];

function shouldIgnore(text) {
  if (!text || text.trim().length < 2) return true;
  for (const pattern of IGNORE_PATTERNS) {
    if (pattern.test(text.trim())) return true;
  }
  return false;
}

async function startBot() {
  console.log('🌑 Shadow AI Bot يبدأ التشغيل...');

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

  // حفظ credentials
  sock.ev.on('creds.update', saveCreds);

  // حالة الاتصال
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 امسح هذا الـ QR Code بواتساب:');
      qrcode.generate(qr, { small: true });
      console.log('═'.repeat(50));
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('🔌 انقطع الاتصال. الكود:', code);
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔄 إعادة الاتصال خلال 5 ثوانٍ...');
        setTimeout(startBot, 5000);
      } else {
        console.log('⛔ تم تسجيل الخروج. احذف مجلد auth_info وأعد التشغيل.');
      }
    }

    if (connection === 'open') {
      console.log('✅ Shadow AI متصل بنجاح!');
      console.log('🌑 البوت يستمع لجميع المجموعات...');
    }
  });

  // استقبال الرسائل
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        // تجاهل رسائل البوت نفسه
        if (msg.key.fromMe) continue;

        // فقط المجموعات
        const jid = msg.key.remoteJid;
        if (!jid?.endsWith('@g.us')) continue;

        // منع التكرار
        const msgId = msg.key.id;
        if (processedMessages.has(msgId)) continue;
        processedMessages.add(msgId);
        if (processedMessages.size > 1000) {
          processedMessages.delete(processedMessages.values().next().value);
        }

        const messageContent = msg.message;
        if (!messageContent) continue;

        let text          = '';
        let imageBase64   = null;
        let imageMime     = null;

        // نص عادي
        if (messageContent.conversation) {
          text = messageContent.conversation;
        }
        // نص extended
        else if (messageContent.extendedTextMessage?.text) {
          text = messageContent.extendedTextMessage.text;
        }
        // صورة
        else if (messageContent.imageMessage) {
          text = messageContent.imageMessage.caption || 'ما الذي تراه في هذه الصورة؟';
          try {
            const buffer = await sock.downloadMediaMessage(msg);
            imageBase64  = buffer.toString('base64');
            imageMime    = messageContent.imageMessage.mimetype || 'image/jpeg';
          } catch (e) {
            console.error('خطأ في تحميل الصورة:', e.message);
          }
        }
        // فيديو (تجاهل)
        else if (messageContent.videoMessage) {
          continue;
        }
        // sticker (تجاهل)
        else if (messageContent.stickerMessage) {
          continue;
        }
        // صوت (تجاهل)
        else if (messageContent.audioMessage) {
          continue;
        }

        // تجاهل الرسائل الفارغة أو القصيرة جداً
        if (shouldIgnore(text) && !imageBase64) continue;

        // اسم المرسل
        const senderJid  = msg.key.participant || msg.key.remoteJid;
        const senderName = msg.pushName || senderJid.split('@')[0];

        console.log(`\n📨 [مجموعة] ${senderName}: ${text || '[صورة]'}`);

        // إظهار "يكتب..."
        await sock.sendPresenceUpdate('composing', jid);

        // الرد من Gemini
        const reply = await askGemini(jid, text, senderName, imageBase64, imageMime);

        console.log(`🌑 Shadow: ${reply.substring(0, 100)}`);

        // إرسال الرد (مع quote للرسالة الأصلية)
        await sock.sendMessage(jid, { text: reply }, { quoted: msg });

        // إيقاف "يكتب..."
        await sock.sendPresenceUpdate('paused', jid);

      } catch (error) {
        console.error('❌ خطأ:', error.message);
      }
    }
  });

  return sock;
}

// ══════════════════════════════════════════════
//  START
// ══════════════════════════════════════════════
startBot().catch(console.error);

process.on('uncaughtException',  (err) => console.error('خطأ غير متوقع:', err.message));
process.on('unhandledRejection', (err) => console.error('Promise rejection:', err));
