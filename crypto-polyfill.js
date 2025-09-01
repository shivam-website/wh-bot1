// crypto-polyfill.js
const { webcrypto } = require('crypto');

// Polyfill for Web Crypto API
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}

console.log('Crypto polyfill applied successfully');
