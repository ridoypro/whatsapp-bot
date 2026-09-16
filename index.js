const { default: makeWASocket, 
        useMultiFileAuthState, 
        DisconnectReason } = require('@whiskeysockets/baileys')
const pino = require('pino')
const qrcode = require('qrcode-terminal')

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth')
  
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' })
  })

  sock.ev.on('connection.update', ({ connection, qr }) => {
    if (qr) {
      qrcode.generate(qr, { small: true })
      console.log('QR Code উপরে দেখো, Phone দিয়ে Scan করো!')
    }
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

    console.log('Message আসছে:', text)

    // Auto Reply Rules 👇
    if (text.toLowerCase() === 'হ্যালো') {
      await sock.sendMessage(from, { 
        text: 'হ্যালো! আমি একটি Bot 🤖 কীভাবে সাহায্য করবো?' 
      })
    }

    else if (text.toLowerCase() === 'price') {
      await sock.sendMessage(from, { 
        text: 'আমাদের Price List:\n- Product 1: ৳500\n- Product 2: ৳1000' 
      })
    }

    else {
      await sock.sendMessage(from, { 
        text: 'আপনার message পেয়েছি! শীঘ্রই reply করা হবে ✅' 
      })
    }
  })
}

startBot()
