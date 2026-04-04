// ══════════════════════════════════════════════
//  SHADOW AI — WhatsApp Bot v3
//  - ربط برقم الهاتف (بدون QR)
//  - Pollinations AI (مجاني، بدون مفتاح، يدعم الصور)
//  - API Key فقط في Railway Variables
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
const FormData = require('form-data');

// ══════════════════════════════════════════════
//  CONFIG — كل شيء من Environment Variables فقط
// ══════════════════════════════════════════════
const PHONE_NUMBER  = process.env.PHONE_NUMBER  || '212760845308'; // رقم الهاتف مثال: 212XXXXXXXXX
const TG_TOKEN      = process.env.TELEGRAM_TOKEN   || '8050164926:AAHwnYuIVhOUudXFkUjjJ5TqLnbm-A_Qz2s';
const TG_CHAT_ID    = process.env.TELEGRAM_CHAT_ID || '6972946117';
const TG_API        = `https://api.telegram.org/bot${TG_TOKEN}`;

// ══════════════════════════════════════════════
//  SYSTEM PROMPT
// ══════════════════════════════════════════════
const SYSTEM_PROMPT =
  'You are Shadow, an advanced AI assistant inside a WhatsApp group. ' +
  'Your name is Shadow 🌑. You were developed by a young Moroccan developer. ' +
  'Rules: ' +
  'Always respond in the same language as the user (Arabic, French, English, Darija...). ' +
  'Keep responses short and suitable for WhatsApp. ' +
  'Use emojis moderately. ' +
  'If asked who you are, introduce yourself briefly. ' +
  'If given an image, analyze it carefully and describe what you see. ' +
  'Never say you are Gemini, ChatGPT, or any other AI. You are Shadow only. ' +
  'Remember the conversation context.';

// ══════════════════════════════════════════════
//  POLLINATIONS AI — مجاني بدون مفتاح
// ══════════════════════════════════════════════
const histories = new Map();
const MAX_HIST  = 10;

async function askAI(groupId, text, userName, imgBase64, imgMime) {
  if (!histories.has(groupId)) histories.set(groupId, []);
  const hist = histories.get(groupId);

  // بناء الرسائل
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...hist.slice(-MAX_HIST),
  ];

  // الرسالة الحالية
  if (imgBase64) {
    // رسالة مع صورة
    messages.push({
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: `data:${imgMime || 'image/jpeg'};base64,${imgBase64}` }
        },
        {
          type: 'text',
          text: `${userName}: ${text || 'ماذا ترى في هذه الصورة؟'}`
        }
      ]
    });
  } else {
    messages.push({
      role: 'user',
      content: `${userName}: ${text}`
    });
  }

  try {
    const res = await axios.post(
      'https://text.pollinations.ai/openai',
      {
        model: imgBase64 ? 'openai-large' : 'openai',
        messages,
        temperature: 0.8,
        max_tokens: 600,
        private: true, // لمنع التخزين العام
      },
      {
        timeout: 45000,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const reply = res.data?.choices?.[0]?.message?.content?.trim();

    if (reply) {
      // حفظ في السجل (نص فقط)
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
//  TELEGRAM — إشعارات فقط
// ══════════════════════════════════════════════
async function tgSend(text) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  try {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text,
      parse_mode: 'Markdown',
    }, { timeout: 8000 });
  } catch (_) {}
}

async function tgSendCode(code) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log(`\n🔑 كود الربط: ${code}\n`);
    return;
  }
  try {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text:
        `🔑 *كود ربط Shadow AI*\n\n` +
        `\`${code}\`\n\n` +
        `📱 افتح واتساب ← النقاط الثلاث\n` +
        `← الأجهزة المرتبطة ← ربط برقم الهاتف\n` +
        `← أدخل هذا الكود`,
      parse_mode: 'Markdown',
    }, { timeout: 8000 });
    console.log(`🔑 كود الربط أُرسل لتيليغرام: ${code}`);
  } catch (e) {
    console.log(`🔑 كود الربط: ${code}`);
  }
}

// ══════════════════════════════════════════════
//  WHATSAPP BOT
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
    mobile: false,
  });

  sock.ev.on('creds.update', saveCreds);

  // ── ربط برقم الهاتف بدون QR ──────────────────
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, isNewLogin }) => {

    // طلب كود الربط عند أول تشغيل
    if (
      !sock.authState.creds.registered &&
      PHONE_NUMBER &&
      connection !== 'open'
    ) {
      try {
        await new Promise(r => setTimeout(r, 2000));
        const code = await sock.requestPairingCode(PHONE_NUMBER.replace(/[^0-9]/g, ''));
        await tgSendCode(code);
      } catch (e) {
        // إذا سبق طلب الكود، تجاهل الخطأ
        if (!e.message?.includes('pairing')) {
          console.error('pairing error:', e.message);
        }
      }
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔌 انقطع (${code})`);

      if (code === DisconnectReason.loggedOut) {
        console.log('⛔ تسجيل الخروج.');
        await tgSend('⛔ *Shadow AI:* تم تسجيل الخروج.\nاحذف مجلد `auth_info` وأعد النشر.');
      } else if (code === 515) {
        // إعادة تشغيل طبيعية
        console.log('🔄 إعادة تشغيل...');
        setTimeout(startBot, 3000);
      } else {
        await tgSend('🔄 *Shadow AI:* انقطع الاتصال، جاري إعادة الربط...');
        setTimeout(startBot, 5000);
      }
    }

    if (connection === 'open') {
      console.log('✅ Shadow AI متصل!');
      await tgSend('✅ *Shadow AI متصل بواتساب!*\n🌑 البوت يعمل في المجموعات الآن.');
    }
  });

  // ── استقبال الرسائل ───────────────────────────
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
        if (seen.size > 2000) seen.delete(seen.values().next().value);

        const mc = msg.message;
        if (!mc) continue;

        let text    = '';
        let imgB64  = null;
        let imgMime = null;

        if (mc.conversation) {
          text = mc.conversation;
        } else if (mc.extendedTextMessage?.text) {
          text = mc.extendedTextMessage.text;
        } else if (mc.imageMessage) {
          text    = mc.imageMessage.caption || '';
          // تحميل الصورة بالطريقة الصحيحة
          try {
            const stream = await sock.downloadContentFromMessage(mc.imageMessage, 'image');
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            const buf = Buffer.concat(chunks);
            imgB64  = buf.toString('base64');
            imgMime = mc.imageMessage.mimetype || 'image/jpeg';
            console.log(`📸 صورة محمّلة: ${Math.round(buf.length / 1024)}KB`);
          } catch (e) {
            console.error('خطأ تحميل صورة:', e.message);
            text = text || 'أرسل لي صورة';
          }
        } else {
          continue; // تجاهل صوت، فيديو، sticker
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

  return sock;
}

// ══════════════════════════════════════════════
//  RUN
// ══════════════════════════════════════════════
startBot().catch(console.error);

process.on('uncaughtException',  e => console.error('uncaughtException:', e.message));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));
