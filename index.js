const { default: makeWASocket, 
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
        DisconnectReason } = require('@whiskeysockets/baileys')
const express = require('express')
const pino = require('pino')
const fs = require('fs')

const app = express()
app.use(express.json())

// ✅ API Key
const API_KEY = process.env.API_KEY || 'your-secret-key'

function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key']
  if (!key || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  next()
}
app.use(authMiddleware)

// ✅ Telegram Config
let telegramConfig = {
  token: process.env.TELEGRAM_TOKEN || null,
  chatId: process.env.TELEGRAM_CHAT_ID || null
}

// ✅ Telegram Send
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
        parse_mode: 'HTML'
      })
    })
    const data = await res.json()
    if (!data.ok) console.log('Telegram Error:', data)
  } catch(e) {
    console.log('Telegram Error:', e.message)
  }
}

// ✅ Accounts Store
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

  accounts[number] = {
    sock,
    status: 'connecting',
    pairingCode: null,
    chats: [],
    contacts: [],
    messages: {}
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'connecting') {
      await new Promise(r => setTimeout(r, 3000))
      if (!sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(number)
          accounts[number].pairingCode = code
          console.log(`[${number}] Pairing Code: ${code}`)
          await sendToTelegram(
            `🔑 <b>Pairing Code</b>\n` +
            `📱 Number: <code>${number}</code>\n` +
            `🔐 Code: <code>${code}</code>`
          )
        } catch(e) {
          console.log(`[${number}] Code Error:`, e.message)
        }
      }
    }

    if (connection === 'open') {
      accounts[number].status = 'connected'
      accounts[number].pairingCode = null
      console.log(`[${number}] Connected ✅`)
      await sendToTelegram(
        `✅ <b>WhatsApp Connected!</b>\n` +
        `📱 Number: <code>${number}</code>`
      )
    }

    if (connection === 'close') {
      accounts[number].status = 'disconnected'
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut
      
      if (shouldReconnect) {
        console.log(`[${number}] Reconnecting...`)
        delete accounts[number]
        setTimeout(() => createAccount(number), 5000)
      } else {
        delete accounts[number]
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
    accounts[number].chats = chats.map(c => ({
      id: c.id,
      name: c.name || c.id,
      unreadCount: c.unreadCount || 0,
      timestamp: c.conversationTimestamp
    }))
  })

  sock.ev.on('chats.upsert', (chats) => {
    chats.forEach(c => {
      const existing = accounts[number].chats.findIndex(x => x.id === c.id)
      const chat = {
        id: c.id,
        name: c.name || c.id,
        unreadCount: c.unreadCount || 0,
        timestamp: c.conversationTimestamp
      }
      if (existing >= 0) {
        accounts[number].chats[existing] = chat
      } else {
        accounts[number].chats.push(chat)
      }
    })
  })

  // ✅ Contacts Store
  sock.ev.on('contacts.set', ({ contacts }) => {
    accounts[number].contacts = contacts.map(c => ({
      id: c.id,
      name: c.name || c.notify || c.id.split('@')[0]
    }))
  })

  sock.ev.on('contacts.upsert', (contacts) => {
    contacts.forEach(c => {
      const existing = accounts[number].contacts.findIndex(x => x.id === c.id)
      const contact = {
        id: c.id,
        name: c.name || c.notify || c.id.split('@')[0]
      }
      if (existing >= 0) {
        accounts[number].contacts[existing] = contact
      } else {
        accounts[number].contacts.push(contact)
      }
    })
  })

  // ✅ Messages Store + Telegram Forward
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    for (const msg of messages) {
      if (!msg.message) continue

      const chatId = msg.key.remoteJid
      if (!accounts[number].messages[chatId]) {
        accounts[number].messages[chatId] = []
      }

      const text = msg.message?.conversation || 
                   msg.message?.extendedTextMessage?.text ||
                   msg.message?.imageMessage?.caption ||
                   '[Media/Other]'

      const msgData = {
        id: msg.key.id,
        fromMe: msg.key.fromMe,
        sender: msg.pushName || chatId.split('@')[0],
        text,
        time: msg.messageTimestamp,
        chatId
      }

      accounts[number].messages[chatId].push(msgData)

      // শুধু incoming message Telegram এ পাঠাও
      if (!msg.key.fromMe && type === 'notify') {
        const isGroup = chatId.endsWith('@g.us')
        await sendToTelegram(
          `📨 <b>New Message</b>\n` +
          `📱 Account: <code>${number}</code>\n` +
          `👤 From: ${msgData.sender}\n` +
          `💬 Type: ${isGroup ? 'Group' : 'Personal'}\n` +
          `🆔 ChatID: <code>${chatId}</code>\n` +
          `📝 Text: ${text}\n` +
          `⏰ ${new Date(msg.messageTimestamp * 1000).toLocaleString()}`
        )
      }
    }
  })

  return { success: true, message: 'Account creating, check pairing code' }
}

// ✅ Auto Load
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
// ✅ ROUTES
// =============================

// 🏠 Home
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

app.delete('/account/remove/:number', (req, res) => {
  const { number } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    accounts[number].sock.logout()
  } catch(e) {}
  delete accounts[number]
  const authDir = `./auth/${number}`
  if (fs.existsSync(authDir)) {
    fs.rmSync(authDir, { recursive: true })
  }
  res.json({ success: true, message: `${number} removed ✅` })
})

app.get('/accounts', (req, res) => {
  const list = Object.keys(accounts).map(number => ({
    number,
    status: accounts[number].status,
    pairingCode: accounts[number].pairingCode,
    totalChats: accounts[number].chats.length,
    totalContacts: accounts[number].contacts.length
  }))
  res.json({ total: list.length, accounts: list })
})

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
// ✅ CHAT ROUTES
// =============================

app.get('/chats/:number', (req, res) => {
  const { number } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  res.json({ 
    total: accounts[number].chats.length,
    chats: accounts[number].chats 
  })
})

app.get('/messages/:number/:chatId', (req, res) => {
  const { number, chatId } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  const messages = accounts[number].messages[chatId] || []
  res.json({ total: messages.length, messages })
})

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

app.delete('/message/delete', async (req, res) => {
  const { number, chatId, messageId, fromMe } = req.body
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  try {
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
    await accounts[number].sock.sendMessage(jid, {
      delete: { remoteJid: jid, fromMe: fromMe ?? true, id: messageId }
    })
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

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

// =============================
// ✅ CONTACT ROUTES
// =============================

app.get('/contacts/:number', (req, res) => {
  const { number } = req.params
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

// =============================
// ✅ EXTRA ROUTES
// =============================

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

// ✅ Server Start
const PORT = process.env.PORT || 10000
app.listen(PORT, async () => {
  console.log(`Server চালু ✅ Port: ${PORT}`)
  await autoLoad()
})
