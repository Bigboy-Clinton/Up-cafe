require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

const CONFIG = {
  consumerKey: process.env.MPESA_CONSUMER_KEY,
  consumerSecret: process.env.MPESA_CONSUMER_SECRET,
  passkey: process.env.MPESA_PASSKEY,
  shortcode: process.env.MPESA_SHORTCODE || '0141701000',
  environment: process.env.MPESA_ENVIRONMENT || 'sandbox',
  callbackUrl: process.env.MPESA_CALLBACK_URL,
};

const BASE_URL = CONFIG.environment === 'sandbox'
  ? 'https://sandbox.safaricom.co.ke'
  : 'https://api.safaricom.co.ke';

const pendingTransactions = {};

function generateTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function generatePassword(shortcode, passkey, timestamp) {
  return Buffer.from(shortcode + passkey + timestamp).toString('base64');
}

async function getAccessToken() {
  const auth = Buffer.from(`${CONFIG.consumerKey}:${CONFIG.consumerSecret}`).toString('base64');
  const res = await axios.get(`${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${auth}` },
  });
  return res.data.access_token;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Up & Cafe Backend' });
});

app.post('/api/mpesa/stkpush', async (req, res) => {
  try {
    const { phone, amount, orderId } = req.body;
    if (!phone || !amount || !orderId) {
      return res.status(400).json({ error: 'phone, amount, and orderId are required' });
    }

    let normalized = String(phone).replace(/\s+/g, '').replace(/[^0-9]/g, '');
    if (normalized.startsWith('0')) normalized = '254' + normalized.slice(1);
    if (normalized.startsWith('+254')) normalized = normalized.slice(1);
    if (normalized.startsWith('254') && normalized.length === 12) {
    } else if (normalized.length === 9) {
      normalized = '254' + normalized;
    } else {
      return res.status(400).json({ error: 'Invalid phone format' });
    }

    const token = await getAccessToken();
    const timestamp = generateTimestamp();
    const password = generatePassword(CONFIG.shortcode, CONFIG.passkey, timestamp);

    const payload = {
      BusinessShortCode: CONFIG.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: normalized,
      PartyB: CONFIG.shortcode,
      PhoneNumber: normalized,
      CallBackURL: CONFIG.callbackUrl,
      AccountReference: orderId,
      TransactionDesc: `Up & Cafe Order ${orderId}`,
    };

    const stkRes = await axios.post(`${BASE_URL}/mpesa/stkpush/v1/processrequest`, payload, {
      headers: { Authorization: `Bearer ${token}` },
    });

    pendingTransactions[stkRes.data.CheckoutRequestID] = {
      orderId,
      amount: Math.round(amount),
      phone: normalized,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    res.json({
      success: true,
      CheckoutRequestID: stkRes.data.CheckoutRequestID,
      ResponseDescription: stkRes.data.ResponseDescription,
      CustomerMessage: stkRes.data.CustomerMessage,
    });
  } catch (err) {
    console.error('STK Push error:', err.response?.data || err.message);
    res.status(500).json({ error: 'STK Push failed', details: err.response?.data?.errorMessage || err.message });
  }
});

app.post('/api/mpesa/callback', (req, res) => {
  try {
    const callback = req.body.Body?.stkCallback;
    if (!callback) return res.json({ ResultCode: 0, ResultDesc: 'Accepted' });

    const { CheckoutRequestID, ResultCode, ResultDesc, CallbackMetadata } = callback;
    const txn = pendingTransactions[CheckoutRequestID];

    if (txn) {
      if (ResultCode === 0) {
        const metadata = CallbackMetadata?.Item || [];
        txn.status = 'success';
        txn.receipt = metadata.find(i => i.Name === 'MpesaReceiptNumber')?.Value;
        txn.paidAmount = metadata.find(i => i.Name === 'Amount')?.Value;
        txn.completedAt = new Date().toISOString();
        console.log(`SUCCESS: ${txn.orderId} | Receipt: ${txn.receipt}`);
      } else {
        txn.status = 'failed';
        txn.reason = ResultDesc;
        txn.completedAt = new Date().toISOString();
        console.log(`FAILED: ${txn.orderId} | Reason: ${ResultDesc}`);
      }
    }
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

app.get('/api/mpesa/status/:checkoutRequestId', (req, res) => {
  const txn = pendingTransactions[req.params.checkoutRequestId];
  if (!txn) return res.status(404).json({ error: 'Not found' });
  res.json({ status: txn.status, orderId: txn.orderId, receipt: txn.receipt || null, amount: txn.amount, reason: txn.reason || null });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
