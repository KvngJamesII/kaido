const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Presence,
  downloadMediaMessage,
  downloadContentFromMessage,
} = require("@whiskeysockets/baileys");
const readline = require("readline");
const pino = require("pino");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const logger = pino({
  level: "info",
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname'
    }
  }
});

const adminSettings = {};
const stickerCommands = {};
const lockedGroups = new Set();
const userWarns = {};
const blockedUsers = {};
let BOT_OWNER = "2347020593904"; // Can be changed dynamically

let botMode = "private";

const isOwnerNumber = (senderJid) => {
  if (!senderJid) {
    logger.debug('isOwnerNumber: senderJid is null/undefined');
    return false;
  }

  // Strip JID to just the number, removing any :X suffixes and @lid/@s.whatsapp.net
  let senderNumber = senderJid.split("@")[0];
  senderNumber = senderNumber.split(":")[0]; // Remove :8 or other suffixes

  // Log all checks for debugging
  logger.info({
    senderJid,
    senderNumber,
    BOT_OWNER,
    exactMatch: senderNumber === BOT_OWNER,
    includesMatch: senderJid.includes(BOT_OWNER),
  }, 'Owner check details');

  // Check if the sender number matches the owner
  // Also check if sender contains the owner number (for LID format)
  const isOwner = senderNumber === BOT_OWNER || senderJid.includes(BOT_OWNER);
  logger.info({ isOwner }, 'Owner check result');

  return isOwner;
};

const normalizeJid = (jid) => {
  if (!jid) return jid;
  const number = jid.split("@")[0];
  return `${number}@s.whatsapp.net`;
};

const isLinkMessage = (text) => {
  if (!text) return false;
  const linkPatterns = [
    /https?:\/\/[^\s]+/i,
    /www\.[^\s]+/i,
    /chat\.whatsapp\.com\/[^\s]+/i,
    /wa\.me\/[^\s]+/i,
    /t\.me\/[^\s]+/i,
    /discord\.gg\/[^\s]+/i,
    /bit\.ly\/[^\s]+/i,
    /tinyurl\.com\/[^\s]+/i
  ];
  return linkPatterns.some(pattern => pattern.test(text));
};

const fetchCryptoPrice = async (symbol) => {
  try {
    const upperSymbol = symbol.toUpperCase();

    // Map common symbols to CoinGecko IDs
    const symbolMap = {
      'BTC': 'bitcoin',
      'ETH': 'ethereum',
      'SOL': 'solana',
      'DOGE': 'dogecoin',
      'ADA': 'cardano',
      'DOT': 'polkadot',
      'MATIC': 'matic-network',
      'LINK': 'chainlink',
      'XRP': 'ripple',
      'BNB': 'binancecoin',
      'AVAX': 'avalanche-2',
      'UNI': 'uniswap',
      'LTC': 'litecoin',
      'ATOM': 'cosmos',
      'NEAR': 'near',
      'FTM': 'fantom',
      'ALGO': 'algorand',
      'VET': 'vechain',
      'ICP': 'internet-computer',
      'APT': 'aptos',
      'ARB': 'arbitrum',
      'OP': 'optimism',
      'PEPE': 'pepe',
      'SHIB': 'shiba-inu',
      'COAI': 'coai',
      'TON': 'toncoin'
    };

    const coinId = symbolMap[upperSymbol] || upperSymbol.toLowerCase();

    // Fetch from CoinGecko
    const coingeckoUrl = `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`;
    logger.info({ url: coingeckoUrl, coinId }, 'Trying CoinGecko API');
    let response = await fetch(coingeckoUrl);
    logger.info({ status: response.status, ok: response.ok }, 'CoinGecko API response status');

    if (response.ok) {
      const data = await response.json();
      logger.info({ fullData: data }, 'CoinGecko full API response');
      const cryptoData = data[coinId];
      if (cryptoData) {
        logger.info({ cryptoData }, 'CoinGecko parsed data');
        return {
          symbol: upperSymbol,
          lastPrice: cryptoData.usd,
          priceChangePercent: cryptoData.usd_24h_change || 0,
          volume: 0, // CoinGecko simple price doesn't provide volume directly
          marketCap: cryptoData.usd_market_cap || 0,
        };
      } else {
        logger.warn({ coinId, availableKeys: Object.keys(data) }, 'Coin ID not found in response');
      }
    } else {
      const errorText = await response.text();
      logger.warn({ status: response.status, error: errorText }, 'CoinGecko API failed');
    }

    logger.error({ symbol: upperSymbol, coinId }, 'No API returned valid data');
    return null;
  } catch (error) {
    logger.error({ error: error.message, stack: error.stack }, 'Crypto fetch error');
    return null;
  }
};


const extractViewOnceMedia = async (quoted) => {
  let viewOnceMsg = null;

  if (quoted?.viewOnceMessage) {
    viewOnceMsg = quoted.viewOnceMessage.message || quoted.viewOnceMessage;
  } else if (quoted?.viewOnceMessageV2) {
    viewOnceMsg = quoted.viewOnceMessageV2.message;
  } else if (quoted?.viewOnceMessageV2Extension) {
    viewOnceMsg = quoted.viewOnceMessageV2Extension.message;
  }

  if (!viewOnceMsg && quoted?.imageMessage) {
    viewOnceMsg = { imageMessage: quoted.imageMessage };
  } else if (!viewOnceMsg && quoted?.videoMessage) {
    viewOnceMsg = { videoMessage: quoted.videoMessage };
  }

  return viewOnceMsg;
};

const downloadViewOnceMedia = async (viewOnceMsg) => {
  const imageMsg = viewOnceMsg?.imageMessage;
  const videoMsg = viewOnceMsg?.videoMessage;

  if (!imageMsg && !videoMsg) return null;

  let mediaData = null;
  let mediaType = null;
  let caption = "";

  try {
    if (imageMsg) {
      const stream = await downloadContentFromMessage(imageMsg, 'image');
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }
      mediaData = buffer;
      mediaType = "image";
      caption = imageMsg.caption || "";
    } else if (videoMsg) {
      const stream = await downloadContentFromMessage(videoMsg, 'video');
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }
      mediaData = buffer;
      mediaType = "video";
      caption = videoMsg.caption || "";
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Download view-once error');
    return null;
  }

  return { mediaData, mediaType, caption };
};

const convertToSticker = async (imageBuffer) => {
  try {
    const stickerBuffer = await sharp(imageBuffer)
      .resize(512, 512, {
        fit: 'contain',
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      })
      .webp({ lossless: true })
      .toBuffer();
    return stickerBuffer;
  } catch (err) {
    logger.error({ error: err.message }, 'Sticker conversion error');
    return null;
  }
};

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const askQuestion = (question) => {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer);
    });
  });
};

const getMenu = () => `
╔══════════════════════════════════════╗
║  ⚔️⚔️⚔️  KAIDO BOT  ⚔️⚔️⚔️           ║
║   *Built by James The Goat*         ║
╚══════════════════════════════════════╝

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
👥  GROUP MANAGEMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔒 .lock ····· Lock group
🔓 .open ····· Unlock group
👢 .kick ····· Kick user (reply)
⚠️  .warn ····· Warn user (2 = kick)
⬆️  .promote ··· Make admin (reply)
⬇️  .demote ··· Remove admin (reply)
🚫 .block ····· Block user (reply)
✅ .unblock ··· Unblock user

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📢  CHAT MANAGEMENT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔗 .antilink on/off ··· Link filter
📢 .tagall ····· Tag all (visible)
👻 .hidetag ··· Tag all (hidden)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🎨  STICKER COMMANDS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🖼️  .sticker ··· Convert image to sticker
🎪 .setsticker · Set custom sticker cmd

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🛠️  UTILITY TOOLS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

👁️  .vv ······· Save view-once (reply)
👤 .get pp ···· Get profile pic (reply)
📊 .ping ····· Bot status
🔗 .join ····· Join group (link)
🗑️  .delete ···· Delete message (reply)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📈  CRYPTO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

💹 .live [coin] ··· Live crypto price
   Example: .live btc, .live eth

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚙️  BOT SETTINGS (Owner Only)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔓 .public ····· Allow others to use bot
🔐 .private ···· Only owner can use bot
📋 .menu ····· Show this menu
ℹ️  .help ····· Bot information

╔══════════════════════════════════════╗
║  ⚠️  USE RESPONSIBLY  ⚠️             ║
║  Mode: ${botMode.toUpperCase().padEnd(8)} ║
╚══════════════════════════════════════╝
`;

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  const socketLogger = pino({ 
    level: process.env.DEBUG_BAILEYS === 'true' ? 'debug' : 'warn',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  });

  const sock = makeWASocket({
    auth: state,
    logger: socketLogger,
    printQRInTerminal: false,
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.clear();
      console.log("╔════════════════════════════════╗");
      console.log("║   📱 Enter Phone Number 📱    ║");
      console.log("╚════════════════════════════════╝\n");

      const phoneNumber = await askQuestion(
        "Enter your phone number (with country code, e.g., 1234567890): "
      );
      try {
        const code = await sock.requestPairingCode(phoneNumber);
        console.log(`\n✅ Your pairing code: ${code}\n📌 Enter this in WhatsApp to connect`);
      } catch (err) {
        logger.error({ error: err.message }, 'Pairing code error');
      }
    }

    if (connection === "open") {
      console.clear();
      console.log("╔════════════════════════════════╗");
      console.log("║   ✅ Connected Successfully!   ║");
      console.log("╚════════════════════════════════╝\n");
      logger.info('Bot connected and running');

      const myJid = sock.user.id;
      await sock.sendMessage(myJid, {
        text: `✅ *CONNECTION SUCCESSFUL*

🤖 KAIDO Bot is online!
Built by: Everybody Hates James

━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 *Quick Start:*
.menu - View all commands
.help - Bot information
.ping - Check status
.public/.private - Toggle mode

━━━━━━━━━━━━━━━━━━━━━━━━━━

Current Mode: ${botMode.toUpperCase()}
Ready to manage! 🚀`,
      });
    }

    if (connection === "close") {
      if (
        lastDisconnect?.error?.output?.statusCode ===
        DisconnectReason.loggedOut
      ) {
        logger.error('Device logged out. Delete auth_info folder to reconnect.');
        process.exit(0);
      }
      logger.info('Connection closed, reconnecting...');
      setTimeout(() => startBot(), 3000);
    }
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("messages.upsert", async (m) => {
    try {
      const message = m.messages[0];
      if (!message.message) return;

      const isGroup = message.key.remoteJid.endsWith("@g.us");
      const isDM = !isGroup;
      let sender = message.key.participant || message.key.remoteJid;
      const myJid = sock.user.id;
      const isSender = sender === myJid;

      let text = "";
      if (message.message.conversation)
        text = message.message.conversation;
      else if (message.message.extendedTextMessage)
        text = message.message.extendedTextMessage.text;

      // Debug logging for message context
      logger.info({
        isGroup,
        isDM,
        sender,
        remoteJid: message.key.remoteJid,
        fromMe: message.key.fromMe,
        myJid,
        BOT_OWNER,
      }, 'Message context');

      // Determine if this is the owner
      let isOwner = false;

      if (isDM) {
        // In self-DM (fromMe: true), the sender is a LID, but it's still the owner
        // Check if this is your own number or LID
        const isSelfDM = message.key.fromMe || 
                         message.key.remoteJid.includes(BOT_OWNER) ||
                         sender.includes(BOT_OWNER);

        if (isSelfDM) {
          isOwner = true;
          logger.info('Detected as owner (self-DM or owner number match)');
        } else {
          isOwner = isOwnerNumber(sender);
        }
      } else {
        // In groups, use standard owner check
        isOwner = isOwnerNumber(sender);
      }

      logger.info({ isOwner, isDM, isGroup }, 'Final owner determination');

      const fullCommand = text?.toLowerCase().trim().split(" ")[0];
      const command = fullCommand?.startsWith(".") ? fullCommand.slice(1) : fullCommand;
      const args = text?.trim().split(" ").slice(1);

      if (text && text.startsWith(".")) {
        logger.info({
          command,
          sender,
          isOwner,
          isDM,
          isGroup,
          botMode,
          remoteJid: message.key.remoteJid,
          fromMe: message.key.fromMe,
        }, 'Command detected');
      }

      if (isGroup) {
        const groupMetadata = await sock.groupMetadata(message.key.remoteJid);
        const isAdmin = groupMetadata.participants.some(
          (p) =>
            p.id === sender &&
            (p.admin === "admin" || p.admin === "superadmin")
        );

        const botIsAdmin = groupMetadata.participants.some(
          (p) =>
            normalizeJid(p.id) === normalizeJid(myJid) &&
            (p.admin === "admin" || p.admin === "superadmin")
        );

        const settings = adminSettings[message.key.remoteJid];
        if (settings?.antilink && !isAdmin && !isOwner && !message.key.fromMe) {
          if (isLinkMessage(text)) {
            logger.info({ sender, group: message.key.remoteJid }, 'Link detected - taking action');

            try {
              await sock.sendMessage(message.key.remoteJid, {
                delete: message.key
              });
              logger.info('Link message deleted');
            } catch (err) {
              logger.error({ error: err.message }, 'Failed to delete link message');
            }

            if (botIsAdmin) {
              try {
                await sock.groupParticipantsUpdate(
                  message.key.remoteJid,
                  [sender],
                  "remove"
                );

                const userNumber = sender.split("@")[0];
                await sock.sendMessage(message.key.remoteJid, {
                  text: `🚫 *@${userNumber} kicked for sending link*`,
                  mentions: [sender]
                });
                logger.info({ sender }, 'User kicked for sending link');
              } catch (err) {
                logger.error({ error: err.message }, 'Failed to kick user');
              }
            }
            return;
          }
        }

        const canUseBot = isOwner || (botMode === "public");

        if (command === "menu") {
          try {
            const menuImage = fs.readFileSync("./images/menu-image.jpg");
            await sock.sendMessage(message.key.remoteJid, {
              image: menuImage,
              caption: getMenu(),
            });
          } catch (err) {
            await sock.sendMessage(message.key.remoteJid, {
              text: getMenu(),
            });
          }
          return;
        }

        if (command === "ping") {
          const now = Date.now();
          await sock.sendMessage(message.key.remoteJid, {
            text: `📊 *PONG!*\n✅ Bot is online and responding\n⚡ Latency: ${Date.now() - now}ms\n🔧 Mode: ${botMode.toUpperCase()}`,
          });
          return;
        }

        if (command === "live") {
          const symbol = args[0];
          if (!symbol) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Usage: .live [symbol]\n\nExamples:\n.live btc\n.live eth\n.live sol\n.live coai",
            });
            return;
          }

          await sock.sendMessage(message.key.remoteJid, {
            react: { text: "⏳", key: message.key },
          });

          const data = await fetchCryptoPrice(symbol);

          if (!data) {
            const upperSym = symbol.toUpperCase();

            await sock.sendMessage(message.key.remoteJid, {
              text: `❌ Could not find data for *${upperSym}*

💡 *Tips:*
• Check if the symbol is correct
• The coin might not be listed on CoinGecko
• Try popular coins like: BTC, ETH, SOL, TON, BNB, ADA, XRP, DOGE, MATIC, DOT

🔍 *How to add new coins:*
If you know the CoinGecko ID for ${upperSym}, contact the bot owner to add it.

Example: Search "coingecko ${upperSym}" to find the correct ID.`,
            });
            return;
          }

          const price = parseFloat(data.lastPrice).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 8
          });
          const change24h = parseFloat(data.priceChangePercent).toFixed(2);
          const volume = parseFloat(data.volume).toLocaleString('en-US', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
          });
          const marketCap = parseFloat(data.marketCap).toLocaleString('en-US', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
          });
          const changeEmoji = change24h >= 0 ? "📈" : "📉";
          const changeSign = change24h >= 0 ? "+" : "";

          await sock.sendMessage(message.key.remoteJid, {
            text: `💹 *${data.symbol}* Live Price

💰 *Price:* $${price}
${changeEmoji} *24h Change:* ${changeSign}${change24h}%

📊 *24h Stats:*
📦 Volume: $${volume}
💎 Market Cap: $${marketCap}

⏰ Updated: ${new Date().toLocaleTimeString()}
📡 Source: CoinGecko`,
          });

          await sock.sendMessage(message.key.remoteJid, {
            react: { text: "✅", key: message.key },
          });
          return;
        }

        if (command === "public") {
          if (!isOwner) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Only the bot owner can change bot mode!",
            });
            return;
          }
          botMode = "public";
          await sock.sendMessage(message.key.remoteJid, {
            text: "✅ Bot is now *PUBLIC*\n\nAll users can now use bot commands!",
          });
          logger.info('Bot mode changed to PUBLIC');
          return;
        }

        if (command === "private") {
          if (!isOwner) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Only the bot owner can change bot mode!",
            });
            return;
          }
          botMode = "private";
          await sock.sendMessage(message.key.remoteJid, {
            text: "🔐 Bot is now *PRIVATE*\n\nOnly the owner can use bot commands!",
          });
          logger.info('Bot mode changed to PRIVATE');
          return;
        }

        if (command === "tagall" && canUseBot) {
          let mentions = [];
          let tagText = "👥 *Group Members:*\n\n";

          for (let member of groupMetadata.participants) {
            mentions.push(member.id);
            tagText += `@${member.id.split("@")[0]}\n`;
          }

          await sock.sendMessage(
            message.key.remoteJid,
            { text: tagText, mentions },
            { quoted: message }
          );
          return;
        }

        if (command === "hidetag" && canUseBot) {
          try {
            let mentions = [];
            for (let member of groupMetadata.participants) {
              mentions.push(member.id);
            }

            await sock.sendMessage(message.key.remoteJid, {
              text: ".",
              mentions,
            });

            await sock.sendMessage(message.key.remoteJid, {
              react: { text: "✅", key: message.key },
            });

            setTimeout(async () => {
              try {
                await sock.sendMessage(message.key.remoteJid, {
                  react: { text: "", key: message.key },
                });
              } catch (err) {
                logger.error({ error: err.message }, 'Error removing reaction');
              }
            }, 5000);
          } catch (err) {
            logger.error({ error: err.message }, 'Hidetag error');
          }
          return;
        }

        if (!canUseBot && text && text.startsWith(".")) {
          return;
        }

        if (command === "setsticker" && canUseBot) {
          const cmdName = args[0]?.toLowerCase();
          const sticker = message.message.extendedTextMessage?.contextInfo
            ?.quotedMessage?.stickerMessage;

          if (!sticker || !cmdName) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Reply to a sticker with *.setsticker [command]*\n\nSupported: kick, open, lock, vv, hidetag, pp, sticker",
            });
            return;
          }

          if (!["kick", "open", "lock", "vv", "hidetag", "pp", "sticker"].includes(cmdName)) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Supported commands: kick, open, lock, vv, hidetag, pp, sticker",
            });
            return;
          }

          if (cmdName === "sticker") {
            stickerCommands[cmdName] = { type: "sticker_converter", hash: sticker.fileSha256?.toString('base64') };
            await sock.sendMessage(message.key.remoteJid, {
              text: `✅ Sticker set to *STICKER CONVERTER*!\n\nNow reply with this sticker to an image to convert it to a sticker!`,
            });
            return;
          }

          const stickerHash = sticker.fileSha256?.toString('base64');
          stickerCommands[cmdName] = stickerHash || true;

          let successMsg = `✅ Sticker set to *${cmdName.toUpperCase()}*!`;
          await sock.sendMessage(message.key.remoteJid, { text: successMsg });
          logger.info({ command: cmdName }, 'Sticker command set');
          return;
        }

        if (command === "sticker" && canUseBot) {
          try {
            const quoted = message.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Reply to an image with *.sticker*",
              });
              return;
            }

            const imageMsg = quoted?.imageMessage;
            if (!imageMsg) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Reply to an image only!",
              });
              return;
            }

            await sock.sendMessage(message.key.remoteJid, {
              react: { text: "⏳", key: message.key },
            });

            const stream = await downloadContentFromMessage(imageMsg, 'image');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
              buffer = Buffer.concat([buffer, chunk]);
            }

            const stickerBuffer = await convertToSticker(buffer);
            if (!stickerBuffer) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Failed to convert image to sticker",
              });
              return;
            }

            await sock.sendMessage(message.key.remoteJid, {
              sticker: stickerBuffer,
            });

            await sock.sendMessage(message.key.remoteJid, {
              react: { text: "✅", key: message.key },
            });
            logger.info('Sticker created successfully');
          } catch (err) {
            logger.error({ error: err.message, stack: err.stack }, 'Sticker error');
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Failed to create sticker: " + err.message,
            });
          }
          return;
        }

        if (command === "vv" && canUseBot) {
          try {
            const quoted = message.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Reply to a view-once photo or video with *.vv*",
              });
              return;
            }

            const viewOnceMsg = await extractViewOnceMedia(quoted);
            if (!viewOnceMsg) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ That message is not a view-once photo or video.",
              });
              return;
            }

            const media = await downloadViewOnceMedia(viewOnceMsg);
            if (!media) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Failed to download media",
              });
              return;
            }

            const ownerJid = BOT_OWNER + "@s.whatsapp.net";
            if (media.mediaType === "image") {
              await sock.sendMessage(ownerJid, {
                image: media.mediaData,
                caption: media.caption || "View-once photo saved",
              });
            } else if (media.mediaType === "video") {
              await sock.sendMessage(ownerJid, {
                video: media.mediaData,
                caption: media.caption || "View-once video saved",
              });
            }

            await sock.sendMessage(message.key.remoteJid, {
              react: { text: "✅", key: message.key },
            });
            logger.info('View-once media saved');
          } catch (err) {
            logger.error({ error: err.message, stack: err.stack }, 'VV error');
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Failed to save view-once media: " + err.message,
            });
          }
          return;
        }

        if (message.message.stickerMessage && !text && canUseBot) {
          const stickerHash = message.message.stickerMessage.fileSha256?.toString('base64');

          for (const [cmdName, hash] of Object.entries(stickerCommands)) {
            if (hash === stickerHash || hash === true || (typeof hash === 'object' && hash.hash === stickerHash)) {
              logger.info({ command: cmdName }, 'Sticker command triggered');

              if (cmdName === "vv") {
                try {
                  const contextInfo = message.message.stickerMessage?.contextInfo;
                  if (!contextInfo || !contextInfo.quotedMessage) return;

                  const quoted = contextInfo.quotedMessage;
                  const viewOnceMsg = await extractViewOnceMedia(quoted);
                  if (!viewOnceMsg) return;

                  const media = await downloadViewOnceMedia(viewOnceMsg);
                  if (!media) return;

                  const ownerJid = BOT_OWNER + "@s.whatsapp.net";
                  if (media.mediaType === "image") {
                    await sock.sendMessage(ownerJid, {
                      image: media.mediaData,
                      caption: media.caption || "View-once photo saved (via sticker)",
                    });
                  } else if (media.mediaType === "video") {
                    await sock.sendMessage(ownerJid, {
                      video: media.mediaData,
                      caption: media.caption || "View-once video saved (via sticker)",
                    });
                  }

                  await sock.sendMessage(message.key.remoteJid, {
                    react: { text: "✅", key: message.key },
                  });

                  setTimeout(async () => {
                    try {
                      await sock.sendMessage(message.key.remoteJid, {
                        react: { text: "", key: message.key },
                      });
                    } catch (err) {}
                  }, 5000);
                } catch (err) {
                  logger.error({ error: err.message }, 'Sticker vv error');
                }
                return;
              } else if (cmdName === "hidetag") {
                try {
                  let mentions = [];
                  for (let member of groupMetadata.participants) {
                    mentions.push(member.id);
                  }

                  await sock.sendMessage(message.key.remoteJid, {
                    text: ".",
                    mentions,
                  });

                  await sock.sendMessage(message.key.remoteJid, {
                    react: { text: "✅", key: message.key },
                  });

                  setTimeout(async () => {
                    try {
                      await sock.sendMessage(message.key.remoteJid, {
                        react: { text: "", key: message.key },
                      });
                    } catch (err) {}
                  }, 5000);
                } catch (err) {
                  logger.error({ error: err.message }, 'Sticker hidetag error');
                }
                return;
              } else if (cmdName === "pp") {
                try {
                  const contextInfo = message.message.stickerMessage?.contextInfo;
                  if (!contextInfo || !contextInfo.participant) return;

                  let targetJid = normalizeJid(contextInfo.participant);
                  let ppUrl = null;

                  try {
                    ppUrl = await sock.profilePictureUrl(targetJid, "image");
                  } catch (err1) {
                    try {
                      ppUrl = await sock.profilePictureUrl(targetJid, "display");
                    } catch (err2) {}
                  }

                  if (ppUrl) {
                    await sock.sendMessage(message.key.remoteJid, {
                      image: { url: ppUrl },
                      caption: `Profile: @${targetJid.split("@")[0]}`,
                      mentions: [targetJid]
                    });
                  } else {
                    await sock.sendMessage(message.key.remoteJid, {
                      text: "❌ Profile picture is private or unavailable",
                    });
                  }
                } catch (err) {
                  logger.error({ error: err.message }, 'Sticker pp error');
                }
                return;
              } else if (cmdName === "sticker") {
                try {
                  const contextInfo = message.message.stickerMessage?.contextInfo;
                  if (!contextInfo?.quotedMessage?.imageMessage) return;

                  const imageMsg = contextInfo.quotedMessage.imageMessage;
                  const stream = await downloadContentFromMessage(imageMsg, 'image');
                  let buffer = Buffer.from([]);
                  for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                  }

                  const stickerBuffer = await convertToSticker(buffer);
                  if (stickerBuffer) {
                    await sock.sendMessage(message.key.remoteJid, {
                      sticker: stickerBuffer,
                    });
                  }
                } catch (err) {
                  logger.error({ error: err.message }, 'Sticker converter error');
                }
                return;
              } else if (isAdmin || isOwner) {
                if (cmdName === "kick") {
                  const contextInfo = message.message.stickerMessage?.contextInfo;
                  const targetJid = contextInfo?.participant;

                  if (targetJid && botIsAdmin) {
                    try {
                      await sock.groupParticipantsUpdate(message.key.remoteJid, [targetJid], "remove");
                      await sock.sendMessage(message.key.remoteJid, {
                        react: { text: "✅", key: message.key },
                      });
                    } catch (err) {
                      logger.error({ error: err.message }, 'Sticker kick error');
                    }
                  }
                  return;
                } else if (cmdName === "open") {
                  try {
                    lockedGroups.delete(message.key.remoteJid);
                    await sock.groupSettingUpdate(message.key.remoteJid, "not_announcement");
                    await sock.sendMessage(message.key.remoteJid, {
                      react: { text: "✅", key: message.key },
                    });
                  } catch (err) {
                    logger.error({ error: err.message }, 'Sticker open error');
                  }
                  return;
                } else if (cmdName === "lock") {
                  try {
                    lockedGroups.add(message.key.remoteJid);
                    await sock.groupSettingUpdate(message.key.remoteJid, "announcement");
                    await sock.sendMessage(message.key.remoteJid, {
                      react: { text: "✅", key: message.key },
                    });
                  } catch (err) {
                    logger.error({ error: err.message }, 'Sticker lock error');
                  }
                  return;
                }
              }
            }
          }
          return;
        }

        if (!isAdmin && !isOwner) return;

        if (command === "lock") {
          if (!botIsAdmin) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Bot needs to be admin to lock the group!",
            });
            return;
          }
          try {
            lockedGroups.add(message.key.remoteJid);
            await sock.groupSettingUpdate(message.key.remoteJid, "announcement");
            await sock.sendMessage(message.key.remoteJid, {
              react: { text: "✅", key: message.key },
            });
            logger.info({ group: message.key.remoteJid }, 'Group locked');
          } catch (err) {
            logger.error({ error: err.message }, 'Lock error');
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Failed to lock group: " + err.message,
            });
          }
          return;
        }

        if (command === "open") {
          if (!botIsAdmin) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Bot needs to be admin to open the group!",
            });
            return;
          }
          try {
            lockedGroups.delete(message.key.remoteJid);
            await sock.groupSettingUpdate(message.key.remoteJid, "not_announcement");
            await sock.sendMessage(message.key.remoteJid, {
              react: { text: "✅", key: message.key },
            });
            logger.info({ group: message.key.remoteJid }, 'Group opened');
          } catch (err) {
            logger.error({ error: err.message }, 'Open error');
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Failed to open group: " + err.message,
            });
          }
          return;
        }

        if (command === "get" && args[0]?.toLowerCase() === "pp") {
          const quoted = message.message.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Reply to a user's message to get their profile picture",
            });
            return;
          }

          let targetJid = message.message.extendedTextMessage?.contextInfo?.participant;
          if (!targetJid) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Could not identify the user",
            });
            return;
          }

          targetJid = normalizeJid(targetJid);

          try {
            let ppUrl = null;
            try {
              ppUrl = await sock.profilePictureUrl(targetJid, "image");
            } catch (err1) {
              try {
                ppUrl = await sock.profilePictureUrl(targetJid, "display");
              } catch (err2) {}
            }

            if (ppUrl) {
              await sock.sendMessage(message.key.remoteJid, {
                image: { url: ppUrl },
                caption: `Profile: @${targetJid.split("@")[0]}`,
                mentions: [targetJid]
              });
            } else {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Profile picture is private or unavailable",
              });
            }
          } catch (err) {
            logger.error({ error: err.message }, 'Get PP error');
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Error: " + err.message,
            });
          }
          return;
        }

        if (command === "kick") {
          if (!botIsAdmin) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Bot needs to be admin to kick users!",
            });
            return;
          }

          const quoted = message.message.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Reply to a message to kick that user",
            });
            return;
          }

          const targetJid = message.message.extendedTextMessage?.contextInfo?.participant;
          if (targetJid) {
            try {
              await sock.groupParticipantsUpdate(message.key.remoteJid, [targetJid], "remove");
              await sock.sendMessage(message.key.remoteJid, {
                react: { text: "✅", key: message.key },
              });
              logger.info({ target: targetJid }, 'User kicked');
            } catch (err) {
              logger.error({ error: err.message }, 'Kick error');
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Failed to kick user: " + err.message,
              });
            }
          }
          return;
        }

        if (command === "warn") {
          const quoted = message.message.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Reply to a user's message to warn them",
            });
            return;
          }

          const targetJid = message.message.extendedTextMessage?.contextInfo?.participant;
          if (!targetJid) return;

          const groupId = message.key.remoteJid;
          if (!userWarns[groupId]) userWarns[groupId] = {};
          if (!userWarns[groupId][targetJid]) userWarns[groupId][targetJid] = 0;

          userWarns[groupId][targetJid]++;
          const warnCount = userWarns[groupId][targetJid];

          if (warnCount >= 2) {
            if (botIsAdmin) {
              try {
                await sock.groupParticipantsUpdate(groupId, [targetJid], "remove");
                await sock.sendMessage(groupId, {
                  text: `⚠️ *@${targetJid.split("@")[0]}* received 2 warnings and has been kicked!`,
                  mentions: [targetJid]
                });
                delete userWarns[groupId][targetJid];
                logger.info({ target: targetJid }, 'User kicked after 2 warnings');
              } catch (err) {
                logger.error({ error: err.message }, 'Auto-kick error');
              }
            } else {
              await sock.sendMessage(groupId, {
                text: `⚠️ *@${targetJid.split("@")[0]}* has 2 warnings but bot is not admin to kick!`,
                mentions: [targetJid]
              });
            }
          } else {
            await sock.sendMessage(groupId, {
              text: `⚠️ *Warning ${warnCount}/2* - @${targetJid.split("@")[0]}\n\n⛔ One more warning = KICK!`,
              mentions: [targetJid]
            });
          }
          return;
        }

        if (command === "promote") {
          if (!botIsAdmin) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Bot needs to be admin to promote users!",
            });
            return;
          }

          const quoted = message.message.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Reply to a user's message to promote them",
            });
            return;
          }

          const targetJid = message.message.extendedTextMessage?.contextInfo?.participant;
          if (!targetJid) return;

          try {
            await sock.groupParticipantsUpdate(message.key.remoteJid, [targetJid], "promote");
            await sock.sendMessage(message.key.remoteJid, {
              react: { text: "✅", key: message.key },
            });
            logger.info({ target: targetJid }, 'User promoted');
          } catch (err) {
            logger.error({ error: err.message }, 'Promote error');
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Failed to promote user",
            });
          }
          return;
        }

        if (command === "demote") {
          if (!botIsAdmin) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Bot needs to be admin to demote users!",
            });
            return;
          }

          const quoted = message.message.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Reply to a user's message to demote them",
            });
            return;
          }

          const targetJid = message.message.extendedTextMessage?.contextInfo?.participant;
          if (!targetJid) return;

          try {
            await sock.groupParticipantsUpdate(message.key.remoteJid, [targetJid], "demote");
            await sock.sendMessage(message.key.remoteJid, {
              react: { text: "✅", key: message.key },
            });
            logger.info({ target: targetJid }, 'User demoted');
          } catch (err) {
            logger.error({ error: err.message }, 'Demote error');
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Failed to demote user",
            });
          }
          return;
        }

        if (command === "block") {
          const quoted = message.message.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Reply to a user's message to block them",
            });
            return;
          }

          const targetJid = message.message.extendedTextMessage?.contextInfo?.participant;
          if (!targetJid) return;

          if (!blockedUsers[myJid]) blockedUsers[myJid] = new Set();
          blockedUsers[myJid].add(targetJid);

          await sock.sendMessage(message.key.remoteJid, {
            react: { text: "✅", key: message.key },
          });
          logger.info({ target: targetJid }, 'User blocked');
          return;
        }

        if (command === "unblock") {
          if (args.length < 1) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Usage: .unblock [number]\n\nExample: .unblock 1234567890",
            });
            return;
          }

          const phoneNumber = args[0];
          const targetJid = phoneNumber + "@s.whatsapp.net";

          if (blockedUsers[myJid]?.has(targetJid)) {
            blockedUsers[myJid].delete(targetJid);
            await sock.sendMessage(message.key.remoteJid, {
              text: `✅ User ${phoneNumber} unblocked`,
            });
            logger.info({ target: targetJid }, 'User unblocked');
          } else {
            await sock.sendMessage(message.key.remoteJid, {
              text: `❌ User not found in blocked list`,
            });
          }
          return;
        }

        if (command === "antilink") {
          if (!isAdmin && !isOwner) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ This command is for admins only!",
            });
            return;
          }

          const action = args[0]?.toLowerCase();

          if (!action || (action !== "on" && action !== "off")) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Usage: .antilink on/off\n\nExample:\n.antilink on - Enable link protection\n.antilink off - Disable link protection",
            });
            return;
          }

          if (!adminSettings[message.key.remoteJid]) {
            adminSettings[message.key.remoteJid] = {};
          }

          const isOn = action === "on";
          adminSettings[message.key.remoteJid].antilink = isOn;

          const status = isOn ? "✅ *ENABLED*" : "❌ *DISABLED*";
          const messageText = isOn 
            ? `🔗 Antilink ${status}\n\n⚠️ Non-admins who send links will have their message deleted and be kicked!\n\n${botIsAdmin ? "✅ Bot is admin - ready to enforce!" : "⚠️ Make bot admin for full functionality!"}`
            : `🔗 Antilink ${status}\n\nUsers can send links freely.`;

          await sock.sendMessage(message.key.remoteJid, {
            text: messageText,
          });
          logger.info({ group: message.key.remoteJid, enabled: isOn }, 'Antilink toggled');
          return;
        }

        if (command === "delete") {
          try {
            const quoted = message.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Reply to a message to delete it",
              });
              return;
            }

            const quotedKey = {
              remoteJid: message.key.remoteJid,
              fromMe: false,
              id: message.message.extendedTextMessage?.contextInfo?.stanzaId,
              participant: message.message.extendedTextMessage?.contextInfo?.participant
            };

            await sock.sendMessage(message.key.remoteJid, {
              delete: quotedKey
            });

            await sock.sendMessage(message.key.remoteJid, {
              react: { text: "✅", key: message.key },
            });
            logger.info('Message deleted');
          } catch (err) {
            logger.error({ error: err.message }, 'Delete error');
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Failed to delete message: " + err.message,
            });
          }
          return;
        }

        if (text && text.startsWith(".")) {
          await sock.sendMessage(message.key.remoteJid, {
            text: `❌ *Unknown Command!*\n\nUse *.menu* to see available commands`,
          });
          return;
        }

      } else {
        // DM mode: isOwner was already determined above
        const canUseDM = isOwner || botMode === "public";

        logger.info({
          isOwner,
          canUseDM,
          botMode,
          sender,
          remoteJid: message.key.remoteJid,
          fromMe: message.key.fromMe,
        }, 'DM mode check');

        if (command === "menu") {
          try {
            const menuImage = fs.readFileSync("./images/menu-image.jpg");
            await sock.sendMessage(message.key.remoteJid, {
              image: menuImage,
              caption: getMenu(),
            });
          } catch (err) {
            await sock.sendMessage(message.key.remoteJid, {
              text: getMenu(),
            });
          }
          return;
        }

        if (command === "help") {
          await sock.sendMessage(message.key.remoteJid, {
            text: `ℹ️ *BOT INFORMATION*

🤖 KAIDO Bot
Built by: Everybody Hates James
Version: 2.0

━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 *Features:*
• Group management (lock/unlock/kick)
• Member tagging (hidden & visible)
• View-once media saving
• Profile picture extraction
• Custom sticker commands
• Auto-link moderation
• Warning system (2 strikes = kick)
• Live crypto prices
• Public/Private mode

━━━━━━━━━━━━━━━━━━━━━━━━━━

💡 *How to Use:*
1. Type .menu for all commands
2. Reply to messages for actions
3. Use stickers for quick commands
4. .public/.private to toggle mode

━━━━━━━━━━━━━━━━━━━━━━━━━━

Current Mode: ${botMode.toUpperCase()}

⚠️ *Important:*
Use responsibly!`,
          });
          return;
        }

        if (command === "ping") {
          const now = Date.now();
          await sock.sendMessage(message.key.remoteJid, {
            text: `📊 *PONG!*\n✅ Bot is online and responding\n⚡ Latency: ${Date.now() - now}ms\n🔧 Mode: ${botMode.toUpperCase()}`,
          });
          return;
        }

        if (command === "public") {
          if (!isOwner) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Only the bot owner can change bot mode!",
            });
            return;
          }
          botMode = "public";
          await sock.sendMessage(message.key.remoteJid, {
            text: "✅ Bot is now *PUBLIC*\n\nAll users can now use bot commands!",
          });
          logger.info('Bot mode changed to PUBLIC');
          return;
        }

        if (command === "private") {
          if (!isOwner) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Only the bot owner can change bot mode!",
            });
            return;
          }
          botMode = "private";
          await sock.sendMessage(message.key.remoteJid, {
            text: "🔐 Bot is now *PRIVATE*\n\nOnly the owner can use bot commands!",
          });
          logger.info('Bot mode changed to PRIVATE');
          return;
        }

        if (command === "live" && canUseDM) {
          const symbol = args[0];
          if (!symbol) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Usage: .live [symbol]\n\nExamples:\n.live btc\n.live eth\n.live sol",
            });
            return;
          }

          await sock.sendMessage(message.key.remoteJid, {
            react: { text: "⏳", key: message.key },
          });

          const data = await fetchCryptoPrice(symbol);

          if (!data) {
            const upperSym = symbol.toUpperCase();

            await sock.sendMessage(message.key.remoteJid, {
              text: `❌ Could not find data for *${upperSym}*

💡 *Tips:*
• Check if the symbol is correct
• The coin might not be listed on CoinGecko
• Try popular coins like: BTC, ETH, SOL, TON, BNB, ADA, XRP, DOGE, MATIC, DOT

🔍 *How to add new coins:*
If you know the CoinGecko ID for ${upperSym}, contact the bot owner to add it.

Example: Search "coingecko ${upperSym}" to find the correct ID.`,
            });
            return;
          }

          const price = parseFloat(data.lastPrice).toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 8
          });
          const change24h = parseFloat(data.priceChangePercent).toFixed(2);
          const volume = parseFloat(data.volume).toLocaleString('en-US', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
          });
          const marketCap = parseFloat(data.marketCap).toLocaleString('en-US', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 0
          });
          const changeEmoji = change24h >= 0 ? "📈" : "📉";
          const changeSign = change24h >= 0 ? "+" : "";

          await sock.sendMessage(message.key.remoteJid, {
            text: `💹 *${data.symbol}* Live Price

💰 *Price:* $${price}
${changeEmoji} *24h Change:* ${changeSign}${change24h}%

📊 *24h Stats:*
📦 Volume: $${volume}
💎 Market Cap: $${marketCap}

⏰ Updated: ${new Date().toLocaleTimeString()}
📡 Source: CoinGecko`,
          });

          await sock.sendMessage(message.key.remoteJid, {
            react: { text: "✅", key: message.key },
          });
          return;
        }

        if (command === "vv" && canUseDM) {
          try {
            const quoted = message.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Reply to a view-once photo or video with *.vv*",
              });
              return;
            }

            const viewOnceMsg = await extractViewOnceMedia(quoted);
            if (!viewOnceMsg) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ That message is not a view-once photo or video.",
              });
              return;
            }

            const media = await downloadViewOnceMedia(viewOnceMsg);
            if (!media) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Failed to download media",
              });
              return;
            }

            const ownerJid = BOT_OWNER + "@s.whatsapp.net";

            if (media.mediaType === "image") {
              await sock.sendMessage(ownerJid, {
                image: media.mediaData,
                caption: `📸 View-once from DM\n${media.caption || ""}`,
              });
            } else if (media.mediaType === "video") {
              await sock.sendMessage(ownerJid, {
                video: media.mediaData,
                caption: `🎥 View-once from DM\n${media.caption || ""}`,
              });
            }

            await sock.sendMessage(message.key.remoteJid, {
              react: { text: "✅", key: message.key },
            });
            logger.info('View-once from DM saved');
          } catch (err) {
            logger.error({ error: err.message, stack: err.stack }, 'VV DM error');
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Failed to save view-once media: " + err.message,
            });
          }
          return;
        }

        if (command === "sticker" && canUseDM) {
          try {
            const quoted = message.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Reply to an image with *.sticker*",
              });
              return;
            }

            const imageMsg = quoted?.imageMessage;
            if (!imageMsg) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Reply to an image only!",
              });
              return;
            }

            await sock.sendMessage(message.key.remoteJid, {
              react: { text: "⏳", key: message.key },
            });

            const stream = await downloadContentFromMessage(imageMsg, 'image');
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
              buffer = Buffer.concat([buffer, chunk]);
            }

            const stickerBuffer = await convertToSticker(buffer);
            if (!stickerBuffer) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Failed to convert image to sticker",
              });
              return;
            }

            await sock.sendMessage(message.key.remoteJid, {
              sticker: stickerBuffer,
            });

            await sock.sendMessage(message.key.remoteJid, {
              react: { text: "✅", key: message.key },
            });
          } catch (err) {
            logger.error({ error: err.message }, 'Sticker DM error');
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Failed to create sticker: " + err.message,
            });
          }
          return;
        }

        if (message.message.stickerMessage && !text && canUseDM) {
          const stickerHash = message.message.stickerMessage.fileSha256?.toString('base64');

          for (const [cmdName, hash] of Object.entries(stickerCommands)) {
            if (hash === stickerHash || hash === true || (typeof hash === 'object' && hash.hash === stickerHash)) {
              if (cmdName === "vv") {
                try {
                  const contextInfo = message.message.stickerMessage?.contextInfo;
                  if (!contextInfo || !contextInfo.quotedMessage) return;

                  const quoted = contextInfo.quotedMessage;
                  const viewOnceMsg = await extractViewOnceMedia(quoted);
                  if (!viewOnceMsg) return;

                  const media = await downloadViewOnceMedia(viewOnceMsg);
                  if (!media) return;

                  const ownerJid = BOT_OWNER + "@s.whatsapp.net";
                  if (media.mediaType === "image") {
                    await sock.sendMessage(ownerJid, {
                      image: media.mediaData,
                      caption: `📸 View-once from DM (via sticker)\n${media.caption || ""}`,
                    });
                  } else if (media.mediaType === "video") {
                    await sock.sendMessage(ownerJid, {
                      video: media.mediaData,
                      caption: `🎥 View-once from DM (via sticker)\n${media.caption || ""}`,
                    });
                  }

                  await sock.sendMessage(message.key.remoteJid, {
                    react: { text: "✅", key: message.key },
                  });

                  setTimeout(async () => {
                    try {
                      await sock.sendMessage(message.key.remoteJid, {
                        react: { text: "", key: message.key },
                      });
                    } catch (err) {}
                  }, 3000);

                  logger.info('View-once from DM saved via sticker');
                } catch (err) {
                  logger.error({ error: err.message }, 'DM sticker vv error');
                }
                return;
              } else if (cmdName === "sticker") {
                try {
                  const contextInfo = message.message.stickerMessage?.contextInfo;
                  if (!contextInfo?.quotedMessage?.imageMessage) return;

                  const imageMsg = contextInfo.quotedMessage.imageMessage;
                  const stream = await downloadContentFromMessage(imageMsg, 'image');
                  let buffer = Buffer.from([]);
                  for await (const chunk of stream) {
                    buffer = Buffer.concat([buffer, chunk]);
                  }

                  const stickerBuffer = await convertToSticker(buffer);
                  if (stickerBuffer) {
                    await sock.sendMessage(message.key.remoteJid, {
                      sticker: stickerBuffer,
                    });
                  }
                } catch (err) {
                  logger.error({ error: err.message }, 'DM sticker converter error');
                }
                return;
              }
            }
          }
          return;
        }

        if (command === "setsticker" && isOwner) {
          const cmdName = args[0]?.toLowerCase();
          const sticker = message.message.extendedTextMessage?.contextInfo
            ?.quotedMessage?.stickerMessage;

          if (!sticker || !cmdName) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Usage: Reply to a sticker with *.setsticker [command]*\n\nSupported commands: kick, open, lock, vv, hidetag, pp, sticker",
            });
            return;
          }

          if (!["kick", "open", "lock", "vv", "hidetag", "pp", "sticker"].includes(cmdName)) {
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Supported commands: kick, open, lock, vv, hidetag, pp, sticker",
            });
            return;
          }

          const stickerHash = sticker.fileSha256?.toString('base64');

          if (cmdName === "sticker") {
            stickerCommands[cmdName] = { type: "sticker_converter", hash: stickerHash };
          } else {
            stickerCommands[cmdName] = stickerHash || true;
          }

          await sock.sendMessage(message.key.remoteJid, {
            text: `✅ Sticker set to *${cmdName.toUpperCase()}* - works globally!`,
          });
          logger.info({ command: cmdName }, 'Sticker command set from DM');
          return;
        }

        if (command === "join" && isOwner) {
          try {
            const groupLink = text?.split(" ").slice(1).join(" ")?.trim();

            if (!groupLink) {
              await sock.sendMessage(message.key.remoteJid, {
                text: `❌ Usage: .join [WhatsApp Group Link]\n\nExample:\n.join https://chat.whatsapp.com/ABCDEF123456`,
              });
              return;
            }

            if (!groupLink.includes("chat.whatsapp.com")) {
              await sock.sendMessage(message.key.remoteJid, {
                text: `❌ Invalid WhatsApp group link!`,
              });
              return;
            }

            let code = "";
            if (groupLink.includes("chat.whatsapp.com/")) {
              code = groupLink.split("chat.whatsapp.com/")[1]?.trim();
            }

            if (!code || code.length < 10) {
              await sock.sendMessage(message.key.remoteJid, {
                text: `❌ Invalid group link format!`,
              });
              return;
            }

            const response = await sock.groupAcceptInvite(code);

            await sock.sendMessage(message.key.remoteJid, {
              text: `✅ Successfully joined the group!`,
            });
            logger.info({ code }, 'Joined group');
          } catch (err) {
            logger.error({ error: err.message }, 'Join error');
            let errorMsg = `❌ Failed to join group.\n\nPossible reasons:\n• Invalid link\n• Already in group\n• Link expired`;

            if (err.message.includes("already")) {
              errorMsg = `❌ You are already in this group!`;
            } else if (err.message.includes("expired")) {
              errorMsg = `❌ This invite link has expired!`;
            }

            await sock.sendMessage(message.key.remoteJid, {
              text: errorMsg,
            });
          }
          return;
        }

        if (command === "delete" && canUseDM) {
          try {
            const quoted = message.message.extendedTextMessage?.contextInfo?.quotedMessage;
            if (!quoted) {
              await sock.sendMessage(message.key.remoteJid, {
                text: "❌ Reply to a message to delete it",
              });
              return;
            }

            const quotedKey = {
              remoteJid: message.key.remoteJid,
              fromMe: true,
              id: message.message.extendedTextMessage?.contextInfo?.stanzaId,
            };

            await sock.sendMessage(message.key.remoteJid, {
              delete: quotedKey,
            });
          } catch (err) {
            logger.error({ error: err.message }, 'Delete DM error');
            await sock.sendMessage(message.key.remoteJid, {
              text: "❌ Failed to delete message",
            });
          }
          return;
        }

        if (text && text.startsWith(".")) {
          await sock.sendMessage(message.key.remoteJid, {
            text: `❌ *Unknown Command!*\n\nUse *.menu* to see available commands`,
          });
          return;
        }
      }
    } catch (error) {
      logger.error({ error: error.message, stack: error.stack }, 'Error handling message');
    }
  });
}

console.clear();
console.log("╔════════════════════════════════╗");
console.log("║   ⚔️ KAIDO BOT v2.0 ⚔️          ║");
console.log("║   Starting...                  ║");
console.log("╚════════════════════════════════╝\n");

startBot().catch((err) => {
  logger.error({ error: err.message, stack: err.stack }, 'Bot startup error');
});

process.on("SIGINT", () => {
  logger.info('Bot stopped gracefully');
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  logger.error({ error: err.message, stack: err.stack }, 'Uncaught exception');
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error({ reason }, 'Unhandled rejection');
});
