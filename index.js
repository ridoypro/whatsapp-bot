const { default: makeWASocket, 
        useMultiFileAuthState } = require('@whiskeysockets/baileys')
const pino = require('pino')

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  })

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    
    if (connection === 'connecting') {
      console.log('Connecting...')
      
      // Connection এর জন্য একটু অপেক্ষা করো
      await new Promise(r => setTimeout(r, 3000))
      
      if (!sock.authState.creds.registered) {
        try {
          const number = process.env.PHONE_NUMBER
          const code = await sock.requestPairingCode(number)
          console.log('============================')
          console.log('তোমার Pairing Code: ' + code)
          console.log('============================')
        } catch(e) {
          console.log('Code error:', e.message)
        }
      }
    }

    if (connection === 'open') {
      console.log('WhatsApp Connected! ✅')
    }

    if (connection === 'close') {
      console.log('Disconnected! Reconnecting...')
      startBot()
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
