const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const { app, setClient } = require('./server');

// Database setup for persistent state
const { Sequelize, Model, DataTypes } = require('sequelize');

// Load environment variables
require('dotenv').config();
const dbUrl = process.env.DATABASE_URL;

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
    console.error("Failed to load menu config:", error);
    return null;
  }
}

// Global logger for Baileys
const logger = pino({
  level: 'info'
}).child({
  level: 'silent',
  stream: 'baileys'
});

/**
 * Custom database-backed authentication state store for Baileys.
 * This function handles creating the database connection and the model,
 * and then returns the correct authState object for Baileys to use.
 */
async function getAuthState() {
  const sequelize = new Sequelize(dbUrl, {
    dialect: 'postgres',
    logging: false, // Set to true to see SQL queries
    dialectOptions: {
      ssl: {
        require: true,
        rejectUnauthorized: false
      }
    }
  });

  try {
    await sequelize.authenticate();
    logger.info('Database connection has been established successfully.');
  } catch (error) {
    logger.error('Unable to connect to the database:', error);
    throw error;
  }

  class Session extends Model {}
  Session.init({
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true
    },
    key: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true
    },
    value: {
      type: DataTypes.JSONB,
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'Session',
    tableName: 'baileys_sessions'
  });

  await Session.sync(); // Ensure the table exists

  return {
    state: {
      creds: await Session.findOne({
        where: {
          key: 'creds'
        }
      }).then(res => res ? res.value : null),
      keys: {
        get: async (type, key) => {
          const res = await Session.findOne({
            where: {
              key: `${type}-${key}`
            }
          });
          return res ? res.value : null;
        },
        set: async (data) => {
          for (const key in data) {
            if (Object.prototype.hasOwnProperty.call(data, key)) {
              await Session.upsert({
                key,
                value: data[key]
              });
            }
          }
        },
        del: async (key) => {
          await Session.destroy({
            where: {
              key
            }
          });
        }
      }
    },
    saveCreds: async () => {
      await Session.upsert({
        key: 'creds',
        value: JSON.parse(JSON.stringify(auth.state.creds, null, 2))
      });
    },
    clearState: async () => {
      await Session.truncate();
    }
  };
}

async function startBot() {
  const {
    state,
    saveCreds,
    clearState
  } = await getAuthState();

  // Create the bot connection
  const sock = makeWASocket({
    logger,
    browser: Browsers.macOS('Hotel Bot'),
    printQRInTerminal: true,
    auth: state
  });

  // Export the client for the Express server
  setClient(sock);

  // Connection events
  sock.ev.on('connection.update', (update) => {
    const {
      connection,
      lastDisconnect
    } = update;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
      logger.info('connection closed due to ', lastDisconnect.error, ', reconnecting ', shouldReconnect);
      // Restart the bot if needed
      if (shouldReconnect) {
        startBot();
      } else {
        logger.info('Logged out. Clearing state and restarting.');
        clearState().then(() => startBot());
      }
    } else if (connection === 'open') {
      logger.info('Opened connection');
      console.log('✅ WhatsApp connection established successfully!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Message handler
  sock.ev.on('messages.upsert', async ({
    messages
  }) => {
    for (const msg of messages) {
      if (!msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
        const from = msg.key.remoteJid;
        const msgId = msg.key.id;

        // Skip if message already processed
        if (processedMessageIds.has(msgId)) {
          return;
        }
        processedMessageIds.add(msgId);
        setTimeout(() => processedMessageIds.delete(msgId), 5000); // Clear after 5 seconds

        const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const lowerCaseText = messageText.toLowerCase().trim();

        console.log(`Received message from ${from}: "${messageText}"`);

        // Get or initialize user state
        let state = userStates.get(from) || {
          step: 'initial'
        };
        userStates.set(from, state);

        // State machine logic
        try {
          // --- Main Menu and General Interactions ---
          if (lowerCaseText === 'hello' || lowerCaseText === 'hi') {
            await handleInitialGreeting(sock, from, state);
          } else if (lowerCaseText === 'menu') {
            await sendFullMenu(sock, from);
          } else if (lowerCaseText === 'room service') {
            await handleRoomServiceRequest(sock, from, state);
          } else if (lowerCaseText.startsWith('order ')) {
            await handleOrderPlacement(sock, from, messageText, state);
          } else if (lowerCaseText === 'reception') {
            await handleReceptionRequest(sock, from);
          } else if (lowerCaseText === 'check in' || lowerCaseText === 'check out') {
            await handleCheckInCheckOutInfo(sock, from, lowerCaseText);
          } else if (lowerCaseText.startsWith('rate ')) {
            await handleRating(sock, from, messageText);
          } else {
            // Check for previous states and handle accordingly
            await handleStatefulMessages(sock, from, lowerCaseText, state);
          }
        } catch (error) {
          console.error("Error handling message:", error);
          await sock.sendMessage(from, {
            text: "Sorry, an error occurred while processing your request. Please try again later."
          });
        }
      }
    }
  });
}

/**
 * Handles the initial greeting and presents the main menu options.
 */
async function handleInitialGreeting(sock, from, state) {
  state.step = 'initial'; // Reset state
  await sock.sendMessage(from, {
    text: `👋 Welcome to ${hotelConfig.name}! How can I assist you today?
      \n*Room Service*: Order food to your room.
      \n*Reception*: Get in touch with the front desk.
      \n*Menu*: See our full menu.
      \n*Check In/Out*: Find out about check-in and check-out times.
      `
  });
}

/**
 * Guides the user through the room service order process.
 */
async function handleRoomServiceRequest(sock, from, state) {
  const currentMenuConfig = loadMenuConfig();
  const menuCategories = Object.keys(currentMenuConfig.menu).map((cat, index) => `${index + 1}. ${cat}`).join('\n');
  await sock.sendMessage(from, {
    text: `🍴 Room Service Menu\n\nPlease reply with the number of the category you'd like to order from:\n${menuCategories}`
  });
  state.step = 'awaiting_category_selection';
}

/**
 * Handles the user's category selection and displays the items.
 */
async function handleCategorySelection(sock, from, messageText, state) {
  const currentMenuConfig = loadMenuConfig();
  const categories = Object.keys(currentMenuConfig.menu);
  const selectedIndex = parseInt(messageText, 10) - 1;

  if (selectedIndex >= 0 && selectedIndex < categories.length) {
    const category = categories[selectedIndex];
    state.category = category;
    const items = currentMenuConfig.menu[category];
    const itemText = items.map((item, index) => `${index + 1}. ${item}`).join('\n');

    await sock.sendMessage(from, {
      text: `📋 ${category.toUpperCase()} Menu\n\nPlease reply with the numbers of the items you wish to order, separated by commas (e.g., 1, 3, 5):\n${itemText}`
    });
    state.step = 'awaiting_items';
  } else {
    await sock.sendMessage(from, {
      text: "❌ Invalid selection. Please choose a valid category number from the list."
    });
    state.step = 'awaiting_category_selection'; // Stay in the same step
  }
}

/**
 * Handles the user's item selection and asks for the room number.
 */
async function handleItemSelection(sock, from, messageText, state) {
  const currentMenuConfig = loadMenuConfig();
  const selectedIndices = messageText.split(',').map(s => parseInt(s.trim(), 10) - 1);
  const category = state.category;

  if (selectedIndices.some(isNaN) || selectedIndices.some(i => i < 0 || i >= currentMenuConfig.menu[category].length)) {
    await sock.sendMessage(from, {
      text: "❌ Invalid item numbers. Please reply with comma-separated numbers from the list."
    });
    return;
  }

  const selectedItems = selectedIndices.map(index => currentMenuConfig.menu[category][index]);
  state.items = selectedItems.map(item => ({
    name: item,
    quantity: 1
  }));

  await sock.sendMessage(from, {
    text: "Great! What is your room number?"
  });
  state.step = 'awaiting_room_number';
}

/**
 * Handles the user's room number and confirms the order.
 */
async function handleRoomNumber(sock, from, messageText, state) {
  const roomNumber = messageText.trim();
  state.room = roomNumber;

  const orderSummary = state.items.map(item => `• ${item.quantity} x ${item.name}`).join('\n');
  const confirmationText = `📝 Order Summary:\n\nRoom: ${state.room}\nItems:\n${orderSummary}\n\nPlease reply "ORDER" to confirm this order.`;

  await sock.sendMessage(from, {
    text: confirmationText
  });
  state.step = 'awaiting_order_confirmation';
}

/**
 * Handles final order confirmation and saves the order.
 */
async function handleOrderConfirmation(sock, from, state) {
  const orderId = `WH${Date.now()}`;
  const newOrder = {
    id: orderId,
    customerNumber: from,
    room: state.room,
    items: state.items,
    timestamp: new Date().toISOString()
  };

  // Persist the order to the JSON file
  saveOrderToFile(newOrder);

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
      text: `⭐️ How was your experience? Please rate your order #${orderId} on a scale of 1 to 5, e.g., "rate ${orderId} 5".`
    });
  }, 300000); // 5 minutes delay

  // Reset state
  userStates.delete(from);
}

/**
 * Saves a new order to the JSON file.
 */
function saveOrderToFile(order) {
  let orders = [];
  if (fs.existsSync(hotelConfig.databaseFile)) {
    try {
      orders = JSON.parse(fs.readFileSync(hotelConfig.databaseFile, 'utf8'));
    } catch (error) {
      console.error("Failed to parse orders file:", error);
    }
  }
  orders.push(order);
  fs.writeFileSync(hotelConfig.databaseFile, JSON.stringify(orders, null, 2));
}

/**
 * Sends the full hotel menu to the guest.
 */
async function sendFullMenu(sock, number) {
  // Reload menu fresh every time to ensure latest changes ✅
  const currentMenuConfig = loadMenuConfig();

  let text = `📋 Our Menu:\n\n`;
  for (const category in currentMenuConfig.menu) {
    text += `🍽 ${category.toUpperCase()} (${currentMenuConfig.hours[category]}):
    \n`;
    text += currentMenuConfig.menu[category].map(item => `• ${item}`).join('\n') + '\n\n';
  }
  text += `To order, type "Room Service" and follow the prompts.`;
  await sock.sendMessage(number, {
    text: text
  });
}

/**
 * Handles the "Reception" command.
 */
async function handleReceptionRequest(sock, from) {
  await sock.sendMessage(from, {
    text: `🛎 You can call our reception desk directly by dialing extension *${hotelConfig.receptionExtension}* from your room phone.`
  });
}

/**
 * Handles "Check In" and "Check Out" requests.
 */
async function handleCheckInCheckOutInfo(sock, from, type) {
  if (type === 'check in') {
    await sock.sendMessage(from, {
      text: `🛎 Our official check-in time is *${hotelConfig.checkInTime}*. We look forward to welcoming you!`
    });
  } else if (type === 'check out') {
    await sock.sendMessage(from, {
      text: `🛎 Our official check-out time is *${hotelConfig.checkOutTime}*. Please let us know if you need to arrange a late checkout.`
    });
  }
}

/**
 * Handles user ratings for an order.
 */
async function handleRating(sock, from, messageText) {
  const parts = messageText.split(' ');
  if (parts.length === 3 && parts[0].toLowerCase() === 'rate') {
    const orderId = parts[1];
    const rating = parseInt(parts[2], 10);

    if (rating >= 1 && rating <= 5) {
      // Logic to save the rating goes here
      // For now, we'll just send a confirmation
      await sock.sendMessage(from, {
        text: `⭐ Thank you for rating your experience! We've recorded your ${rating}/5 rating for order #${orderId}.`
      });
    } else {
      await sock.sendMessage(from, {
        text: "❌ Please provide a rating between 1 and 5. E.g., 'rate WH12345 5'."
      });
    }
  } else {
    await sock.sendMessage(from, {
      text: "❌ Invalid rating format. Please use 'rate [orderId] [rating]'. E.g., 'rate WH12345 5'."
    });
  }
}

/**
 * Handles messages based on the current user state.
 */
async function handleStatefulMessages(sock, from, messageText, state) {
  switch (state.step) {
    case 'awaiting_category_selection':
      await handleCategorySelection(sock, from, messageText, state);
      break;
    case 'awaiting_items':
      await handleItemSelection(sock, from, messageText, state);
      break;
    case 'awaiting_room_number':
      await handleRoomNumber(sock, from, messageText, state);
      break;
    case 'awaiting_order_confirmation':
      if (messageText === 'order') {
        await handleOrderConfirmation(sock, from, state);
      } else {
        await sock.sendMessage(from, {
          text: `❌ Order not confirmed. Please reply with the exact word "ORDER" to finalize.`
        });
      }
      break;
    default:
      await sock.sendMessage(from, {
        text: "I didn't understand that. Please reply with one of the main options like 'Hello', 'Room Service', 'Reception', 'Menu', or 'Check In/Out'."
      });
      break;
  }
}

startBot();
