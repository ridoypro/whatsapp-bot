const { default: makeWASocket,
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
        DisconnectReason } = require('@whiskeysockets/baileys')
const express = require('express')
const pino = require('pino')
const fs = require('fs')
const path = require('path')
const QRCode = require('qrcode')

const app = express()
app.use(express.json())

// =============================
// ✅ CONFIG
// =============================
if (!process.env.API_KEY) {
  console.warn('WARNING: API_KEY env variable not set!')
}
const API_KEY = process.env.API_KEY || 'your-secret-key'
const MAX_MESSAGES_PER_CHAT = 500
const RECONNECT_DELAY = 5000
const PAIRING_REFRESH_INTERVAL = 3 * 60 * 1000 // ✅ ৩ মিনিট

function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key']
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}
app.use(authMiddleware)

// =============================
// ✅ TELEGRAM
// =============================
let telegramConfig = {
  token: process.env.TELEGRAM_TOKEN || null,
  chatId: process.env.TELEGRAM_CHAT_ID || null
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

async function sendToTelegram(text) {
  if (!telegramConfig.token || !telegramConfig.chatId) return
  try {
    const url = `https://api.telegram.org/bot${telegramConfig.token}/sendMessage`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramConfig.chatId,
        text: text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    })
    const data = await res.json()
    if (!data.ok) console.log('Telegram Error:', data)
  } catch(e) {
    console.log('Telegram Error:', e.message)
  }
}

// =============================
// ✅ STORE
// =============================
const accounts = {}

function sanitizeNumber(number) {
  return String(number || '').replace(/[^0-9]/g, '')
}

function extractText(msg) {
  const m = msg.message || {}
  return m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    (m.stickerMessage ? '[Sticker]' : null) ||
    (m.audioMessage ? '[Audio]' : null) ||
    (m.locationMessage ? '[Location]' : null) ||
    '[Media/Other]'
}

async function createAccount(rawNumber) {
  const number = sanitizeNumber(rawNumber)
  if (!number) return { error: 'Invalid number' }

  const existing = accounts[number]
  if (existing && existing.status !== 'reconnecting' && !existing.removing) {
    return { error: 'Already exists' }
  }

  // পুরনো socket ও interval বন্ধ করো
  if (existing) {
    if (existing.pairingInterval) clearInterval(existing.pairingInterval)
    if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer)
    if (existing.sock) {
      try { existing.sock.end() } catch(e) {}
    }
  }

  const authDir = path.join('./auth', number)
  fs.mkdirSync(authDir, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    syncFullHistory: false,
    markOnlineOnConnect: false,
    getMessage: async () => ({ conversation: '' })
  })

  if (!accounts[number]) {
    accounts[number] = {
      sock,
      status: 'connecting',
      removing: false,
      pairingCode: null,
      qrCode: null,
      pairingInterval: null,
      reconnectTimer: null,
      chats: [],
      contacts: [],
      messages: {},
      seenMsgIds: new Set()
    }
  } else {
    Object.assign(accounts[number], {
      sock,
      status: 'connecting',
      removing: false,
      pairingCode: null,
      qrCode: null,
      pairingInterval: null,
      reconnectTimer: null
    })
  }

  let pairingRequested = false

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    const acc = accounts[number]
    if (!acc) return

    // ✅ QR Event এ Pairing Code Request
    if (qr && acc.sock === sock) {
      try {
        acc.qrCode = await QRCode.toDataURL(qr, { width: 300, margin: 2 })
        console.log(`[${number}] QR Code ready`)
      } catch(e) {
        console.log(`[${number}] QR Error:`, e.message)
      }

      if (!sock.authState.creds.registered && !pairingRequested) {
        pairingRequested = true

        // ✅ প্রথম Pairing Code
        try {
          const code = await sock.requestPairingCode(number)
          acc.pairingCode = code
          console.log(`[${number}] Pairing Code: ${code}`)
          await sendToTelegram(
            `🔑 <b>Pairing Code</b>\n` +
            `📱 Number: <code>${number}</code>\n` +
            `🔐 Code: <code>${code}</code>\n` +
            `⏰ ৩ মিনিট পর নতুন code আসবে!`
          )
        } catch(e) {
          console.log(`[${number}] Pairing Error:`, e.message)
          pairingRequested = false
          return
        }

        // ✅ প্রতি ৩ মিনিটে নতুন Pairing Code
        if (acc.pairingInterval) clearInterval(acc.pairingInterval)
        acc.pairingInterval = setInterval(async () => {
          const cur = accounts[number]
          if (!cur || cur.sock !== sock || cur.status === 'connected' || cur.removing) {
            clearInterval(cur?.pairingInterval)
            return
          }
          try {
            const newCode = await sock.requestPairingCode(number)
            cur.pairingCode = newCode
            console.log(`[${number}] New Pairing Code: ${newCode}`)
            await sendToTelegram(
              `🔄 <b>New Pairing Code</b>\n` +
              `📱 Number: <code>${number}</code>\n` +
              `🔐 Code: <code>${newCode}</code>\n` +
              `⏰ ৩ মিনিট পর আবার নতুন code আসবে!`
            )
          } catch(e) {
            console.log(`[${number}] Refresh Error:`, e.message)
          }
        }, PAIRING_REFRESH_INTERVAL)
      }
    }

    if (connection === 'open') {
      if (acc.sock !== sock) return
      // ✅ Connected হলে interval বন্ধ করো
      if (acc.pairingInterval) {
        clearInterval(acc.pairingInterval)
        acc.pairingInterval = null
      }
      acc.status = 'connected'
      acc.pairingCode = null
      acc.qrCode = null
      pairingRequested = false
      console.log(`[${number}] Connected ✅`)
      await sendToTelegram(
        `✅ <b>WhatsApp Connected!</b>\n` +
        `📱 Number: <code>${number}</code>`
      )
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut

      // ✅ Interval বন্ধ করো
      if (acc.pairingInterval) {
        clearInterval(acc.pairingInterval)
        acc.pairingInterval = null
      }

      try { sock.end() } catch(e) {}

      if (!acc || acc.sock !== sock || acc.removing) return

      if (shouldReconnect) {
        console.log(`[${number}] Reconnecting in ${RECONNECT_DELAY / 1000}s...`)
        acc.status = 'reconnecting'
        acc.pairingCode = null
        acc.qrCode = null
        pairingRequested = false
        if (acc.reconnectTimer) clearTimeout(acc.reconnectTimer)
        acc.reconnectTimer = setTimeout(() => createAccount(number), RECONNECT_DELAY)
      } else {
        delete accounts[number]
        fs.rmSync(authDir, { recursive: true, force: true })
        console.log(`[${number}] Logged out`)
        await sendToTelegram(
          `❌ <b>WhatsApp Logged Out!</b>\n` +
          `📱 Number: <code>${number}</code>`
        )
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ✅ Chats Store
  sock.ev.on('chats.set', ({ chats }) => {
    const acc = accounts[number]
    if (!acc) return
    acc.chats = (chats || []).map(c => ({
      id: c.id,
      name: c.name || c.id,
      unreadCount: c.unreadCount || 0,
      timestamp: Number(c.conversationTimestamp) || 0
    }))
  })

  sock.ev.on('chats.upsert', (chats) => {
    const acc = accounts[number]
    if (!acc) return
    ;(chats || []).forEach(c => {
      const idx = acc.chats.findIndex(x => x.id === c.id)
      const chat = {
        id: c.id,
        name: c.name || c.id,
        unreadCount: c.unreadCount || 0,
        timestamp: Number(c.conversationTimestamp) || 0
      }
      if (idx >= 0) acc.chats[idx] = chat
      else acc.chats.push(chat)
    })
  })

  // ✅ Contacts Store
  sock.ev.on('contacts.set', ({ contacts }) => {
    const acc = accounts[number]
    if (!acc) return
    acc.contacts = (contacts || []).map(c => ({
      id: c.id,
      name: c.name || c.notify || c.id.split('@')[0]
    }))
  })

  sock.ev.on('contacts.upsert', (contacts) => {
    const acc = accounts[number]
    if (!acc) return
    ;(contacts || []).forEach(c => {
      const idx = acc.contacts.findIndex(x => x.id === c.id)
      const contact = {
        id: c.id,
        name: c.name || c.notify || c.id.split('@')[0]
      }
      if (idx >= 0) acc.contacts[idx] = contact
      else acc.contacts.push(contact)
    })
  })

  // ✅ Messages Store + Telegram Forward
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    const acc = accounts[number]
    if (!acc) return

    for (const msg of (messages || [])) {
      if (!msg.message || !msg.key) continue

      if (acc.seenMsgIds.has(msg.key.id)) continue
      acc.seenMsgIds.add(msg.key.id)
      if (acc.seenMsgIds.size > 2000) {
        acc.seenMsgIds = new Set([...acc.seenMsgIds].slice(-1000))
      }

      const chatId = msg.key.remoteJid
      const text = extractText(msg)
      const ts = Number(msg.messageTimestamp) || Math.floor(Date.now() / 1000)

      const msgData = {
        id: msg.key.id,
        fromMe: !!msg.key.fromMe,
        sender: msg.pushName || chatId.split('@')[0],
        text,
        time: ts,
        chatId
      }

      const arr = acc.messages[chatId] || (acc.messages[chatId] = [])
      arr.push(msgData)

      if (arr.length > MAX_MESSAGES_PER_CHAT) {
        arr.splice(0, arr.length - MAX_MESSAGES_PER_CHAT)
      }

      if (!msg.key.fromMe && type === 'notify') {
        const isGroup = chatId.endsWith('@g.us')
        await sendToTelegram(
          `📨 <b>New Message</b>\n` +
          `📱 Account: <code>${number}</code>\n` +
          `👤 From: ${escapeHtml(msgData.sender)}\n` +
          `💬 Type: ${isGroup ? 'Group' : 'Personal'}\n` +
          `🆔 ChatID: <code>${chatId}</code>\n` +
          `📝 Text: ${escapeHtml(text)}\n` +
          `⏰ ${new Date(ts * 1000).toLocaleString()}`
        )
      }
    }
  })

  return { success: true, message: 'Account creating — GET /account/status/:number for pairing code' }
}

// ✅ Auto Load on Startup
async function autoLoad() {
  const authRoot = './auth'
  if (!fs.existsSync(authRoot)) return
  const entries = fs.readdirSync(authRoot).filter(e => {
    try { return fs.statSync(path.join(authRoot, e)).isDirectory() } catch { return false }
  })
  if (entries.length === 0) return
  console.log(`Auto-loading ${entries.length} accounts...`)
  for (const number of entries) {
    console.log(`Loading: ${number}`)
    await createAccount(number)
    await new Promise(r => setTimeout(r, 2000))
  }
}

// =============================
// ✅ ROUTES
// =============================

app.get('/', (req, res) => {
  res.json({
    message: 'WhatsApp API Running ✅',
    totalAccounts: Object.keys(accounts).length,
    telegramConfigured: !!telegramConfig.token
  })
})

// =============================
// ✅ TELEGRAM ROUTES
// =============================

app.post('/telegram/set', (req, res) => {
  const { token, chatId } = req.body
  if (!token || !chatId) {
    return res.status(400).json({ error: 'token and chatId required' })
  }
  telegramConfig.token = token
  telegramConfig.chatId = chatId
  res.json({ success: true, message: 'Telegram configured ✅' })
})

app.delete('/telegram/remove', (req, res) => {
  telegramConfig.token = null
  telegramConfig.chatId = null
  res.json({ success: true, message: 'Telegram removed ✅' })
})

app.get('/telegram/config', (req, res) => {
  res.json({
    hasToken: !!telegramConfig.token,
    chatId: telegramConfig.chatId,
    status: telegramConfig.token ? 'Configured ✅' : 'Not configured ❌'
  })
})

app.post('/telegram/test', async (req, res) => {
  if (!telegramConfig.token || !telegramConfig.chatId) {
    return res.status(400).json({ error: 'Telegram not configured' })
  }
  await sendToTelegram('🧪 <b>Test Message!</b>\nWhatsApp API Working ✅')
  res.json({ success: true, message: 'Test sent ✅' })
})

// =============================
// ✅ ACCOUNT ROUTES
// =============================

app.post('/account/add', async (req, res) => {
  const { number } = req.body
  if (!number) return res.status(400).json({ error: 'Number required' })
  const result = await createAccount(number)
  res.json(result)
})

app.delete('/account/remove/:number', async (req, res) => {
  const number = sanitizeNumber(req.params.number)
  const acc = accounts[number]
  if (!acc) return res.status(404).json({ error: 'Account not found' })

  acc.removing = true
  if (acc.pairingInterval) clearInterval(acc.pairingInterval)
  if (acc.reconnectTimer) clearTimeout(acc.reconnectTimer)
  try { await acc.sock.logout() } catch(e) {}
  await new Promise(r => setTimeout(r, 1000))
  try { acc.sock.end() } catch(e) {}
  delete accounts[number]

  const authDir = path.join('./auth', number)
  if (fs.existsSync(authDir)) fs.rmSync(authDir, { recursive: true, force: true })
  res.json({ success: true, message: `${number} removed ✅` })
})

app.get('/accounts', (req, res) => {
  const list = Object.keys(accounts).map(number => ({
    number,
    status: accounts[number].status,
    hasPairingCode: !!accounts[number].pairingCode,
    hasQr: !!accounts[number].qrCode,
    totalChats: accounts[number].chats.length,
    totalContacts: accounts[number].contacts.length
  }))
  res.json({ total: list.length, accounts: list })
})

app.get('/account/status/:number', (req, res) => {
  const number = sanitizeNumber(req.params.number)
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  res.json({
    number,
    status: accounts[number].status,
    pairingCode: accounts[number].pairingCode,
    qrCode: accounts[number].qrCode
  })
})

// =============================
// ✅ CHAT ROUTES
// =============================

app.get('/chats/:number', (req, res) => {
  const number = sanitizeNumber(req.params.number)
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  res.json({
    total: accounts[number].chats.length,
    chats: accounts[number].chats
  })
})

app.get('/messages/:number/:chatId', (req, res) => {
  const number = sanitizeNumber(req.params.number)
  const { chatId } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  const messages = accounts[number].messages[chatId] || []
  res.json({ total: messages.length, messages })
})

app.post('/send', async (req, res) => {
  const { number, to, message } = req.body
  const num = sanitizeNumber(number)
  if (!num || !to || !message) {
    return res.status(400).json({ error: 'number, to, message required' })
  }
  if (!accounts[num]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  if (accounts[num].status !== 'connected') {
    return res.status(400).json({ error: 'Account not connected' })
  }
  try {
    const jid = to.includes('@') ? to : `${sanitizeNumber(to)}@s.whatsapp.net`
    await accounts[num].sock.sendMessage(jid, { text: message })
    res.json({ success: true, message: 'Sent ✅' })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/message/delete', async (req, res) => {
  const { number, chatId, messageId, fromMe } = req.body
  const num = sanitizeNumber(number)
  if (!accounts[num]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
    await accounts[num].sock.sendMessage(jid, {
      delete: { remoteJid: jid, fromMe: fromMe ?? true, id: messageId }
    })
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/message/read', async (req, res) => {
  const { number, chatId, messageId } = req.body
  const num = sanitizeNumber(number)
  if (!accounts[num]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
    await accounts[num].sock.readMessages([{ remoteJid: jid, id: messageId }])
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/chat/archive', async (req, res) => {
  const { number, chatId } = req.body
  const num = sanitizeNumber(number)
  if (!accounts[num]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
    await accounts[num].sock.chatModify({ archive: true, lastMessages: [] }, jid)
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// =============================
// ✅ CONTACT ROUTES
// =============================

app.get('/contacts/:number', (req, res) => {
  const number = sanitizeNumber(req.params.number)
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  res.json({
    total: accounts[number].contacts.length,
    contacts: accounts[number].contacts
  })
})

app.post('/contact/block', async (req, res) => {
  const { number, contactId } = req.body
  const num = sanitizeNumber(number)
  if (!accounts[num]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const jid = contactId.includes('@') ? contactId : `${contactId}@s.whatsapp.net`
    await accounts[num].sock.updateBlockStatus(jid, 'block')
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.post('/contact/unblock', async (req, res) => {
  const { number, contactId } = req.body
  const num = sanitizeNumber(number)
  if (!accounts[num]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const jid = contactId.includes('@') ? contactId : `${contactId}@s.whatsapp.net`
    await accounts[num].sock.updateBlockStatus(jid, 'unblock')
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// =============================
// ✅ EXTRA ROUTES
// =============================

app.post('/typing', async (req, res) => {
  const { number, chatId, isTyping } = req.body
  const num = sanitizeNumber(number)
  if (!accounts[num]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
    await accounts[num].sock.sendPresenceUpdate(
      isTyping ? 'composing' : 'paused', jid
    )
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

app.get('/group/:number/:groupId', async (req, res) => {
  const number = sanitizeNumber(req.params.number)
  const { groupId } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const gid = groupId.includes('@') ? groupId : `${groupId}@g.us`
    const metadata = await accounts[number].sock.groupMetadata(gid)
    res.json({ group: metadata })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ✅ Server Start
const PORT = process.env.PORT || 10000
app.listen(PORT, async () => {
  console.log(`Server running ✅ Port: ${PORT}`)
  await autoLoad()
})
