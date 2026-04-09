// حذف auth_info القديم تلقائياً عند كل تشغيل
const fs = require('fs');
if (fs.existsSync('./auth_info')) {
  fs.rmSync('./auth_info', { recursive: true, force: true });
  console.log('🗑 تم حذف auth_info القديم — جاري طلب QR جديد...');
}

// ══════════════════════════════════════════════
//  SHADOW AI — WhatsApp Bot v13 (Telegram Control)
//  التحكم في المجموعات عبر بوت تيليغرام
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

if (!TG_TOKEN || !TG_CHAT_ID) {
  console.error('❌ TELEGRAM_TOKEN أو TELEGRAM_CHAT_ID غير موجود!');
  process.exit(1);
}

// ══════════════════════════════════════════════
//  قائمة المجموعات المسموح بها (تتحكم عبر تيليغرام)
// ══════════════════════════════════════════════
let allowedGroups = new Set(); // تخزين IDs المجموعات المسموح بها

// حفظ القائمة في ملف (للاستمرار بعد إعادة التشغيل)
const ALLOWED_GROUPS_FILE = './allowed_groups.json';

function loadAllowedGroups() {
  try {
    if (fs.existsSync(ALLOWED_GROUPS_FILE)) {
      const data = JSON.parse(fs.readFileSync(ALLOWED_GROUPS_FILE, 'utf8'));
      allowedGroups = new Set(data);
      console.log(`📂 تم تحميل ${allowedGroups.size} مجموعة مسموح بها`);
    }
  } catch (e) {
    console.error('خطأ في تحميل القائمة:', e.message);
  }
}

function saveAllowedGroups() {
  try {
    fs.writeFileSync(ALLOWED_GROUPS_FILE, JSON.stringify([...allowedGroups]), 'utf8');
    console.log(`💾 تم حفظ ${allowedGroups.size} مجموعة مسموح بها`);
  } catch (e) {
    console.error('خطأ في حفظ القائمة:', e.message);
  }
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
//  تهيئة Gemini
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
});

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
//  تحويل الصوت إلى نص
// ══════════════════════════════════════════════
async function convertAudioToText(audioBuffer, mimeType) {
  try {
    console.log('🎤 جاري تحويل الصوت إلى نص...');
    const base64Audio = audioBuffer.toString('base64');
    
    const audioModel = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    
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
      return '⚠️ تم تجاوز عدد الطلبات المسموح بها. انتظر قليلاً.';
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
//  أوامر تيليغرام
// ══════════════════════════════════════════════
let sockGlobal = null; // حفظ الـ socket للاستخدام في الأوامر
let groupsList = []; // قائمة المجموعات المنضم إليها البوت

async function updateGroupsList() {
  if (!sockGlobal) return;
  try {
    const chats = sockGlobal.chats;
    groupsList = [];
    for (const [jid, chat] of chats) {
      if (jid.endsWith('@g.us')) {
        try {
          const metadata = await sockGlobal.groupMetadata(jid);
          groupsList.push({
            id: jid,
            name: metadata.subject || 'بدون اسم',
            isAllowed: allowedGroups.has(jid)
          });
        } catch (e) {}
      }
    }
    console.log(`📋 تم تحديث قائمة المجموعات: ${groupsList.length} مجموعة`);
  } catch (e) {
    console.error('خطأ في تحديث قائمة المجموعات:', e.message);
  }
}

async function tgSendMessage(text, parseMode = 'Markdown') {
  try {
    await axios.post(`${TG_API}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text: text,
      parse_mode: parseMode
    }, { timeout: 10000 });
  } catch (e) {
    console.error('خطأ في إرسال رسالة تيليغرام:', e.message);
  }
}

async function handleTelegramCommand(text) {
  const cmd = text.trim().toLowerCase();
  
  if (cmd === '/start') {
    await tgSendMessage(`🌑 *Shadow AI Bot*\n\nمرحباً! أنا بوت التحكم في شادو.\n\n📋 *الأوامر المتاحة:*\n\n/list - عرض قائمة المجموعات\n/allow <رقم> - السماح لمجموعة\n/remove <رقم> - حظر مجموعة\n/status - عرض الإحصائيات\n/refresh - تحديث قائمة المجموعات`);
    return;
  }
  
  if (cmd === '/list' || cmd === '/groups') {
    await updateGroupsList();
    if (groupsList.length === 0) {
      await tgSendMessage(`📭 *لا توجد مجموعات* \n\nالبوت ليس منضماً لأي مجموعة بعد.`);
      return;
    }
    
    let message = `📋 *قائمة المجموعات (${groupsList.length})*\n\n`;
    for (let i = 0; i < groupsList.length; i++) {
      const g = groupsList[i];
      const status = g.isAllowed ? '✅ مسموح' : '❌ ممنوع';
      message += `${i + 1}. ${g.name}\n   \`${g.id}\`\n   ${status}\n\n`;
    }
    message += `\n📌 *للسيطرة:*\n/allow <الرقم> - السماح\n/remove <الرقم> - الحظر`;
    await tgSendMessage(message);
    return;
  }
  
  if (cmd.startsWith('/allow')) {
    const parts = cmd.split(' ');
    if (parts.length < 2) {
      await tgSendMessage(`⚠️ *الاستخدام الصحيح:*\n/allow <رقم المجموعة>\n\nمثال: /allow 1`);
      return;
    }
    
    await updateGroupsList();
    const index = parseInt(parts[1]) - 1;
    
    if (isNaN(index) || index < 0 || index >= groupsList.length) {
      await tgSendMessage(`❌ رقم غير صحيح. استخدم /list لعرض الأرقام.`);
      return;
    }
    
    const group = groupsList[index];
    allowedGroups.add(group.id);
    saveAllowedGroups();
    await tgSendMessage(`✅ *تم السماح للمجموعة:*\n${group.name}\n\`${group.id}\``);
    return;
  }
  
  if (cmd.startsWith('/remove')) {
    const parts = cmd.split(' ');
    if (parts.length < 2) {
      await tgSendMessage(`⚠️ *الاستخدام الصحيح:*\n/remove <رقم المجموعة>\n\nمثال: /remove 1`);
      return;
    }
    
    await updateGroupsList();
    const index = parseInt(parts[1]) - 1;
    
    if (isNaN(index) || index < 0 || index >= groupsList.length) {
      await tgSendMessage(`❌ رقم غير صحيح. استخدم /list لعرض الأرقام.`);
      return;
    }
    
    const group = groupsList[index];
    allowedGroups.delete(group.id);
    saveAllowedGroups();
    await tgSendMessage(`❌ *تم حظر المجموعة:*\n${group.name}\n\`${group.id}\``);
    return;
  }
  
  if (cmd === '/status') {
    await updateGroupsList();
    const allowedCount = groupsList.filter(g => g.isAllowed).length;
    await tgSendMessage(`📊 *الإحصائيات*\n\n📋 مجموعات البوت: ${groupsList.length}\n✅ مسموح: ${allowedCount}\n❌ ممنوع: ${groupsList.length - allowedCount}\n🧠 ذاكرة نشطة: ${histories.size}\n👥 طوابير نشطة: ${userQueues.size}`);
    return;
  }
  
  if (cmd === '/refresh') {
    await updateGroupsList();
    await tgSendMessage(`🔄 *تم تحديث القائمة*\n📋 عدد المجموعات: ${groupsList.length}`);
    return;
  }
}

// ══════════════════════════════════════════════
//  TELEGRAM (تلقي الأوامر)
// ══════════════════════════════════════════════
async function setupTelegramWebhook() {
  // استقبال الأوامر عبر getUpdates
  let lastUpdateId = 0;
  
  setInterval(async () => {
    try {
      const res = await axios.get(`${TG_API}/getUpdates`, {
        params: { offset: lastUpdateId + 1, timeout: 30 },
        timeout: 35000
      });
      
      for (const update of res.data.result) {
        lastUpdateId = update.update_id;
        if (update.message && update.message.text) {
          const chatId = update.message.chat.id;
          if (chatId.toString() === TG_CHAT_ID) {
            await handleTelegramCommand(update.message.text);
          }
        }
      }
    } catch (e) {}
  }, 2000);
}

// ══════════════════════════════════════════════
//  QR Code
// ══════════════════════════════════════════════
let qrMsgId = null;
let qrTimer = null;
let lastQR = null;

async function tgSendPhoto(caption, qrBuffer) {
  try {
    if (qrMsgId) {
      await axios.post(`${TG_API}/deleteMessage`, {
        chat_id: TG_CHAT_ID,
        message_id: qrMsgId
      }).catch(() => {});
    }
    const form = new FormData();
    form.append('chat_id', TG_CHAT_ID);
    form.append('photo', qrBuffer, { filename: 'qr.png', contentType: 'image/png' });
    form.append('caption', caption);
    form.append('parse_mode', 'Markdown');
    const res = await axios.post(`${TG_API}/sendPhoto`, form, {
      headers: form.getHeaders(),
      timeout: 15000
    });
    qrMsgId = res.data?.result?.message_id;
  } catch (e) {
    console.error('خطأ في إرسال QR:', e.message);
  }
}

async function sendQR(qrData) {
  try {
    const buf = await QRCode.toBuffer(qrData, {
      width: 512, margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
    await tgSendPhoto(`🌑 *Shadow AI* — امسح للربط\n\n📱 واتساب ← النقاط الثلاث ← الأجهزة المرتبطة ← ربط جهاز\n\n⏱ ينتهي خلال 60 ثانية`, buf);
    console.log('📤 QR أُرسل لتيليغرام');
  } catch (e) {
    console.error('خطأ في إنشاء QR:', e.message);
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
  console.log('🤖 باستخدام Gemini 1.5 Flash');
  console.log('📡 انتظار ظهور QR Code في تيليغرام...');
  
  loadAllowedGroups();
  await setupTelegramWebhook();
  
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
  
  sockGlobal = sock;
  
  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      startQRTimer(qr);
    }
    if (connection === 'close') {
      stopQRTimer();
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`🔌 انقطع (${code})`);
      setTimeout(startBot, 5000);
    }
    if (connection === 'open') {
      stopQRTimer();
      if (qrMsgId) {
        await axios.post(`${TG_API}/deleteMessage`, { chat_id: TG_CHAT_ID, message_id: qrMsgId }).catch(() => {});
        qrMsgId = null;
      }
      console.log('✅ Shadow AI متصل!');
      await updateGroupsList();
      await tgSendMessage(`✅ *Shadow AI متصل بواتساب!*\n\n📋 استخدم /list لعرض المجموعات\n➕ /allow <رقم> للسماح\n➖ /remove <رقم> للحظر`);
    }
  });
  
  sock.ev.on('groups.update', async () => {
    await updateGroupsList();
  });
  
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    
    for (const msg of messages) {
      try {
        if (msg.key.fromMe) continue;
        
        const jid = msg.key.remoteJid;
        if (!jid?.endsWith('@g.us')) continue;
        
        // ✅ التحقق: فقط المجموعات المسموح بها
        if (!allowedGroups.has(jid)) {
          continue;
        }
        
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
            const audioMime = mc.audioMessage.mimetype || 'audio/ogg';
            audioText = await convertAudioToText(buffer, audioMime);
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
        
        console.log(`📨 ${name}: ${text?.substring(0, 50) || '[صورة]'}`);
        
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