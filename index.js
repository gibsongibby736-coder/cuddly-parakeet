import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import http from 'http';

// ═══════════════════════════════════════════════════
//  HTTP Server — باش Railway ما يوقفش البوت
// ═══════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('Shadow AI Bot is running ✅');
}).listen(PORT, () => {
  console.log(`🌐 HTTP Server running on port ${PORT}`);
});

// ═══════════════════════════════════════════════════
//  🔧 الإعدادات - عدّل هنا فقط
// ═══════════════════════════════════════════════════
const GEMINI_API_KEY = "AIzaSyC_IZJIvvchnBtQ-eX7wXB101q8pv2nvgQ";
const BOT_NUMBER     = "212760845308";
const MEMORY_LIMIT   = 100;

// ═══════════════════════════════════════════════════
//  المسارات
// ═══════════════════════════════════════════════════
const ROOT        = process.cwd();
const TMP         = path.join(ROOT, 'tmp');
const MEMORY_FILE = path.join(ROOT, 'memory.json');
const SESSIONS    = path.join(ROOT, 'sessions');

if (!fs.existsSync(TMP))      fs.mkdirSync(TMP,      { recursive: true });
if (!fs.existsSync(SESSIONS)) fs.mkdirSync(SESSIONS, { recursive: true });

// ═══════════════════════════════════════════════════
//  Gemini API
// ═══════════════════════════════════════════════════
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

async function callGemini(history, imageBase64 = null, imageMime = 'image/jpeg') {
  const contents = [];

  contents.push({
    role: "user",
    parts: [{ text: `You are Shadow AI, an advanced assistant.\nRULES:\n- You CAN see and analyze images.\n- NEVER say you cannot see images.\n- Reply in the SAME LANGUAGE as the user.\n- You have persistent memory — use the conversation history.\n- NEVER say "I don't remember".\n- Be helpful and accurate.` }]
  });

  contents.push({
    role: "model",
    parts: [{ text: "Understood. I am Shadow AI." }]
  });

  for (let i = 0; i < history.length - 1; i++) {
    const msg = history[i];
    contents.push({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.text }]
    });
  }

  const lastMsg = history[history.length - 1];
  const parts = [];

  if (lastMsg.text?.trim()) parts.push({ text: lastMsg.text });
  else if (!imageBase64)    parts.push({ text: "What do you see?" });

  if (imageBase64) {
    parts.push({ inlineData: { mimeType: imageMime, data: imageBase64 } });
  }

  contents.push({ role: "user", parts });

  try {
    const res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
      })
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'API Error');
    return data.candidates?.[0]?.content?.parts?.[0]?.text || "⚠️ لم أستطع الرد. حاول مرة أخرى.";
  } catch (e) {
    console.error('❌ Gemini Error:', e.message);
    return `⚠️ خطأ: ${e.message}`;
  }
}

// ═══════════════════════════════════════════════════
//  الذاكرة
// ═══════════════════════════════════════════════════
function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE))
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch (e) {}
  return {};
}

function saveMemory(mem) {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(mem, null, 2)); } catch (e) {}
}

let memory = loadMemory();

function getHistory(userId) {
  if (!memory[userId]) memory[userId] = [];
  return memory[userId];
}

async function processMessage(userId, text, imageBuffer = null, imageMime = 'image/jpeg') {
  const history  = getHistory(userId);
  const cleanText = text?.trim() || (imageBuffer ? "ماذا ترى في هذه الصورة؟" : "");

  history.push({ role: 'user', text: cleanText });

  let imageBase64 = null;
  if (imageBuffer?.length > 0) {
    imageBase64 = imageBuffer.toString('base64');
  }

  const reply = await callGemini(history, imageBase64, imageMime);
  history.push({ role: 'model', text: reply });

  while (history.length > MEMORY_LIMIT) history.shift();
  saveMemory(memory);

  return reply;
}

// ═══════════════════════════════════════════════════
//  تشغيل البوت
// ═══════════════════════════════════════════════════
async function startBot() {
  console.log('\n🚀 بدء تشغيل Shadow AI Bot...\n');

  const { state, saveCreds } = await useMultiFileAuthState(SESSIONS);
  const { version }          = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    pairingCode: true,
    logger: pino({ level: 'silent' }),
    browser: ['ShadowAI', 'Chrome', '1.0'],
    markOnlineOnConnect: true,
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 25000,
  });

  // طلب كود الإقران إذا لم يكن مسجلاً
  if (!sock.authState.creds.registered) {
    await new Promise(r => setTimeout(r, 8000));
    try {
      let code = await sock.requestPairingCode(BOT_NUMBER);
      code = code?.match(/.{1,4}/g)?.join('-') || code;
      console.log(`\n🔑 كود الربط: ${code}`);
      console.log('📱 افتح واتساب ← الإعدادات ← الأجهزة المرتبطة ← ربط بكود\n');
    } catch (err) {
      console.error('❌ فشل إنشاء كود الربط:', err.message);
    }
  }

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log('🔄 إعادة الاتصال...');
        setTimeout(() => startBot(), 5000);
      } else {
        console.log('👋 تم تسجيل الخروج — حذف الجلسة وإعادة البدء');
        fs.rmSync(SESSIONS, { recursive: true, force: true });
        fs.mkdirSync(SESSIONS, { recursive: true });
        setTimeout(() => startBot(), 3000);
      }
    } else if (connection === 'open') {
      console.log('\n✅ Shadow AI متصل وجاهز!');
      console.log('📸 يدعم تحليل الصور والنصوص\n');
    }
  });

  // معالجة الرسائل
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (msg.key.fromMe || !msg.message) continue;

        const jid = msg.key.remoteJid;
        if (!jid) continue;

        // فقط في المجموعات
        if (!jid.endsWith('@g.us')) continue;

        const msgContent = msg.message;
        const sender = msg.key.participant || msg.key.remoteJid;

        let textMsg = msgContent.conversation ||
                      msgContent.extendedTextMessage?.text ||
                      msgContent.imageMessage?.caption || '';

        const isImage = !!msgContent.imageMessage;

        if (!textMsg && !isImage) continue;

        console.log(`\n📨 من: ${sender.split('@')[0]}`);
        console.log(`💬 نص: ${textMsg || '📷 صورة'}`);

        await sock.sendPresenceUpdate('composing', jid);

        let imageBuffer = null;
        let imageMime   = 'image/jpeg';

        if (isImage) {
          try {
            imageBuffer = await downloadMediaMessage(msg, 'buffer', {}, {
              reuploadRequest: sock.updateMediaMessage
            });
            imageMime = msgContent.imageMessage?.mimetype || 'image/jpeg';
          } catch (err) {
            console.error('❌ فشل تحميل الصورة:', err.message);
            await sock.sendMessage(jid, { text: '❌ فشل تحميل الصورة. حاول مرة أخرى.' }, { quoted: msg });
            continue;
          }
        }

        const reply = await processMessage(sender, textMsg, imageBuffer, imageMime);
        await sock.sendMessage(jid, { text: reply }, { quoted: msg });
        await sock.sendPresenceUpdate('paused', jid);

        console.log(`🤖 رد: ${reply.slice(0, 80)}...`);

      } catch (err) {
        console.error('❌ خطأ:', err.message);
        try {
          await sock.sendMessage(msg.key.remoteJid,
            { text: '⚠️ حدث خطأ. حاول مرة أخرى.' },
            { quoted: msg }
          );
        } catch {}
      }
    }
  });
}

startBot().catch(console.error);
