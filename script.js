const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode'); // Corrected library
const fs = require('fs');
const path = require('path');
const { app, setClient } = require('./server');

// Hotel Configuration
const hotelConfig = {
  name: "Hotel Welcome",
  adminNumber: '9779819809195@s.whatsapp.net',
  receptionExtension: "22",
  databaseFile: path.join(__dirname, 'orders.json'),
  menuFile: path.join(__dirname, 'menu-config.json'),
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
    if (fs.existsSync(hotelConfig.menuFile)) {
      const menuData = JSON.parse(fs.readFileSync(hotelConfig.menuFile, 'utf8'));
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

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');

  const sock = makeWASocket({
    logger,
    printQRInTerminal: false, // Prevents printing QR code in terminal
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

    // Log the QR code as a URL
    if (qr) {
      console.log('To scan, copy this link and paste into your browser:');
      qrcode.toDataURL(qr, (err, url) => {
        if (err) {
          console.error('Failed to generate QR code URL:', err);
          return;
        }
        console.log(url);
      });
    }
  });

  sock.ev.on('messages.upsert', async (m) => {
    if (m.messages && m.messages.length > 0) {
      const msg = m.messages[0];
      if (msg.key.fromMe) return; // Don't process my own messages
      if (processedMessageIds.has(msg.key.id)) return; // Avoid processing duplicates
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

      // Check for welcome message or keyword
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

/**
 * Handles the initial state of the conversation, greeting the user and asking for their room number.
 */
async function handleInitialState(sock, from) {
  const welcomeMessage = `Hello! I'm the Hotel Welcome Bot. I'm here to assist you with your needs during your stay.\n\nPlease enter your room number to get started.`;
  await sock.sendMessage(from, { text: welcomeMessage });
  userStates.set(from, { ...userStates.get(from),
    state: 'awaitingRoomNumber'
  });
}

/**
 * Handles responses based on the current state of the user's conversation.
 */
async function handleStateBasedResponse(sock, from, message, state) {
  const command = message.toLowerCase().trim();

  switch (state.state) {
    case 'awaitingRoomNumber':
      await handleRoomNumber(sock, from, command, state);
      break;
    case 'mainMenu':
      await handleMainMenu(sock, from, command, state);
      break;
    case 'orderingFood':
      await handleFoodOrdering(sock, from, command, state);
      break;
    case 'awaitingRating':
      await handleRating(sock, from, command, state);
      break;
    default:
      await sock.sendMessage(from, {
        text: "I didn't understand that. Please type 'Hi' to start over."
      });
      break;
  }
}

/**
 * Handles the response when the bot is awaiting a room number.
 */
async function handleRoomNumber(sock, from, message, state) {
  const roomNumber = parseInt(message);
  if (isNaN(roomNumber)) {
    await sock.sendMessage(from, {
      text: "That doesn't look like a valid room number. Please enter a valid room number."
    });
    return;
  }

  userStates.set(from, { ...state,
    state: 'mainMenu',
    room: roomNumber
  });
  console.log(`User ${from} is now in room ${roomNumber}.`);
  const welcomeMessage = `Thank you! You are now checked into room *${roomNumber}*.\n\nHow can I help you today? Please choose an option:\n\n1. 📋 View Menu\n2. 🛎️ Request Service\n3. 📞 Call Reception\n4. 📅 Check-in/out times`;
  await sock.sendMessage(from, {
    text: welcomeMessage
  });
}


async function handleMainMenu(sock, from, command, state) {
  switch (command) {
    case '1':
    case 'view menu':
    case 'menu':
      await sendFullMenu(sock, from);
      break;
    case '2':
    case 'request service':
    case 'service':
      await requestService(sock, from, state);
      break;
    case '3':
    case 'call reception':
    case 'reception':
      await callReception(sock, from);
      break;
    case '4':
    case 'check-in/out times':
    case 'times':
      await sendCheckInOutTimes(sock, from);
      break;
    default:
      await sock.sendMessage(from, {
        text: "Please select a valid option from the list."
      });
      break;
  }
}

async function handleFoodOrdering(sock, from, command, state) {
  if (command === 'cancel') {
    userStates.set(from, { ...state,
      state: 'mainMenu',
      tempOrder: null
    });
    await sock.sendMessage(from, {
      text: "Order cancelled. What else can I help with?"
    });
    return;
  }

  // Load menu dynamically to ensure we always have the latest ✅
  const currentMenuConfig = loadMenuConfig();
  if (!currentMenuConfig) {
    await sock.sendMessage(from, {
      text: "Sorry, the menu is currently unavailable. Please try again later."
    });
    return;
  }

  let tempOrder = state.tempOrder || {};

  const menuItem = Object.values(currentMenuConfig.menu).flatMap(items => items).find(item => item.toLowerCase() === command);

  if (menuItem) {
    tempOrder[menuItem] = (tempOrder[menuItem] || 0) + 1;
    userStates.set(from, { ...state,
      tempOrder: tempOrder
    });

    const orderSummary = Object.keys(tempOrder).map(item => `${item} x ${tempOrder[item]}`).join(', ');
    await sock.sendMessage(from, {
      text: `Added *${menuItem}* to your order. Your current order is: ${orderSummary}.\n\nReply with 'done' to confirm or add another item.`
    });
  } else if (command === 'done') {
    if (Object.keys(tempOrder).length > 0) {
      await placeOrder(sock, from, state);
      userStates.set(from, { ...state,
        state: 'mainMenu',
        tempOrder: null
      });
    } else {
      await sock.sendMessage(from, {
        text: "Your order is empty. Please add items or type 'cancel'."
      });
    }
  } else {
    await sock.sendMessage(from, {
      text: "Sorry, I couldn't find that item on the menu. Please select a valid item or type 'done' to confirm."
    });
  }
}

async function handleRating(sock, from, command, state) {
  const rating = parseInt(command);
  if (isNaN(rating) || rating < 1 || rating > 5) {
    await sock.sendMessage(from, {
      text: "Please provide a rating between 1 and 5."
    });
    return;
  }

  // Send rating to admin
  await sock.sendMessage(hotelConfig.adminNumber, {
    text: `⭐ Rating Received from Room ${state.room}: ${rating}/5`
  });

  await sock.sendMessage(from, {
    text: "Thank you for your feedback! It helps us improve our service."
  });

  userStates.set(from, { ...state,
    state: 'mainMenu'
  });
}


/**
 * Places the final order for the guest.
 */
async function placeOrder(sock, from, state) {
  const orderId = `ORD-${Date.now()}`;
  const newOrder = {
    orderId,
    room: state.room,
    items: Object.keys(state.tempOrder).map(item => ({
      name: item,
      quantity: state.tempOrder[item]
    })),
    status: 'pending',
    timestamp: new Date().toISOString()
  };

  // Save order to a file (simple persistent storage)
  let orders = {};
  if (fs.existsSync(hotelConfig.databaseFile)) {
    orders = JSON.parse(fs.readFileSync(hotelConfig.databaseFile, 'utf8'));
  }
  orders[orderId] = newOrder;
  fs.writeFileSync(hotelConfig.databaseFile, JSON.stringify(orders, null, 2));

  // Notify admin
  const orderSummaryForAdmin = newOrder.items.map(item => `${item.quantity} x ${item.name}`).join('\n');
  await sock.sendMessage(hotelConfig.adminNumber, {
    text: `📢 NEW ORDER\n#${orderId}\n🏨 Room: ${state.room}\n🍽 Items:\n${orderSummaryForAdmin}\n\nPlease confirm when ready.`
  });

  // Confirm to guest
  const orderSummaryForGuest = newOrder.items.map(item => `${item.quantity} x ${item.name}`).join(', ');
  await sock.sendMessage(from, {
    text: `✅ Order confirmed! #${orderId}\n\nYour order has been placed and will arrive shortly. Thank you!`
  });

  // Ask for rating after a delay
  setTimeout(async () => {
    await sock.sendMessage(from, {
      text: "Hope you enjoyed your meal! Please rate our service from 1-5."
    });
    userStates.set(from, { ...state,
      state: 'awaitingRating'
    });
  }, 10000); // 10-second delay for example
}

/**
 * Sends the full hotel menu to the guest.
 */
async function sendFullMenu(sock, number) {
  // Reload menu fresh every time to ensure latest changes ✅
  const currentMenuConfig = loadMenuConfig();
  if (!currentMenuConfig) {
    await sock.sendMessage(number, {
      text: "Sorry, the menu is currently unavailable. Please try again later."
    });
    return;
  }

  let text = `📋 Our Menu:\n\n`;
  for (const category in currentMenuConfig.menu) {
    text += `🍽 ${category.toUpperCase()} (${currentMenuConfig.hours[category]}):\n`;
    text += currentMenuConfig.menu[category].map(item => `• ${item}`).join('\n') + '\n\n';
  }
  text += "To order, please type the name of the item. Type 'done' when you are finished.\n\n*Example:* 'Pasta'";

  await sock.sendMessage(number, {
    text: text
  });

  userStates.set(number, { ...userStates.get(number),
    state: 'orderingFood'
  });
}

/**
 * Notifies the admin about a service request.
 */
async function requestService(sock, from, state) {
  await sock.sendMessage(hotelConfig.adminNumber, {
    text: `🛎️ Service Request from Room ${state.room}`
  });
  await sock.sendMessage(from, {
    text: "Your request has been sent to the front desk. Someone will be with you shortly."
  });
}

/**
 * Provides the guest with the reception contact number.
 */
async function callReception(sock, from) {
  await sock.sendMessage(from, {
    text: `📞 You can call reception by dialing extension *${hotelConfig.receptionExtension}*.`
  });
}

/**
 * Provides the guest with the check-in and check-out times.
 */
async function sendCheckInOutTimes(sock, from) {
  await sock.sendMessage(from, {
    text: `📅 Check-in time is *${hotelConfig.checkInTime}* and check-out time is *${hotelConfig.checkOutTime}*.`
  });
}

// Start the WhatsApp bot
connectToWhatsApp();
