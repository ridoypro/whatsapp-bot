const { default: makeWASocket, 
        useMultiFileAuthState,
        makeCacheableSignalKeyStore } = require('@whiskeysockets/baileys')
const pino = require('pino')

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  })

  if (!sock.authState.creds.registered) {
    const number = process.env.PHONE_NUMBER
    const code = await sock.requestPairingCode(number)
    console.log('তোমার Pairing Code: ' + code)
  }

  sock.ev.on('connection.update', ({ connection }) => {
    if (connection === 'open') {
      console.log('WhatsApp Connected! ✅')
    }
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg.message || msg.key.fromMe) return

    const text = msg.message.conversation || 
                 msg.message.extendedTextMessage?.text || ''
    const from = msg.key.remoteJid

    if (text.toLowerCase() === 'হ্যালো') {
      await sock.sendMessage(from, { 
        text: 'হ্যালো! আমি Bot 🤖' 
      })
    } else {
      await sock.sendMessage(from, { 
        text: 'Message পেয়েছি ✅' 
      })
    }
  })
}

startBot()
