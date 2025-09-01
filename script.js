const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { app, setClient, setQrCode } = require('./server');
const db = require('./db');

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
    return null;
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

/**
 * Handles a new user's initial state by sending a welcome message and prompting for a room number.
 * @param {import('@whiskeysockets/baileys').WASocket} sock - The Baileys socket.
 * @param {string} senderId - The ID of the sender.
 */
async function handleInitialState(sock, senderId) {
  const welcomeMessage = `
    👋 Welcome to the ${hotelConfig.name}!
    I am your personal AI assistant.
    
    Please provide your room number to get started.
    `;

  await sock.sendMessage(senderId, { text: welcomeMessage.trim() });
  userStates.set(senderId, {
    state: 'awaitingRoomNumber',
    room: null,
    tempOrder: null
  });
}

/**
 * Main function to route responses based on the user's state.
 */
async function handleStateBasedResponse(sock, from, text, userState) {
  text = text.toLowerCase().trim();

  switch (userState.state) {
    case 'awaitingRoomNumber':
      await handleRoomNumber(sock, from, text);
      break;
    case 'initial':
      if (['menu', 'order'].includes(text)) {
        await sendFullMenu(sock, from);
        userState.state = 'awaitingMenuSelection';
        userStates.set(from, userState);
      } else if (['reception', 'help'].includes(text)) {
        await transferToReception(sock, from);
        userState.state = 'reception';
        userStates.set(from, userState);
      } else {
        await sock.sendMessage(from, { text: 'I did not understand that. Please type "menu" to see our options or "reception" for help.' });
      }
      break;
    case 'awaitingMenuSelection':
      await handleMenuResponse(sock, from, text);
      break;
    case 'awaitingPayment':
      await handlePayment(sock, from, text);
      break;
    case 'reception':
      await transferToReception(sock, from, text);
      break;
    case 'awaitingRating':
      await handleRating(sock, from, text);
      break;
    default:
      await sock.sendMessage(from, { text: 'I am not sure how to help. Please type "start" to begin.' });
      break;
  }
}

/**
 * Handles the room number input from the user.
 */
async function handleRoomNumber(sock, from, text) {
  const userState = userStates.get(from);
  const roomNumber = parseInt(text, 10);

  if (!isNaN(roomNumber) && roomNumber > 0) {
    userState.room = roomNumber;
    userState.state = 'initial';
    userStates.set(from, userState);
    await sock.sendMessage(from, { text: `Thank you! Your room number is set to ${roomNumber}. You can now type 'menu' to see our food options or 'reception' to contact the front desk.` });
  } else {
    await sock.sendMessage(from, { text: "That doesn't look like a valid room number. Please enter a valid number (e.g., 201)." });
  }
}

/**
 * Handles responses when the user is in the 'awaitingMenuSelection' state.
 */
async function handleMenuResponse(sock, from, text) {
  const userState = userStates.get(from);
  text = text.toLowerCase().trim();
  
  if (text === 'checkout') {
    const itemsCount = Object.keys(userState.tempOrder || {}).length;
    if (itemsCount > 0) {
      const orderSummary = Object.entries(userState.tempOrder).map(([item, quantity]) => `${quantity} x ${item}`).join('\n');
      await sock.sendMessage(from, { text: `Your order summary:\n\n${orderSummary}\n\nTo confirm and place this order, please type 'pay'. To cancel, type 'cancel'.` });
      userState.state = 'awaitingPayment';
    } else {
      await sock.sendMessage(from, { text: 'Your order is empty. Please add items from the menu first.' });
    }
    userStates.set(from, userState);
    return;
  }

  if (text === 'cancel') {
    userState.tempOrder = {};
    userState.state = 'initial';
    userStates.set(from, userState);
    await sock.sendMessage(from, { text: 'Your order has been cancelled. You can start a new one by typing "menu".' });
    return;
  }

  // Attempt to add item to the temporary order
  const menuConfig = loadMenuConfig();
  if (menuConfig) {
    const allMenuItems = Object.values(menuConfig.menu).flat().map(item => item.toLowerCase());
    if (allMenuItems.includes(text)) {
      userState.tempOrder = userState.tempOrder || {};
      userState.tempOrder[text] = (userState.tempOrder[text] || 0) + 1;
      userStates.set(from, userState);

      const currentOrder = Object.entries(userState.tempOrder).map(([item, quantity]) => `${quantity} x ${item}`).join(', ');
      await sock.sendMessage(from, { text: `✅ Added ${text}. Your current order: ${currentOrder}.\n\nType 'checkout' to place your order or add more items.` });
    } else {
      await sock.sendMessage(from, { text: `"${text}" is not on the menu. Please type the exact name of the item to add it to your order.` });
    }
  } else {
    await sock.sendMessage(from, { text: "Sorry, I can't access the menu right now." });
  }
}

/**
 * Handles the payment confirmation.
 */
async function handlePayment(sock, from, text) {
  const userState = userStates.get(from);
  text = text.toLowerCase().trim();

  if (text === 'pay') {
    await placeOrder(sock, from, userState);
    userState.tempOrder = {}; // Clear order after placing
    userState.state = 'initial'; // Reset state
    userStates.set(from, userState);
  } else if (text === 'cancel') {
    userState.tempOrder = {}; // Clear order
    userState.state = 'initial'; // Reset state
    userStates.set(from, userState);
    await sock.sendMessage(from, { text: 'Your order has been cancelled.' });
  } else {
    await sock.sendMessage(from, { text: "Please type 'pay' to confirm or 'cancel' to stop the order." });
  }
}

/**
 * Handles the user rating.
 */
async function handleRating(sock, from, text) {
  const rating = parseInt(text.trim(), 10);
  if (!isNaN(rating) && rating >= 1 && rating <= 5) {
    await sock.sendMessage(from, { text: `⭐ Thank you for rating our service! Your ${rating}-star rating has been recorded.` });
    userStates.get(from).state = 'initial';
  } else {
    await sock.sendMessage(from, { text: "Please provide a rating between 1 and 5." });
  }
}

/**
 * Transfers the conversation to the reception/admin.
 * @param {import('@whiskeysockets/baileys').WASocket} sock - The Baileys socket.
 * @param {string} number - The recipient's number.
 * @param {string} [guestMessage='Guest requires assistance.'] - The message from the guest.
 */
async function transferToReception(sock, number, guestMessage = 'Guest requires assistance.') {
  const userState = userStates.get(number);
  const adminMessage = `
    🔔 Guest Assistance Required!
    📞 Guest number: ${number}
    🏨 Room: ${userState.room || 'Unknown'}
    
    💬 Guest message: "${guestMessage}"
    
    Please respond directly to the guest to assist them.
  `;

  await sock.sendMessage(hotelConfig.adminNumber, {
    text: adminMessage.trim(),
  });

  await sock.sendMessage(number, {
    text: `Your request has been forwarded to our reception. A member of our staff will assist you shortly.`,
  });
}

/**
 * Sends the full hotel menu to the guest.
 */
async function sendFullMenu(sock, number) {
  const currentMenuConfig = loadMenuConfig();
  
  if (!currentMenuConfig || !currentMenuConfig.menu) {
    await sock.sendMessage(number, { text: 'Sorry, the menu is currently unavailable. Please try again later.' });
    return;
  }

  let text = `📋 Our Menu:\n\n`;
  for (const category in currentMenuConfig.menu) {
    text += `🍽 ${category.toUpperCase()} (${currentMenuConfig.hours[category]}):\n`;
    text += currentMenuConfig.menu[category].map(item => `• ${item}`).join('\n') + '\n\n';
  }
  text += `To order, just type the name of the item. You can add multiple items before typing 'checkout' to place your order.`;

  await sock.sendMessage(number, { text: text });
}

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
        console.log(`New user state created for: ${senderId}`);
        await handleInitialState(sock, senderId);
      } else {
        const userState = userStates.get(senderId);
        await handleStateBasedResponse(sock, senderId, messageText, userState);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);

  return sock;
}

// Start the server and bot
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`📱 Admin Dashboard: http://localhost:${PORT}/admin.html`);
  console.log(`🔗 QR Endpoint: http://localhost:${PORT}/qr`);
  connectToWhatsApp();
});
