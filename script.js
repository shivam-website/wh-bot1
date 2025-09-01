const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const { app, setClient, setQrCode } = require('./server');
const db = require('./db'); // Import the same database module

// Hotel Configuration
const hotelConfig = {
  name: "Hotel Welcome",
  adminNumber: '9779819809195@s.whatsapp.net', // Update this!
  receptionExtension: "22",
  checkInTime: "2:00 PM",
  checkOutTime: "11:00 AM"
};

// Map to store user conversation states
const userStates = new Map();

// Set to track processed message IDs to prevent duplicates
const processedMessageIds = new Set();

// Function to load menu dynamically
function loadMenuConfig() {
  try {
    const menuFile = path.join(__dirname, 'menu-config.json');
    if (fs.existsSync(menuFile)) {
      const menuData = JSON.parse(fs.readFileSync(menuFile, 'utf8'));
      return {
        menu: menuData.menu,
        hours: menuData.hours
      };
    }
  } catch (error) {
    console.error("Failed to load menu configuration:", error);
    return null;
  }
}

const logger = pino({ level: 'info' });

// Function to handle actions after connection is opened
async function handleOpenConnection(sock) {
  console.log("✅ WhatsApp connection established successfully!");
  // Send a message to yourself that the bot is online:
  try {
    await sock.sendMessage(hotelConfig.adminNumber, { 
      text: `🤖 Hotel Bot is now online and ready to serve guests!` 
    });
  } catch (error) {
    console.log("Could not send startup message to admin:", error);
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');

  const sock = makeWASocket({
    logger,
    printQRInTerminal: false,
    browser: ['Hotel Bot', 'Safari', '1.0'],
    auth: state
  });

  setClient(sock);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (connection === 'close') {
      let reason = new Boom(lastDisconnect.error).output.statusCode;
      if (reason === DisconnectReason.badSession) {
        console.log(`Bad Session File, Please Delete and Scan Again`);
        await connectToWhatsApp();
      } else if (reason === DisconnectReason.connectionClosed) {
        console.log("Connection closed, reconnecting...");
        await connectToWhatsApp();
      } else if (reason === DisconnectReason.connectionLost) {
        console.log("Connection Lost from Server, reconnecting...");
        await connectToWhatsApp();
      } else if (reason === DisconnectReason.loggedOut) {
        console.log(`Device Logged Out, Please Delete and Scan Again.`);
        await connectToWhatsApp();
      } else if (reason === DisconnectReason.restartRequired) {
        console.log("Restart required, reconnecting...");
        await connectToWhatsApp();
      } else if (reason === DisconnectReason.timedOut) {
        console.log("Connection timed out, reconnecting...");
        await connectToWhatsApp();
      } else {
        sock.end(`Unknown DisconnectReason: ${reason}|${lastDisconnect.error}`);
      }
    } else if (connection === 'open') {
      console.log('Opened connection');
      await handleOpenConnection(sock);
    }

    // Generate and set QR code for web display
    if (qr) {
      console.log('To scan, copy this link and paste into your browser:');
      qrcode.toDataURL(qr, (err, url) => {
        if (err) {
          console.error('Failed to generate QR code URL:', err);
          return;
        }
        console.log(url);
        setQrCode(url); // This makes QR available at /qr endpoint
      });
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.messages && m.messages.length > 0) {
      const msg = m.messages[0];
      if (msg.key.fromMe) return;
      if (processedMessageIds.has(msg.key.id)) return;
      processedMessageIds.add(msg.key.id);

      const senderId = msg.key.remoteJid;
      const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

      if (!userStates.has(senderId)) {
        userStates.set(senderId, {
          state: 'initial',
          room: null,
          tempOrder: null
        });
        console.log(`New user state created for: ${senderId}`);
      }

      const userState = userStates.get(senderId);

      if (['hi', 'hello', 'hey', 'start'].includes(messageText.toLowerCase())) {
        await handleInitialState(sock, senderId);
      } else {
        await handleStateBasedResponse(sock, senderId, messageText, userState);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  return sock;
}

// [ALL YOUR HANDLER FUNCTIONS REMAIN THE SAME...]
// handleInitialState, handleStateBasedResponse, handleRoomNumber, etc.

/**
 * Places the final order for the guest - UPDATED FOR DATABASE
 */
async function placeOrder(sock, from, state) {
  const orderId = `ORD-${Date.now()}`;
  const items = Object.keys(state.tempOrder).map(item => ({
    name: item,
    quantity: state.tempOrder[item]
  }));

  try {
    // Save to PostgreSQL database instead of JSON file
    const query = 'INSERT INTO orders(room, items, guestNumber, status) VALUES($1, $2, $3, $4) RETURNING *';
    const values = [state.room, JSON.stringify(items), from, 'Pending'];
    const result = await db.query(query, values);
    const newOrder = result.rows[0];

    // Notify admin
    const orderSummaryForAdmin = items.map(item => `${item.quantity} x ${item.name}`).join('\n');
    await sock.sendMessage(hotelConfig.adminNumber, {
      text: `📢 NEW ORDER\n#${newOrder.id}\n🏨 Room: ${state.room}\n🍽 Items:\n${orderSummaryForAdmin}\n\nPlease confirm when ready.`
    });

    // Confirm to guest
    const orderSummaryForGuest = items.map(item => `${item.quantity} x ${item.name}`).join(', ');
    await sock.sendMessage(from, {
      text: `✅ Order confirmed! #${newOrder.id}\n\nYour order has been placed and will arrive shortly. Thank you!`
    });

    // Ask for rating after a delay
    setTimeout(async () => {
      await sock.sendMessage(from, {
        text: "Hope you enjoyed your meal! Please rate our service from 1-5."
      });
      userStates.set(from, { ...state,
        state: 'awaitingRating'
      });
    }, 10000);

  } catch (err) {
    console.error('Error saving order to database:', err);
    await sock.sendMessage(from, {
      text: "❌ Sorry, there was an error processing your order. Please try again or contact reception."
    });
  }
}

// Start the server and bot
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`📱 Admin Dashboard: http://localhost:${PORT}/admin.html`);
  console.log(`🔗 QR Endpoint: http://localhost:${PORT}/qr`);
  connectToWhatsApp();
});
