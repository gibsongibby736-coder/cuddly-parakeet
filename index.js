// حذف auth_info القديم تلقائياً عند كل تشغيل
const fs = require('fs');
if (fs.existsSync('./auth_info')) {
  fs.rmSync('./auth_info', { recursive: true, force: true });
  console.log('🗑 تم حذف auth_info القديم — جاري طلب QR جديد...');
}

// ══════════════════════════════════════════════
//  SHADOW AI — WhatsApp Bot v5
//  إصلاح تحميل الصور + ردود طويلة + OCR لقراءة الصور
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
const Tesseract = require('tesseract.js');

// ══════════════════════════════════════════════
//  CONFIG
// ══════════════════════════════════════════════
const TG_TOKEN   = process.env.TELEGRAM_TOKEN   || '';
const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TG_API     = `https://api.telegram.org/bot${TG_TOKEN}`;

// ══════════════════════════════════════════════
//  SYSTEM PROMPT
// ══════════════════════════════════════════════
const SYSTEM_PROMPT =
  'You are Shadow, an advanced AI assistant inside a WhatsApp group. ' +
  'Your name is Shadow 🌑. You were developed by a young Moroccan developer. ' +
  'IMPORTANT RULES: ' +
  '1. Always respond in the same language as the user (Arabic, French, English, Darija...). ' +
  '2. If the user asks a SHORT question or greeting, give a SHORT answer. ' +
  '3. If the user sends an EXAM, EXERCISE, TEST, or long educational content — give a COMPLETE and DETAILED answer covering all parts. Do NOT cut your answer short. ' +
  '4. If the user sends an image with questions or exercises, READ the extracted text carefully and answer ALL the questions you see. ' +
  '5. Use emojis moderately. ' +
  '6. Never say you are Gemini, ChatGPT, or any other AI. You are Shadow only. ' +
  '7. Remember the conversation context. ' +
  '8. When answering exams or exercises, structure your answer clearly with numbers or bullet points. ' +
  '9. When text is extracted from an image, treat it as if the user wrote it themselves.';

// ══════════════════════════════════════════════
//  OCR — استخراج النص من الصورة محلياً
// ══════════════════════════════════════════════
async function extractTextFromImage(imgB64, imgMime) {
  try {
    console.log('🔍 جاري استخراج النص من الصورة...');
    const buffer = Buffer.from(imgB64, 'base64');
    const { data: { text } } = await Tesseract.recognize(buffer, 'ara+eng', {
      logger: (m) => {
        if (m.status === 'recognizing text') {
          console.log(`📖 OCR: ${Math.round(m.progress * 100)}%`);
        }
      }
    });
    const cleanedText = text.trim();
    if (cleanedText) {
      console.log(`✅ تم استخراج النص: ${cleanedText.substring(0, 150)}...`);
    } else {
      console.log('⚠️ لم يتم العثور على نص في الصورة');
    }
    return cleanedText;
  } catch (e) {
    console.error('❌ OCR error:', e.message);
    return '';
  }
}

// ══════════════════════════════════════════════
//  AI — Pollinations (مجاني بدون مفتاح)
// ══════════════════════════════════════════════
const histories = new Map();
const MAX_HIST  = 10;

async function askAI(groupId, text, userName, imgB64, imgMime) {
  let finalText = text || '';
  let extractedText = '';
  
  // إذا كانت هناك صورة، حاول استخراج النص منها
  if (imgB64) {
    extractedText = await extractTextFromImage(imgB64, imgMime);
    if (extractedText) {
      finalText = `[نص مستخرج من الصورة]: ${extractedText}\n\nسؤال المستخدم: ${text || 'أجب على جميع الأسئلة والتمارين الموجودة في هذا النص المستخرج من الصورة.'}`;
      console.log(`📝 تم دمج النص المستخرج: ${extractedText.length} حرف`);
    } else {
      finalText = text || 'لم أستطع قراءة النص في هذه الصورة. هل يمكنك كتابة السؤال نصياً؟';
      if (!text) {
        return '📷 لم أتمكن من قراءة النص في هذه الصورة. يرجى إرسال السؤال كتابةً وسأجيبك عليه فوراً.';
      }
    }
  }
  
  if (!finalText || finalText.trim() === '') {
    return 'الرجاء كتابة سؤالك نصياً حتى أتمكن من مساعدتك.';
  }

  if (!histories.has(groupId)) histories.set(groupId, []);
  const hist = histories.get(groupId);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...hist.slice(-MAX_HIST),
  ];

  messages.push({ role: 'user', content: `${userName}: ${finalText}` });

  try {
    const res = await axios.post(
      'https://text.pollinations.ai/openai',
      {
        model: 'openai',
        messages,
        temperature: 0.7,
        max_tokens: 2000,
        private: true,
      },
      { timeout: 60000, headers: { 'Content-Type': 'application/json' } }
    );

    const reply = res.data?.choices?.[0]?.message?.content?.trim();

    if (reply) {
      hist.push({ role: 'user', content: `${userName}: ${finalText.substring(0, 500)}` });
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
//  إرسال رد طويل (تقسيم إذا تجاوز 4000 حرف)
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
    let cutAt = remaining.lastIndexOf('\n', MAX_LEN);
    if (cutAt < MAX_LEN * 0.5) cutAt = MAX_LEN;
    parts.push(remaining.substring(0, cutAt));
    remaining = remaining.substring(cutAt).trim();
  }
  for (let i = 0; i < parts.length; i++) {
    const prefix = parts.length > 1 ? `(${i + 1}/${parts.length})\n` : '';
    await sock.sendMessage(jid, { text: prefix + parts[i] },
      i === 0 ? { quoted: quotedMsg } : undefined);
    if (i < parts.length - 1) await new Promise(r => setTimeout(r, 1000));
  }
}

// ══════════════════════════════════════════════
//  TELEGRAM
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
            const buffer = await downloadMediaMessage(
              msg,
              'buffer',
              {},
              { logger: pino({ level: 'silent' }), reuploadRequest: sock.updateMediaMessage }
            );
            imgB64  = buffer.toString('base64');
            imgMime = mc.imageMessage.mimetype || 'image/jpeg';
            console.log(`📸 صورة محمّلة: ${Math.round(buffer.length / 1024)}KB`);
          } catch (e) {
            console.error('خطأ صورة:', e.message);
            await sock.sendMessage(jid,
              { text: '⚠️ لم أتمكن من تحميل الصورة، حاول إعادة إرسالها.' },
              { quoted: msg }
            );
            continue;
          }
        } else {
          continue;
        }

        const sender = msg.key.participant || jid;
        const name   = msg.pushName || sender.split('@')[0];

        console.log(`📨 ${name}: ${text || '[صورة]'}`);

        await sock.sendPresenceUpdate('composing', jid);

        const reply = await askAI(jid, text, name, imgB64, imgMime);

        await sendLongMessage(sock, jid, reply, msg);
        await sock.sendPresenceUpdate('paused', jid);

        console.log(`🌑 → ${reply.substring(0, 80)}${reply.length > 80 ? '...' : ''}`);

      } catch (e) {
        console.error('❌ خطأ:', e.message);
      }
    }
  });
}

startBot().catch(console.error);
process.on('uncaughtException',  e => console.error('uncaughtException:', e.message));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));