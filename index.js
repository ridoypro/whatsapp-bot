const { default: makeWASocket, 
        useMultiFileAuthState,
        fetchLatestBaileysVersion,
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
    messages: {},
    chats: [],
    contacts: []
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'connecting') {
      await new Promise(r => setTimeout(r, 3000))
      if (!sock.authState.creds.registered) {
        try {
          const code = await sock.requestPairingCode(number)
          accounts[number].pairingCode = code
          console.log(`[${number}] Pairing Code: ${code}`)
        } catch(e) {
          console.log(`[${number}] Code Error:`, e.message)
        }
      }
    }

    if (connection === 'open') {
      accounts[number].status = 'connected'
      accounts[number].pairingCode = null
      console.log(`[${number}] Connected ✅`)
    }

    if (connection === 'close') {
      accounts[number].status = 'disconnected'
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode 
        !== DisconnectReason.loggedOut
      if (shouldReconnect) {
        console.log(`[${number}] Reconnecting...`)
        setTimeout(() => createAccount(number), 5000)
      } else {
        delete accounts[number]
        console.log(`[${number}] Logged out`)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)

  // ✅ Messages Store
  sock.ev.on('messages.upsert', ({ messages }) => {
    messages.forEach(msg => {
      const chatId = msg.key.remoteJid
      if (!accounts[number].messages[chatId]) {
        accounts[number].messages[chatId] = []
      }
      accounts[number].messages[chatId].push({
        id: msg.key.id,
        from: msg.key.fromMe ? 'me' : chatId,
        text: msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || '',
        time: msg.messageTimestamp,
        fromMe: msg.key.fromMe
      })
    })
  })

  // ✅ Chats Store
  sock.ev.on('chats.set', ({ chats }) => {
    accounts[number].chats = chats.map(c => ({
      id: c.id,
      name: c.name,
      unreadCount: c.unreadCount,
      lastMessage: c.messages?.[0]
    }))
  })

  // ✅ Contacts Store
  sock.ev.on('contacts.set', ({ contacts }) => {
    accounts[number].contacts = contacts.map(c => ({
      id: c.id,
      name: c.name || c.notify || c.id
    }))
  })

  return { success: true, message: 'Account creating, check pairing code' }
}

// =============================
// ✅ API ROUTES
// =============================

// 🏠 Home
app.get('/', (req, res) => {
  res.json({ 
    message: 'WhatsApp API Running ✅',
    totalAccounts: Object.keys(accounts).length
  })
})

// ➕ Account Add
app.post('/account/add', async (req, res) => {
  const { number } = req.body
  if (!number) return res.status(400).json({ error: 'Number required' })
  
  const result = await createAccount(number)
  res.json(result)
})

// ❌ Account Remove
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

// 📋 All Accounts
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

// 🔍 Account Status
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

// 💬 Get Chats
app.get('/chats/:number', (req, res) => {
  const { number } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  res.json({ chats: accounts[number].chats })
})

// 📨 Get Messages
app.get('/messages/:number/:chatId', (req, res) => {
  const { number, chatId } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  const messages = accounts[number].messages[chatId] || []
  res.json({ messages })
})

// 📤 Send Message
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

// 🗑️ Delete Message
app.delete('/message/delete', async (req, res) => {
  const { number, chatId, messageId, fromMe } = req.body
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  
  try {
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
    await accounts[number].sock.sendMessage(jid, {
      delete: {
        remoteJid: jid,
        fromMe: fromMe || true,
        id: messageId
      }
    })
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// 👁️ Read Message (Seen)
app.post('/message/read', async (req, res) => {
  const { number, chatId, messageId } = req.body
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  
  try {
    const jid = chatId.includes('@') ? chatId : `${chatId}@s.whatsapp.net`
    await accounts[number].sock.readMessages([{
      remoteJid: jid,
      id: messageId
    }])
    res.json({ success: true })
  } catch(e) {
    res.status(500).json({ error: e.message })
  }
})

// 📦 Archive Chat
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

// 👥 Get Contacts
app.get('/contacts/:number', (req, res) => {
  const { number } = req.params
  if (!accounts[number]) {
    return res.status(404).json({ error: 'Account not found' })
  }
  res.json({ contacts: accounts[number].contacts })
})

// 🚫 Block Contact
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

// ✅ Unblock Contact
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

// ⌨️ Typing Indicator
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

// 👨‍👦‍👦 Group Info
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
app.listen(PORT, () => {
  console.log(`WhatsApp API Server চালু ✅ Port: ${PORT}`)
})
