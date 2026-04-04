// ══════════════════════════════════════════════
//  SHADOW AI — WhatsApp Bot v4
//  - QR Code يُرسل لتيليغرام كصورة
//  - Pollinations AI (مجاني، بدون مفتاح، يدعم الصور)
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
//  CONFIG — من Railway Variables فقط
// ══════════════════════════════════════════════
const TG_TOKEN   = process.env.TELEGRAM_TOKEN   || '6972946117';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8050164926:AAHwnYuIVhOUudXFkUjjJ5TqLnbm-A_Qz2s';
const TG_API     = `https://api.telegram.org/bot${TG_TOKEN}`;

// ══════════════════════════════════════════════
//  SYSTEM PROMPT
// ══════════════════════════════════════════════
const SYSTEM_PROMPT =
  'You are Shadow, an advanced AI assistant inside a WhatsApp group. ' +
  'Your name is Shadow 🌑. You were developed by a young Moroccan developer. ' +
  'Always respond in the same language as the user (Arabic, French, English, Darija...). ' +
  'Keep responses short and suitable for WhatsApp. ' +
  'Use emojis moderately. ' +
  'If asked who you are, introduce yourself briefly. ' +
  'If given an image, analyze it carefully and describe what you see in detail. ' +
  'Never say you are Gemini, ChatGPT, or any other AI. You are Shadow only. ' +
  'Remember the conversation context.';

// ══════════════════════════════════════════════
//  POLLINATIONS AI
// ══════════════════════════════════════════════
const histories = new Map();
const MAX_HIST  = 10;

async function askAI(groupId, text, userName, imgB64, imgMime) {
  if (!histories.has(groupId)) histories.set(groupId, []);
  const hist = histories.get(groupId);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...hist.slice(-MAX_HIST),
  ];

  if (imgB64) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: `data:${imgMime || 'image/jpeg'};base64,${imgB64}` }
        },
        {
          type: 'text',
          text: `${userName}: ${text || 'ماذا ترى في هذه الصورة؟'}`
        }
      ]
    });
  } else {
    messages.push({ role: 'user', content: `${userName}: ${text}` });
  }

  try {
    const res = await axios.post(
      'https://text.pollinations.ai/openai',
      {
        model: imgB64 ? 'openai-large' : 'openai',
        messages,
        temperature: 0.8,
        max_tokens: 600,
        private: true,
      },
      { timeout: 45000, headers: { 'Content-Type': 'application/json' } }
    );

    const reply = res.data?.choices?.[0]?.message?.content?.trim();

    if (reply) {
      hist.push({ role: 'user',      content: `${userName}: ${text || '[صورة]'}` });
      hist.push({ role: 'assistant', content: reply });
      if (hist.length > MAX_HIST * 2) hist.splice(0, 2);
      return reply;
    }
    return '⚠️ لم أتمكن من الرد، حاول مرة أخرى.';
  } catch (e) {
    console.error('AI error:', e.response?.data || e.message);
    if (e.code === 'ECONNABORTED') return '⏳ انتهت مهلة الاتصال، حاول مرة أخرى.';
    return '⚠️ حدث خطأ، حاول لاحقاً.';
  }
}

// ══════════════════════════════════════════════
//  TELEGRAM
// ══════════════════════════════════════════════
let qrMsgId  = null;
let qrTimer  = null;
let lastQR   = null;

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
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log('⚠️ أضف TELEGRAM_TOKEN و TELEGRAM_CHAT_ID في Railway Variables');
    return;
  }
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
      console.log(`🔌 انقطع (${code})`);
      if (code === DisconnectReason.loggedOut) {
        await tgSendText('⛔ *Shadow AI:* تم تسجيل الخروج.\nاحذف مجلد `auth_info` وأعد النشر.');
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

        const jid = msg.key.remoteJid;
        if (!jid?.endsWith('@g.us')) continue;

        if (seen.has(msg.key.id)) continue;
        seen.add(msg.key.id);
        if (seen.size > 2000) seen.delete(seen.values().next().value);

        const mc = msg.message;
        if (!mc) continue;

        let text   = '';
        let imgB64 = null;
        let imgMime = null;

        if (mc.conversation) {
          text = mc.conversation;
        } else if (mc.extendedTextMessage?.text) {
          text = mc.extendedTextMessage.text;
        } else if (mc.imageMessage) {
          text = mc.imageMessage.caption || '';
          try {
            const stream = await sock.downloadContentFromMessage(mc.imageMessage, 'image');
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const buf = Buffer.concat(chunks);
            imgB64  = buf.toString('base64');
            imgMime = mc.imageMessage.mimetype || 'image/jpeg';
            console.log(`📸 صورة: ${Math.round(buf.length / 1024)}KB`);
          } catch (e) {
            console.error('خطأ صورة:', e.message);
          }
        } else {
          continue;
        }

        if (!text?.trim() && !imgB64) continue;

        const sender = msg.key.participant || jid;
        const name   = msg.pushName || sender.split('@')[0];

        console.log(`📨 ${name}: ${text || '[صورة]'}`);

        await sock.sendPresenceUpdate('composing', jid);
        const reply = await askAI(jid, text, name, imgB64, imgMime);
        await sock.sendMessage(jid, { text: reply }, { quoted: msg });
        await sock.sendPresenceUpdate('paused', jid);

        console.log(`🌑 → ${reply.substring(0, 80)}`);

      } catch (e) {
        console.error('❌ خطأ:', e.message);
      }
    }
  });
}

startBot().catch(console.error);
process.on('uncaughtException',  e => console.error('uncaughtException:', e.message));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
