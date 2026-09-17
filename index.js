const { default: makeWASocket, 
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
        makeInMemoryStore,
        DisconnectReason } = require('@whiskeysockets/baileys')
const express = require('express')
const pino = require('pino')
const fs = require('fs')

const app = express()
app.use(express.json())

// ✅ API Key Middleware
const API_KEY = process.env.API_KEY || 'your-secret-key'

function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key']
  if (!key || key !== API_KEY) {
    return res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Invalid or missing API Key' 
    })
  }
  next()
}

app.use(authMiddleware)

// ✅ Telegram Config (Memory তে থাকবে)
let telegramConfig = {
  token: process.env.TELEGRAM_TOKEN || null,
  chatId: process.env.TELEGRAM_CHAT_ID || null
}

// ✅ Telegram Message Send Function
async function sendToTelegram(text) {
  if (!telegramConfig.token || !telegramConfig.chatId) return
  try {
    const url = `https://api.telegram.org/bot${telegramConfig.token}/sendMessage`
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramConfig.chatId,
        text: text,
        parse_mode: 'HTML'
      })
    })
  } catch(e) {
    console.log('Telegram Error:', e.message)
  }
}

// ✅ Telegram Message Get Function
async function getFromTelegram(offset = 0) {
  if (!telegramConfig.token) return []
  try {
    const url = `https://api.telegram.org/bot${telegramConfig.token}/getUpdates?offset=${offset}`
    const res = await fetch(url)
    const data = await res.json()
    return data.result || []
  } catch(e) {
    console.log('Telegram Get Error:', e.message)
    return []
  }
}

// ✅ Account Manager
const accounts = {}

async function createAccount(number) {
  if (accounts[number]) {
    return { error: 'Already exists' }
  }

  const authDir = `./auth/${number}`
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true })
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir)
  const { version } = await fetchLatestBaileysVersion()

  const store = makeInMemoryStore({ 
    logger: pino({ level: 'silent' }) 
  })

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

  store.bind(sock.ev)

  accounts[number] = {
    sock,
    store,
    status: 'connecting',
    pairingCode: null,
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'connecting') {
      await new Promise(r => setTimeout(r, 3000))
      if (!sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(number)
          accounts[number].pairingCode = code
          console.log(`[${number}] Pairing Code: ${code}`)
          await sendToTelegram(`🔑 <b>Pairing Code</b>\nNumber: ${number}\nCode: <code>${code}</code>`)
        } catch(e) {
          console.log(`[${number}] Code Error:`, e.message)
        }
      }
    }

    if (connection === 'open') {
      accounts[number].status = 'connected'
      accounts[number].pairingCode = null
      console.log(`[${number}] Connected ✅`)
      await sendToTelegram(`✅ <b>WhatsApp Connected!</b>\nNumber: ${number}`)
    }

    if (connection === 'close') {
      accounts[number].status = 'disconnected'
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode 
        !== DisconnectReason.loggedOut
      if (shouldReconnect) {
        console.log(`[${number}] Reconnecting...`)
        delete accounts[number]
        setTimeout(() => createAccount(number), 5000)
      } else {
        delete accounts[number]
        await sendToTelegram(`❌ <b>WhatsApp Disconnected!</b>\nNumber: ${number}`)
        console.log(`[${number}] Logged out`)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ✅ Messages → Telegram এ Save
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const chatId = msg.key.remoteJid
      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text || 
                   '[Media]'
      
      const isGroup = chatId.endsWith('@g.us')
      const sender = msg.pushName || chatId.split('@')[0]
      const chatName = isGroup ? `Group: ${chatId}` : sender

      // Telegram এ forward
      await sendToTelegram(
        `📨 <b>New Message</b>\n` +
        `📱 Account: ${number}\n` +
        `👤 From: ${sender}\n` +
        `💬 Chat: ${chatName}\n` +
        `🆔 ChatID: ${chatId}\n` +
        `📝 Message: ${text}\n` +
        `⏰ Time: ${new Date().toLocaleString('bn-BD')}`
      )
    }
  })

  return { success: true, message: 'Account creating, check pairing code' }
}

// ✅ Auto-load existing accounts on startup
async function autoLoad() {
  if (!fs.existsSync('./auth')) return
  const numbers = fs.readdirSync('./auth')
  if (numbers.length === 0) return
  console.log(`Auto-loading ${numbers.length} accounts...`)
  for (const number of numbers) {
    console.log(`Loading: ${number}`)
    await createAccount(number)
    await new Promise(r => setTimeout(r, 2000))
  }
}

// =============================
// ✅ TELEGRAM CONFIG ROUTES
// =============================

// Telegram Config Set
app.post('/telegram/set', (req, res) => {
  const { token, chatId } = req.body
  if (!token || !chatId) {
    return res.status(400).json({ error: 'token and chatId required' })
  }
  telegramConfig.token = token
  telegramConfig.chatId = chatId
  res.json({ 
    success: true, 
    message: 'Telegram config set ✅',
    config: { token: '***hidden***', chatId }
  })
})

// Telegram Config Remove
app.delete('/telegram/remove', (req, res) => {
  telegramConfig.token = null
  telegramConfig.chatId = null
  res.json({ success: true, message: 'Telegram config removed ✅' })
})

// Telegram Config View
app.get('/telegram/config', (req, res) => {
  res.json({
    hasToken: !!telegramConfig.token,
    chatId: telegramConfig.chatId,
    status: telegramConfig.token ? 'configured ✅' : 'not configured ❌'
  })
})

// Telegram Test
app.post('/telegram/test', async (req, res) => {
  if (!telegramConfig.token || !telegramConfig.chatId) {
    return res.status(400).json({ error: 'Telegram not configured' })
  }
  await sendToTelegram('🧪 Test message from WhatsApp API! ✅')
  res.json({ success: true, message: 'Test message sent to Telegram ✅' })
})

// =============================
// ✅ ACCOUNT ROUTES
// =============================

// Home
app.get('/', (req, res) => {
  res.json({ 
    message: 'WhatsApp API Running ✅',
    totalAccounts: Object.keys(accounts).length,
    telegramConfigured: !!telegramConfig.token
  })
})

// Account Add
app.post('/account/add', async (req, res) => {
  const { number } = req.body
  if (!number) return res.status(400).json({ error: 'Number required' })
  const result = await createAccount(number)
  res.json(result)
})

// Account Remove
app.delete('/account/remove/:number', (req, res) => {
  const { number } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  accounts[number].sock.logout()
  delete accounts[number]
  const authDir = `./auth/${number}`
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true })
  }
  res.json({ success: true, message: `${number} removed` })
})

// All Accounts
app.get('/accounts', (req, res) => {
  const list = Object.keys(accounts).map(number => ({
    number,
    status: accounts[number].status,
    pairingCode: accounts[number].pairingCode,
    totalChats: accounts[number].store.chats.all().length
  }))
  res.json({ total: list.length, accounts: list })
})

// Account Status
app.get('/account/status/:number', (req, res) => {
  const { number } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  res.json({
    number,
    status: accounts[number].status,
    pairingCode: accounts[number].pairingCode
  })
})

// =============================
// ✅ CHAT & MESSAGE ROUTES
// =============================

// Get Chats
app.get('/chats/:number', (req, res) => {
  const { number } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  const chats = accounts[number].store.chats.all()
  res.json({ total: chats.length, chats })
})

// Get Messages
app.get('/messages/:number/:chatId', (req, res) => {
  const { number, chatId } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  const messages = accounts[number].store.messages[chatId]?.all() || []
  res.json({ total: messages.length, messages })
})

// Send Message
app.post('/send', async (req, res) => {
  const { number, to, message } = req.body
  if (!number || !to || !message) {
    return res.status(400).json({ error: 'number, to, message required' })
  }
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  if (accounts[number].status !== 'connected') {
    return res.status(400).json({ error: 'Account not connected' })
  }
  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`
    await accounts[number].sock.sendMessage(jid, { text: message })
    res.json({ success: true, message: 'Sent ✅' })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// Delete Message
app.delete('/message/delete', async (req, res) => {
  const { number, chatId, messageId, fromMe } = req.body
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
    await accounts[number].sock.sendMessage(jid, {
      delete: { remoteJid: jid, fromMe: fromMe || true, id: messageId }
    })
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// Read Message
app.post('/message/read', async (req, res) => {
  const { number, chatId, messageId } = req.body
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
    await accounts[number].sock.readMessages([{ remoteJid: jid, id: messageId }])
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// Archive Chat
app.post('/chat/archive', async (req, res) => {
  const { number, chatId } = req.body
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
    await accounts[number].sock.chatModify({ archive: true }, jid)
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// Get Contacts
app.get('/contacts/:number', (req, res) => {
  const { number } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  const contacts = Object.values(accounts[number].store.contacts)
  res.json({ total: contacts.length, contacts })
})

// Block Contact
app.post('/contact/block', async (req, res) => {
  const { number, contactId } = req.body
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const jid = contactId.includes('@') ? contactId : `${contactId}@s.whatsapp.net`
    await accounts[number].sock.updateBlockStatus(jid, 'block')
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// Unblock Contact
app.post('/contact/unblock', async (req, res) => {
  const { number, contactId } = req.body
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const jid = contactId.includes('@') ? contactId : `${contactId}@s.whatsapp.net`
    await accounts[number].sock.updateBlockStatus(jid, 'unblock')
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// Typing Indicator
app.post('/typing', async (req, res) => {
  const { number, chatId, isTyping } = req.body
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
    await accounts[number].sock.sendPresenceUpdate(
      isTyping ? 'composing' : 'paused', jid
    )
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// Group Info
app.get('/group/:number/:groupId', async (req, res) => {
  const { number, groupId } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const metadata = await accounts[number].sock.groupMetadata(groupId)
    res.json({ group: metadata })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// ✅ Server Start + Auto Load
const PORT = process.env.PORT || 10000
app.listen(PORT, async () => {
  console.log(`Server চালু ✅ Port: ${PORT}`)
  await autoLoad()
})
