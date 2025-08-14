// BLOXXER Presale Server (bereinigt)
// Verwendung: Node >= 18 empfohlen (crypto.randomUUID), ESM-Modus
import express from "express";
import dotenv from "dotenv";
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
import { v4 as uuidv4 } from "uuid";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use(bodyParser.json()); // weiterhin explizit, ist aber optional mit express.json()

// PayPal Setup (defensiv - passe an deine SDK-Version an)
const client = new Client({
  clientCredentialsAuthCredentials: {
    oAuthClientId: process.env.PAYPAL_CLIENT_ID,
    oAuthClientSecret: process.env.PAYPAL_CLIENT_SECRET,
  },
  environment: Environment.Live,
  logging: { logLevel: LogLevel.Info },
});
const ordersController = new OrdersController(client);

// Dateien / Pfade
const DATA_DIR = "./data";
const FILES = {
  config: path.join(DATA_DIR, "config.json"),
  purchases: path.join(DATA_DIR, "purchases.json"),
  stats: path.join(DATA_DIR, "stats.json"),
  priceCache: path.join(DATA_DIR, "priceCache.json"),
};

// Hilfsfunktionen
const generateId = () =>
  (typeof crypto !== "undefined" && crypto.randomUUID)
    ? crypto.randomUUID()
    : uuidv4();

const maskWalletAddress = (address) =>
  address?.length > 10 ? address.slice(0, 6) + "..." + address.slice(-5) : address;

// Einfaches Tagesdatum (YYYY-MM-DD). Wenn du strikt "London midnight" brauchst,
// sollten wir moment-timezone oder Intl.DateTimeFormat mit Europa/London verwenden.
// Hier genügt das Datum im ISO-Format.
function getISODate() {
  return new Date().toISOString().split("T")[0];
}

// JSON read/write mit Fallbacks
async function readJsonFile(filePath) {
  try {
    const data = await fs.readFile(filePath, "utf8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath, data) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2));
}

// Preisberechnung mit einfachem Cache pro Tag
async function getCachedPriceOrCalculate(
  fundingZiel,
  coinStartpreis,
  coinEndpreis,
  insgesamtVerkauft
) {
  const today = getISODate();
  let cache = (await readJsonFile(FILES.priceCache)) || {};

  if (cache.date === today && typeof cache.price === "number") {
    return cache.price;
  }

  // Sicherheitsfall: falls fundingZiel === 0, fallback auf Startpreis
  const finalPrice =
    fundingZiel && fundingZiel > 0
      ? ((insgesamtVerkauft || 0) / fundingZiel) *
          (coinEndpreis - coinStartpreis) +
        coinStartpreis
      : coinStartpreis;

  cache = { date: today, price: finalPrice };
  await writeJsonFile(FILES.priceCache, cache);

  return finalPrice;
}

async function calculateCoinPrice() {
  const config = (await readJsonFile(FILES.config)) || {};
  const stats = (await readJsonFile(FILES.stats)) || { totalRaisedEur: 0 };

  const fundingZiel = config.fundingGoal ?? 1; // Default 1 um Division durch 0 zu vermeiden
  const coinStartpreis = config.coinStartPrice ?? 0.025;
  const coinEndpreis = config.coinEndPrice ?? 0.1;
  const insgesamtVerkauft = stats.totalRaisedEur ?? 0;

  return await getCachedPriceOrCalculate(
    fundingZiel,
    coinStartpreis,
    coinEndpreis,
    insgesamtVerkauft
  );
}

// Liefert Preisangaben für einen gegebenen coinAmount
async function calculateSellingPrice(coinAmount) {
  // ensure numeric
  const amount = Number(coinAmount) || 0;
  const unitPrice = await calculateCoinPrice();
  const totalPrice = unitPrice * amount;

  return {
    coinAmount: Number.isInteger(amount) ? amount : parseFloat(amount.toFixed(8)),
    unitPrice: parseFloat(Number(unitPrice).toFixed(8)),
    totalPrice: parseFloat(totalPrice.toFixed(2)),
    currency: "EUR",
  };
}

// Validierung des Kaufs
async function validatePurchase(coinAmount, walletAddress) {
  const config = (await readJsonFile(FILES.config)) || {};
  const errors = [];

  if (!walletAddress) {
    errors.push("Wallet-Adresse ist erforderlich");
  }

  const unitPrice = await calculateCoinPrice();
  const purchasePrice = (Number(coinAmount) || 0) * unitPrice;

  if (!coinAmount || purchasePrice < (config.minimumPurchase || 0)) {
    errors.push(`Mindestbestellmenge: ${config.minimumPurchase ?? 0} EUR (oder entsprechend BLOXXER)`);
  }

  if (config.maximumPurchase && Number(coinAmount) > config.maximumPurchase) {
    errors.push(`Maximale Bestellmenge: ${config.maximumPurchase} BLOXXER Coins`);
  }

  if (config.presaleEndDate && new Date() > new Date(config.presaleEndDate)) {
    errors.push("Presale ist beendet");
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

// Statistiken aktualisieren (separat nutzbar)
async function updateStats(coinAmount, totalPrice) {
  const stats = (await readJsonFile(FILES.stats)) || {
    totalCoinsSold: 0,
    totalRaisedEur: 0,
    totalPurchases: 0,
    lastUpdated: new Date().toISOString(),
  };

  stats.totalCoinsSold = (stats.totalCoinsSold || 0) + Number(coinAmount || 0);
  stats.totalRaisedEur = (stats.totalRaisedEur || 0) + Number(totalPrice || 0);
  stats.totalPurchases = (stats.totalPurchases || 0) + 1;
  stats.lastUpdated = new Date().toISOString();

  await writeJsonFile(FILES.stats, stats);
  return stats;
}

// Speichert einen Kauf und gibt das gespeicherte Objekt zurück
async function savePurchase(purchase) {
  const purchases = (await readJsonFile(FILES.purchases)) || [];

  // Wenn caller bereits eine id mitgegeben hat, benutze diese, sonst generiere neue
  const id = purchase.id || generateId();

  const newPurchase = {
    id,
    walletAddress: purchase.walletAddress,
    walletType: purchase.walletType ?? "unknown",
    buyerEmail: purchase.buyerEmail ?? null,
    coinAmount: Number(purchase.coinAmount) || 0,
    totalPrice: Number(purchase.totalPrice) || 0,
    paymentMethod: purchase.paymentMethod ?? "unknown",
    paypalOrderId: purchase.paypalOrderId ?? null,
    timestamp: purchase.timestamp ?? new Date().toISOString(),
    status: purchase.status ?? "completed",
  };

  purchases.push(newPurchase);
  await writeJsonFile(FILES.purchases, purchases);

  // Update stats zentral (vermeidet doppelte Logik)
  await updateStats(newPurchase.coinAmount, newPurchase.totalPrice);

  return newPurchase;
}

// Tägliches Limit prüfen (z.B. 500k EUR)
async function checkDailyLimit(totalPrice) {
  const purchases = (await readJsonFile(FILES.purchases)) || [];
  const today = getISODate();
  const todaysPurchases = purchases.filter((p) => (p.timestamp || "").startsWith(today));
  const dailyTotal = todaysPurchases.reduce((sum, p) => sum + (Number(p.totalPrice) || 0), 0);
  const limit = 500000;
  return {
    allowed: dailyTotal + Number(totalPrice || 0) <= limit,
    dailyTotal: dailyTotal.toFixed(2),
    limit,
  };
}

// Komplette Kaufabwicklung (kann intern verwendet werden)
async function processPurchase(purchaseData) {
  const {
    wallet_address,
    coin_amount,
    payment_method,
    buyer_email,
    wallet_type,
    paypal_order_id,
  } = purchaseData;

  // 1. Validierung
  const validation = await validatePurchase(coin_amount, wallet_address);
  if (!validation.isValid) {
    throw new Error(validation.errors.join(", "));
  }

  // 2. Preis berechnen
  const pricing = await calculateSellingPrice(coin_amount);

  // 3. Kauf speichern
  const savedPurchase = await savePurchase({
    walletAddress: wallet_address,
    walletType: wallet_type || "unknown",
    buyerEmail: buyer_email || null,
    coinAmount: pricing.coinAmount,
    totalPrice: pricing.totalPrice,
    paymentMethod: payment_method,
    paypalOrderId: paypal_order_id || null,
  });

  return {
    purchase: savedPurchase,
    pricing,
  };
}

// PayPal Order erstellen (mit customId für Coin-Menge, camelCase fürs SDK)
async function createPayPalOrder(coinAmount, currency = "EUR") {
  const pricing = await calculateSellingPrice(coinAmount);

  // Währungswerte sauber auf 2 Nachkommastellen formatieren
  const amountValue = Number(pricing.totalPrice).toFixed(2);

  const order = {
    body: {
      intent: "CAPTURE",
      purchaseUnits: [
        {
          customId: String(coinAmount), // Menge Coins sicher mitgeben
          amount: {
            currencyCode: currency,
            value: amountValue,
            breakdown: {
              itemTotal: { currencyCode: currency, value: amountValue },
            },
          },
          items: [
            {
              name: "BLOXXER Coins Paket",
              unitAmount: { currencyCode: currency, value: amountValue },
              quantity: "1", // SDK akzeptiert String
              description: `${pricing.coinAmount} BLOXXER Coins Paket`,
              sku: "BLOXXER_COIN",
              category: "DIGITAL_GOODS", // optional, verhindert Shipping
            },
          ],
        },
      ],
      applicationContext: {
        shippingPreference: "NO_SHIPPING",
      },
    },
    prefer: "return=minimal",
  };

  const response = await ordersController.createOrder(order);

  // defensiv parsen (SDK liefert i.d.R. { body })
  let jsonResponse;
  if (response && typeof response === "object" && response.body) {
    try {
      jsonResponse = typeof response.body === "string" ? JSON.parse(response.body) : response.body;
    } catch {
      jsonResponse = response.body;
    }
  } else {
    jsonResponse = response;
  }

  return { jsonResponse, pricing };
}

async function capturePayPalOrder(orderID) {
  const response = await ordersController.captureOrder({ id: orderID, prefer: "return=minimal" });
  if (response && typeof response === "object" && response.body) {
    try {
      return typeof response.body === "string" ? JSON.parse(response.body) : response.body;
    } catch {
      return response.body;
    }
  }
  return response;
}

// --- Routen (bestehende Routen erhalten) ---

// Direktes Kauf-API (z.B. für Banküberweisungen oder andere Zahlarten)
// Hinweis: paypalOrderId ist optional (nur bei PayPal-Käufen notwendig)
app.post("/api/purchase", async (req, res) => {
  try {
    const { walletAddress, walletType, buyerEmail, coinAmount, paymentMethod, paypalOrderId } = req.body;

    // Minimale erforderliche Felder
    if (!walletAddress || !coinAmount || !paymentMethod) {
      return res.status(400).json({ error: "Missing required fields: walletAddress, coinAmount, paymentMethod" });
    }

    const pricing = await calculateSellingPrice(coinAmount);
    const dailyLimit = await checkDailyLimit(pricing.totalPrice);
    if (!dailyLimit.allowed) {
      return res
        .status(400)
        .json({ error: `Tageslimit erreicht. Heute wurden bereits €${dailyLimit.dailyTotal} verkauft.` });
    }

    const purchaseToSave = {
      id: uuidv4(),
      walletAddress,
      walletType,
      buyerEmail,
      coinAmount: pricing.coinAmount,
      totalPrice: pricing.totalPrice,
      paymentMethod,
      paypalOrderId: paypalOrderId || null,
      timestamp: new Date().toISOString(),
    };

    const saved = await savePurchase(purchaseToSave);

    res.json({ success: true, purchase: saved });
  } catch (err) {
    console.error("Error /api/purchase:", err);
    res.status(500).json({ error: err?.message ?? "Unknown error" });
  }
});

app.get("/api/purchases", async (req, res) => {
  try {
    const purchases = (await readJsonFile(FILES.purchases)) || [];

    // Maske Wallet-Adressen
    const maskedPurchases = purchases.map(p => ({
      ...p,
      walletAddress: maskWalletAddress(p.walletAddress)
    }));

    res.json({
      success: true,
      data: maskedPurchases
    });
  } catch (err) {
    console.error("Error /api/purchases:", err);
    res.status(500).json({ success: false, error: err?.message ?? "Unknown error" });
  }
});

// PayPal: Create Order
app.post("/api/paypal/create-order", async (req, res) => {
  try {
    const { coin_amount } = req.body;
    if (!coin_amount) return res.status(400).json({ success: false, error: "coin_amount required" });

    const { jsonResponse, pricing } = await createPayPalOrder(coin_amount);
    res.json({ success: true, data: { paypal_order: jsonResponse, pricing } });
  } catch (err) {
    console.error("Error /api/paypal/create-order:", err);
    res.status(500).json({ success: false, error: err?.message ?? "Unknown error" });
  }
});

// PayPal: Capture Order + finaler Save
app.post("/api/paypal/capture-order", async (req, res) => {
  try {
    const { paypal_order_id, wallet_address, wallet_type, buyer_email } = req.body;
    if (!paypal_order_id) {
      return res.status(400).json({ success: false, error: "paypal_order_id required" });
    }

    const captured = await capturePayPalOrder(paypal_order_id);

    // Status prüfen
    const status =
      captured?.status ??
      (captured?.purchaseUnits && captured?.purchaseUnits[0]?.payments ? "COMPLETED" : undefined) ??
      (captured?.purchase_units && captured?.purchase_units[0]?.payments ? "COMPLETED" : undefined);

    if (status !== "COMPLETED") {
      return res.status(400).json({ success: false, error: "PayPal-Zahlung nicht abgeschlossen" });
    }

    // Menge aus customId (camelCase) oder custom_id (fallback)
    const pu =
      captured?.purchaseUnits?.[0] ??
      captured?.purchase_units?.[0];

    let finalCoinAmount = null;
    if (pu?.customId) finalCoinAmount = parseInt(pu.customId, 10);
    else if (pu?.custom_id) finalCoinAmount = parseInt(pu.custom_id, 10);

    if (!finalCoinAmount || Number.isNaN(finalCoinAmount)) {
      return res.status(400).json({ success: false, error: "Coin-Menge konnte nicht ermittelt werden" });
    }

    const { purchase } = await processPurchase({
      paypal_order_id,
      wallet_address,
      wallet_type,
      buyer_email,
      coin_amount: finalCoinAmount,
      payment_method: "paypal",
    });

    res.json({
      success: true,
      data: {
        purchase_id: purchase.id,
        wallet_address: maskWalletAddress(purchase.walletAddress),
        timestamp: purchase.timestamp,
      },
    });
  } catch (err) {
    console.error("Error /api/paypal/capture-order:", err);
    res.status(500).json({ success: false, error: err?.message ?? "Unknown error" });
  }
});

// Stats Endpoint
app.get("/api/stats", async (req, res) => {
  try {
    const stats = (await readJsonFile(FILES.stats)) || {};
    const config = (await readJsonFile(FILES.config)) || {};
    const theCoinPrice = await calculateCoinPrice();

    res.json({
      success: true,
      data: { ...stats, coin_price: theCoinPrice, presale_end_date: config.presaleEndDate },
    });
  } catch (err) {
    console.error("Error /api/stats:", err);
    res.status(500).json({ success: false, error: err?.message ?? "Unknown error" });
  }
});

// Initialisierung bei Start
async function initializeData() {
  await fs.mkdir(DATA_DIR, { recursive: true });

  const defaults = {
    config: {
      coinStartPrice: 0.025,
      coinEndPrice: 0.1,
      fundingGoal: 5500000,
      presaleEndDate: new Date(Date.now() + 30 * 86400000).toISOString(),
      minimumPurchase: 5,
      maximumPurchase: 500000,
    },
    stats: {
      totalCoinsSold: 0,
      totalRaisedEur: 0,
      totalPurchases: 0,
      lastUpdated: new Date().toISOString(),
    },
  };

  if (!fsSync.existsSync(FILES.config)) await writeJsonFile(FILES.config, defaults.config);
  if (!fsSync.existsSync(FILES.stats)) await writeJsonFile(FILES.stats, defaults.stats);
  if (!fsSync.existsSync(FILES.purchases)) await writeJsonFile(FILES.purchases, []);
  if (!fsSync.existsSync(FILES.priceCache)) await writeJsonFile(FILES.priceCache, {});
}

// Start
initializeData().then(() => {
  app.listen(PORT, () => {
    console.log(`BLOXXER Server läuft auf http://localhost:${PORT}`);
  });
});
