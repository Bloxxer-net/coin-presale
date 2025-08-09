// BLOXXER Presale Server
import express from "express";
import "dotenv/config";
import {
    ApiError,
    Client,
    Environment,
    LogLevel,
    OrdersController,
} from "@paypal/paypal-server-sdk";
import bodyParser from "body-parser";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import crypto from "crypto";
import cors from "cors";
import { createObjectCsvWriter } from "csv-writer";
import { v4 as uuidv4 } from 'uuid';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));
app.use(bodyParser.json());

// PayPal Setup
const client = new Client({
    clientCredentialsAuthCredentials: {
        oAuthClientId: process.env.PAYPAL_CLIENT_ID,
        oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
    },
    environment: Environment.Sandbox,
    logging: { logLevel: LogLevel.Info },
});
const ordersController = new OrdersController(client);

// Hilfsfunktionen
//const readJsonFile = async filePath => JSON.parse(await fs.readFile(filePath, "utf8"));
//const writeJsonFile = async (filePath, data) => fs.writeFile(filePath, JSON.stringify(data, null, 2));
const generateId = () => crypto.randomUUID();
const maskWalletAddress = address => address?.length > 10 ? address.slice(0, 6) + "..." + address.slice(-4) : address;

app.use(bodyParser.json());

const DATA_DIR = './data';
const FILES = {
  config: path.join(DATA_DIR, 'config.json'),
  purchases: path.join(DATA_DIR, 'purchases.json'),
  stats: path.join(DATA_DIR, 'stats.json'),
  priceCache: path.join(DATA_DIR, 'priceCache.json'),
  purchasesCsv: path.join(DATA_DIR, 'purchases.csv')
};

async function readJsonFile(filePath) {
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

async function getCurrentConfig() {
  return await readJsonFile(FILES.config);
}

function getLondonMidnightISOString() {
    var event = new Date();
console.log(event.toLocaleString('en-GB', { timeZone: 'Europe/London' }));
  const now = new Date();
  const londonOffset = -60; // UTC+1 in minutes (Daylight Saving Time)
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  utcMidnight.setUTCMinutes(utcMidnight.getUTCMinutes() - londonOffset);
  return utcMidnight.toISOString().split('T')[0];
}

async function getCachedPriceOrCalculate(fundingZiel, coinStartpreis, coinEndpreis, insgesamtVerkauft) {
  const today = getLondonMidnightISOString();
  let cache = await readJsonFile(FILES.priceCache) || {};

  if (cache.date === today && cache.price) {
    return cache.price;
  }

  const finalPrice = (insgesamtVerkauft / fundingZiel) * (coinEndpreis - coinStartpreis) + coinStartpreis;

  cache = { date: today, price: finalPrice };
  await writeJsonFile(FILES.priceCache, cache);

  return finalPrice;
}

async function calculateCoinPrice(){
  const config = await getCurrentConfig();
  const stats = await readJsonFile(FILES.stats) || {};

  const fundingZiel = config.fundingGoal;
  const coinStartpreis = config.coinStartPrice;
  const coinEndpreis = config.coinEndPrice;
  const insgesamtVerkauft = stats.totalRaisedEur;
  return await getCachedPriceOrCalculate(fundingZiel, coinStartpreis, coinEndpreis, insgesamtVerkauft);
}

async function calculateSellingPrice(coinAmount) {
  const unitPrice = await calculateCoinPrice();
  const totalPrice = unitPrice * coinAmount;

  return {
    coinAmount: parseInt(coinAmount),
    unitPrice: parseFloat(unitPrice.toFixed(2)),
    totalPrice: parseFloat(totalPrice.toFixed(2)),
    currency: 'EUR'
  };
}

async function checkDailyLimit(totalPrice) {
  const purchases = await readJsonFile(FILES.purchases) || [];
  const today = getLondonMidnightISOString();
  const todaysPurchases = purchases.filter(p => p.timestamp.startsWith(today));
  const dailyTotal = todaysPurchases.reduce((sum, p) => sum + (p.totalPrice || 0), 0);
  return {
    allowed: (dailyTotal + totalPrice) <= 500000,
    dailyTotal: dailyTotal.toFixed(2),
    limit: 500000
  };
}

async function appendToCSV(purchase) {
  const csvWriter = createObjectCsvWriter({
    path: FILES.purchasesCsv,
    header: [
      { id: 'id', title: 'ID' },
      { id: 'walletAddress', title: 'Wallet Address' },
      { id: 'walletType', title: 'Wallet Type' },
      { id: 'buyerEmail', title: 'Buyer Email' },
      { id: 'coinAmount', title: 'Coin Amount' },
      { id: 'totalPrice', title: 'Total Price (€)' },
      { id: 'paymentMethod', title: 'Payment Method' },
      { id: 'paypalOrderId', title: 'PayPal Order ID' },
      { id: 'timestamp', title: 'Timestamp' }
    ],
    append: fsSync.existsSync(FILES.purchasesCsv)
  });

  await csvWriter.writeRecords([purchase]);
}

async function savePurchase(purchase) {
  const purchases = await readJsonFile(FILES.purchases) || [];
  purchases.push(purchase);
  await writeJsonFile(FILES.purchases, purchases);
  await appendToCSV(purchase);

  const stats = await readJsonFile(FILES.stats) || { totalRaisedEur: 0 };
  stats.totalRaisedEur += purchase.totalPrice;
  await writeJsonFile(FILES.stats, stats);
}

app.post('/api/purchase', async (req, res) => {
  try {
    const { walletAddress, walletType, buyerEmail, coinAmount, paymentMethod, paypalOrderId } = req.body;

    if (!walletAddress || !walletType || !buyerEmail || !coinAmount || !paymentMethod || !paypalOrderId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const pricing = await calculateSellingPrice(coinAmount);
    const dailyLimit = await checkDailyLimit(pricing.totalPrice);
    if (!dailyLimit.allowed) {
      return res.status(400).json({ error: `Tageslimit erreicht. Heute wurden bereits €${dailyLimit.dailyTotal} verkauft.` });
    }

    const purchase = {
      id: uuidv4(),
      walletAddress,
      walletType,
      buyerEmail,
      coinAmount: pricing.coinAmount,
      totalPrice: pricing.totalPrice,
      paymentMethod,
      paypalOrderId,
      timestamp: new Date().toISOString()
    };

    await savePurchase(purchase);
    res.json({ success: true, purchase });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PayPal Order erstellen + erfassen
async function createPayPalOrder(coinAmount, currency = "EUR") {
    const pricing = await calculateSellingPrice(coinAmount);
    const order = {
        body: {
            intent: "CAPTURE",
            purchaseUnits: [
                {
                    amount: {
                        currencyCode: currency,
                        value: pricing.totalPrice.toString(),
                        breakdown: { itemTotal: { currencyCode: currency, value: pricing.totalPrice.toString() } }
                    },
                    items: [
                        {
                            name: "BLOXXER Coins",
                            unitAmount: { currencyCode: currency, value: pricing.unitPrice.toString() },
                            quantity: pricing.coinAmount.toString(),
                            description: `${pricing.coinAmount} BLOXXER Coins`,
                            sku: "BLOXXER_COIN"
                        }
                    ]
                }
            ]
        },
        prefer: "return=minimal"
    };
    const { body } = await ordersController.createOrder(order);
    return { jsonResponse: JSON.parse(body), pricing };
}

async function capturePayPalOrder(orderID) {
    const { body } = await ordersController.captureOrder({ id: orderID, prefer: "return=minimal" });
    return JSON.parse(body);
}

// API Routen
app.post("/api/paypal/create-order", async (req, res) => {
    try {
        const { coin_amount } = req.body;
        const { jsonResponse, pricing } = await createPayPalOrder(coin_amount);
        res.json({ success: true, data: { paypal_order: jsonResponse, pricing } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post("/api/paypal/capture-order", async (req, res) => {
    try {
        const { paypal_order_id, wallet_address, wallet_type, buyer_email, coin_amount } = req.body;
        const captured = await capturePayPalOrder(paypal_order_id);
        if (captured.status !== "COMPLETED") throw new Error("PayPal-Zahlung nicht abgeschlossen");
        const { purchase } = await processPurchase({ paypal_order_id, wallet_address, wallet_type, buyer_email, coin_amount, payment_method: "paypal" });
        res.json({ success: true, data: { purchase_id: purchase.id, wallet_address: maskWalletAddress(wallet_address), timestamp: purchase.timestamp } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/api/stats", async (req, res) => {
    try {
        const stats = await readJsonFile(FILES.stats);
        const config = await readJsonFile(FILES.config);
        const theCoinPrice = await calculateCoinPrice();
        console.log(theCoinPrice);
        res.json({ success: true, data: { ...stats, coin_price: theCoinPrice, presale_end_date: config.presaleEndDate } });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Initialisierung
async function initializeData() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const defaults = {
        config: {
            coinStartPrice: 0.02,
            coinEndPrice: 0.10,
            fundingGoal: 5500000,
            presaleEndDate: new Date(Date.now() + 30 * 86400000).toISOString(),
            minimumPurchase: 100,
            maximumPurchase: 1000000
        },
        stats: {
            totalCoinsSold: 0,
            totalRaisedEur: 0,
            totalPurchases: 0,
            lastUpdated: new Date().toISOString()
        }
    };
    if (!fsSync.existsSync(FILES.config)) await writeJsonFile(FILES.config, defaults.config);
    if (!fsSync.existsSync(FILES.stats)) await writeJsonFile(FILES.stats, defaults.stats);
    if (!fsSync.existsSync(FILES.purchases)) await writeJsonFile(FILES.purchases, []);
    if (!fsSync.existsSync(FILES.purchasesCsv)) await fs.writeFile(FILES.purchasesCsv, "ID,Wallet Address,Wallet Type,Buyer Email,Coin Amount,Total Price,Payment Method,PayPal Order ID,Timestamp\n");
}

// Start Server
initializeData().then(() => {
    app.listen(PORT, () => {
        console.log(`BLOXXER Server läuft auf http://localhost:${PORT}`);
    });
});
