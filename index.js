// حذف auth_info القديم تلقائياً عند كل تشغيل
const fs = require('fs');
if (fs.existsSync('./auth_info')) {
  fs.rmSync('./auth_info', { recursive: true, force: true });
  console.log('🗑 تم حذف auth_info القديم — جاري طلب QR جديد...');
}

// ══════════════════════════════════════════════
//  SHADOW AI — WhatsApp Bot v15 (API Version Fix)
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
  process.exit(1);
}

// ══════════════════════════════════════════════
//  SYSTEM PROMPT
// ══════════════════════════════════════════════
const SYSTEM_PROMPT = `أنت Shadow، مساعد ذكاء اصطناعي متقدم داخل مجموعة واتساب.
اسمك Shadow 🌑. تم تطويرك بواسطة مطور مغربي شاب.

القواعد المهمة:
1. دائماً رد بنفس لغة المستخدم (عربية، فرنسية، إنجليزية، دارجة).
2. إذا سأل المستخدم سؤالاً قصيراً أو تحية، أعط رداً قصيراً.
3. إذا أرسل المستخدم اختباراً أو تمريناً طويلاً — أعط رداً كاملاً ومفصلاً.
4. إذا أرسل المستخدم صورة، اقرأها بعناية وأجب على كل الأسئلة.
5. لا تقل أبداً أنك Gemini. أنت Shadow فقط.
6. تذكر سياق المحادثة (آخر 10 رسائل فقط).`;

// ══════════════════════════════════════════════
//  تهيئة Gemini (مع apiVersion: 'v1')
// ══════════════════════════════════════════════
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

const model = genAI.getGenerativeModel({ 
  model: "gemini-1.5-flash",
  systemInstruction: SYSTEM_PROMPT,
  generationConfig: {
    temperature: 0.7,
    topP: 0.95,
    topK: 40,
    maxOutputTokens: 2048,
  }
}, { apiVersion: 'v1' });  // ✅ إجبار استخدام v1

// ══════════════════════════════════════════════
//  نظام الطوابير
// ══════════════════════════════════════════════
const userQueues = new Map();
const userProcessing = new Map();
const MAX_QUEUE_SIZE = 10;

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
          new Promise((_, reject) => setTimeout(() => reject(new Error('Task timeout')), 45000))
        ]);
      } catch (e) {
        console.error(`❌ خطأ:`, e.message);
      }
      await new Promise(r => setTimeout(r, 1500));
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
//  ذاكرة المحادثات
// ══════════════════════════════════════════════
const histories = new Map();
const MAX_HISTORY = 10;

// ══════════════════════════════════════════════
//  تحويل الصوت إلى نص (مع apiVersion: 'v1')
// ══════════════════════════════════════════════
async function convertAudioToText(audioBuffer, mimeType) {
  try {
    console.log('🎤 جاري تحويل الصوت إلى نص...');
    const base64Audio = audioBuffer.toString('base64');
    
    const audioModel = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash" 
    }, { apiVersion: 'v1' });  // ✅ إجبار استخدام v1
    
    const result = await audioModel.generateContent([
      {
        inlineData: {
          mimeType: mimeType || 'audio/ogg',
          data: base64Audio
        }
      },
      { text: "حول هذا الصوت إلى نص مكتوب باللغة الأصلية. اكتب فقط النص." }
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
//  AI
// ══════════════════════════════════════════════
async function askAI(userId, groupId, text, userName, imgB64, imgMime, audioText) {
  let finalText = text || '';
  
  if (audioText) {
    finalText = `[رسالة صوتية]: "${audioText}"\n\n${finalText}`;
  }
  
  if (!finalText.trim() && !imgB64) {
    return "👋 مرحباً! كيف يمكنني مساعدتك؟";
  }
  
  const userKey = `${groupId}_${userName}`;
  
  if (!histories.has(userKey)) {
    histories.set(userKey, []);
  }
  const hist = histories.get(userKey);
  
  const chat = model.startChat({
    history: hist.slice(-MAX_HISTORY),
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
    }
  });
  
  const parts = [];
  const userPrompt = `المستخدم (${userName}) يقول: ${finalText}`;
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
      hist.push({ role: "user", parts: [{ text: finalText.substring(0, 300) + (imgB64 ? ' [صورة]' : '') }] });
      hist.push({ role: "model", parts: [{ text: reply.substring(0, 2000) }] });
      
      while (hist.length > MAX_HISTORY * 2) {
        hist.shift();
      }
      
      console.log(`✅ رد على ${userName} (${reply.length} حرف)`);
      return reply;
    }
    return '⚠️ عذراً، لم أتمكن من معالجة طلبك.';
    
  } catch (e) {
    console.error('❌ Gemini error:', e.message);
    
    if (e.message.includes('429')) {
      return '⚠️ تم تجاوز عدد الطلبات. انتظر قليلاً.';
    }
    if (e.message.includes('safety')) {
      return '⚠️ تعذرت معالجة المحتوى بسبب قيود الأمان.';
    }
    return '⚠️ حدث خطأ في الاتصال. حاول لاحقاً.';
  }
}

// ══════════════════════════════════════════════
//  إرسال رد طويل
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
    
    if (i < parts.length - 1) await new Promise(r => setTimeout(r, 1000));
  }
  
  console.log(`✉️ تم إرسال الرد مقسماً على ${parts.length} أجزاء`);
}

// ══════════════════════════════════════════════
//  TELEGRAM (QR فقط)
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
    form.append('caption', '🌑 *Shadow AI — امسح للربط*\n\n⏱ ينتهي خلال 60 ثانية');
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
  console.log('🌑 Shadow AI يبدأ...');
  console.log('🤖 باستخدام Gemini 1.5 Flash (apiVersion: v1)');
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
    browser: ['Shadow AI', 'Chrome', '120.0.0'],
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
      console.log('✅ متصل!');
      await tgSendText('✅ Shadow AI متصل بواتساب!');
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
        
        if (mc.conversation) {
          text = mc.conversation;
        } else if (mc.extendedTextMessage?.text) {
          text = mc.extendedTextMessage.text;
        } else if (mc.imageMessage) {
          text = mc.imageMessage.caption || '';
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, {});
            imgB64 = buffer.toString('base64');
            imgMime = mc.imageMessage.mimetype || 'image/jpeg';
          } catch (e) {
            continue;
          }
        } else if (mc.audioMessage) {
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {}, {});
            audioText = await convertAudioToText(buffer, mc.audioMessage.mimetype);
            if (audioText) text = `[رسالة صوتية]: ${audioText}`;
            else continue;
          } catch (e) {
            continue;
          }
        } else {
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