import express from "express";
import "dotenv/config";
import {
    ApiError,
    Client,
    Environment,
    LogLevel,
    OrdersController,
    PaymentsController,
} from "@paypal/paypal-server-sdk";
import bodyParser from "body-parser";
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public'));
app.use(bodyParser.json());

// Datenverzeichnis
const DATA_DIR = path.join(process.cwd(), 'data');

// Datei-Pfade
const FILES = {
    purchases: path.join(DATA_DIR, 'purchases.json'),
    stats: path.join(DATA_DIR, 'stats.json'),
    config: path.join(DATA_DIR, 'config.json')
};

// PayPal Client Setup
const {
    PAYPAL_CLIENT_ID,
    PAYPAL_CLIENT_SECRET,
} = process.env;

const client = new Client({
    clientCredentialsAuthCredentials: {
        oAuthClientId: PAYPAL_CLIENT_ID,
        oAuthClientSecret: PAYPAL_CLIENT_SECRET,
    },
    timeout: 0,
    environment: Environment.Sandbox,
    logging: {
        logLevel: LogLevel.Info,
        logRequest: { logBody: true },
        logResponse: { logHeaders: true },
    },
});

const ordersController = new OrdersController(client);
const paymentsController = new PaymentsController(client);

// ===========================================
// UTILITY FUNCTIONS
// ===========================================

// Hilfsfunktionen für Dateizugriff
async function readJsonFile(filePath) {
    try {
        const data = await fs.readFile(filePath, 'utf8');
        return JSON.parse(data);
    } catch (error) {
        console.error(`Fehler beim Lesen von ${filePath}:`, error);
        return null;
    }
}

async function writeJsonFile(filePath, data) {
    try {
        await fs.writeFile(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (error) {
        console.error(`Fehler beim Schreiben von ${filePath}:`, error);
        return false;
    }
}

function maskWalletAddress(address) {
    if (!address || address.length <= 10) return address;
    return address.substring(0, 6) + '...' + address.substring(address.length - 4);
}

function generateId() {
    return crypto.randomUUID();
}

// ===========================================
// BUSINESS LOGIC FUNCTIONS
// ===========================================

// Aktuelle Konfiguration laden
async function getCurrentConfig() {
    const config = await readJsonFile(FILES.config);
    if (!config) {
        throw new Error('Konfiguration nicht verfügbar');
    }
    return config;
}

// Coin-Preis berechnen
async function calculateCoinPrice(coinAmount) {
    const config = await getCurrentConfig();
    console.log('[CONFIG]', config);
    const totalPrice = coinAmount * config.coinPrice;
    return {
        coinAmount: parseInt(coinAmount),
        unitPrice: config.coinPrice,
        totalPrice: parseFloat(totalPrice.toFixed(2)),
        currency: 'EUR'
    };
}

// Kauf validieren
async function validatePurchase(coinAmount, walletAddress) {
    const config = await getCurrentConfig();
    
    const errors = [];
    
    if (!walletAddress) {
        errors.push('Wallet-Adresse ist erforderlich');
    }
    
    if (!coinAmount || coinAmount < config.minimumPurchase) {
        errors.push(`Mindestbestellmenge: ${config.minimumPurchase} BLOXXER Coins`);
    }
    
    if (coinAmount > config.maximumPurchase) {
        errors.push(`Maximale Bestellmenge: ${config.maximumPurchase} BLOXXER Coins`);
    }
    
    // Presale-Ende prüfen
    if (new Date() > new Date(config.presaleEndDate)) {
        errors.push('Presale ist beendet');
    }
    
    return {
        isValid: errors.length === 0,
        errors
    };
}

// Statistiken aktualisieren
async function updateStats(coinAmount, totalPrice) {
    const stats = await readJsonFile(FILES.stats);
    if (stats) {
        stats.totalCoinsSold += coinAmount;
        stats.totalRaisedEur += totalPrice;
        stats.totalPurchases += 1;
        stats.lastUpdated = new Date().toISOString();
        
        await writeJsonFile(FILES.stats, stats);
        return stats;
    }
    return null;
}

// Kauf in Datenbank speichern
async function savePurchase(purchaseData) {
    const purchases = await readJsonFile(FILES.purchases) || [];
    
    const newPurchase = {
        id: generateId(),
        ...purchaseData,
        timestamp: new Date().toISOString(),
        status: 'completed'
    };
    
    purchases.push(newPurchase);
    
    const saved = await writeJsonFile(FILES.purchases, purchases);
    if (!saved) {
        throw new Error('Fehler beim Speichern des Kaufs');
    }
    
    return newPurchase;
}

// Vollständige Kaufabwicklung
async function processPurchase(purchaseData) {
    const { wallet_address, coin_amount, payment_method, buyer_email, wallet_type, paypal_order_id } = purchaseData;
    
    // 1. Validierung
    const validation = await validatePurchase(coin_amount, wallet_address);
    if (!validation.isValid) {
        throw new Error(validation.errors.join(', '));
    }
    
    // 2. Preis berechnen
    const pricing = await calculateCoinPrice(coin_amount);
    
    // 3. Kauf speichern
    const savedPurchase = await savePurchase({
        walletAddress: wallet_address,
        walletType: wallet_type || 'unknown',
        buyerEmail: buyer_email || null,
        coinAmount: pricing.coinAmount,
        totalPrice: pricing.totalPrice,
        paymentMethod: payment_method,
        paypalOrderId: paypal_order_id || null
    });
    
    // 4. Statistiken aktualisieren
    await updateStats(pricing.coinAmount, pricing.totalPrice);
    
    return {
        purchase: savedPurchase,
        pricing
    };
}

// ===========================================
// PAYPAL FUNCTIONS
// ===========================================

// PayPal Order erstellen
async function createPayPalOrder(coinAmount, currency = 'EUR') {
    const pricing = await calculateCoinPrice(coinAmount);
    
    const collect = {
        body: {
            intent: "CAPTURE",
            purchaseUnits: [
                {
                    amount: {
                        currencyCode: currency,
                        value: pricing.totalPrice.toString(),
                        breakdown: {
                            itemTotal: {
                                currencyCode: currency,
                                value: pricing.totalPrice.toString(),
                            },
                        },
                    },
                    items: [
                        {
                            name: "BLOXXER Coins",
                            unitAmount: {
                                currencyCode: currency,
                                value: pricing.unitPrice.toString(),
                            },
                            quantity: pricing.coinAmount.toString(),
                            description: `${pricing.coinAmount} BLOXXER Coins zum Presale-Preis`,
                            sku: "BLOXXER_COIN",
                        },
                    ],
                },
            ],
        },
        prefer: "return=minimal",
    };

    try {
        const { body, ...httpResponse } = await ordersController.createOrder(collect);
        return {
            jsonResponse: JSON.parse(body),
            httpStatusCode: httpResponse.statusCode,
            pricing
        };
    } catch (error) {
        if (error instanceof ApiError) {
            throw new Error(`PayPal API Error: ${error.message}`);
        }
        throw error;
    }
}

// PayPal Order erfassen
async function capturePayPalOrder(orderID) {
    const collect = {
        id: orderID,
        prefer: "return=minimal",
    };

    try {
        const { body, ...httpResponse } = await ordersController.captureOrder(collect);
        return {
            jsonResponse: JSON.parse(body),
            httpStatusCode: httpResponse.statusCode,
        };
    } catch (error) {
        if (error instanceof ApiError) {
            throw new Error(`PayPal Capture Error: ${error.message}`);
        }
        throw error;
    }
}

// ===========================================
// INITIALIZATION
// ===========================================

async function initializeData() {
    try {
        await fs.mkdir(DATA_DIR, { recursive: true });

        const defaultConfig = {
            coinPrice: 0.05,
            presaleEndDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            minimumPurchase: 100,
            maximumPurchase: 1000000
        };

        const defaultStats = {
            totalCoinsSold: 125000,
            totalRaisedEur: 6250.00,
            totalPurchases: 0,
            lastUpdated: new Date().toISOString()
        };

        for (const [key, filePath] of Object.entries(FILES)) {
            try {
                await fs.access(filePath);
            } catch (error) {
                let defaultData = [];
                if (key === 'stats') defaultData = defaultStats;
                if (key === 'config') defaultData = defaultConfig;
                
                await writeJsonFile(filePath, defaultData);
                console.log(`Datei erstellt: ${filePath}`);
            }
        }

        console.log('Dateninitialisierung abgeschlossen');
    } catch (error) {
        console.error('Fehler bei Dateninitialisierung:', error);
    }
}

// ===========================================
// API ROUTES
// ===========================================

// GET /api/stats - Statistiken abrufen
app.get('/api/stats', async (req, res) => {
    try {
        const stats = await readJsonFile(FILES.stats);
        const config = await readJsonFile(FILES.config);
        
        if (!stats || !config) {
            return res.status(500).json({
                success: false,
                error: 'Fehler beim Laden der Statistiken'
            });
        }

        res.json({
            success: true,
            data: {
                total_coins_sold: stats.totalCoinsSold,
                total_raised_eur: stats.totalRaisedEur,
                total_purchases: stats.totalPurchases,
                coin_price: config.coinPrice,
                presale_end_date: config.presaleEndDate,
                minimum_purchase: config.minimumPurchase,
                maximum_purchase: config.maximumPurchase,
                last_updated: stats.lastUpdated
            }
        });
    } catch (error) {
        console.error('Fehler bei /api/stats:', error);
        res.status(500).json({
            success: false,
            error: 'Serverfehler beim Laden der Statistiken'
        });
    }
});

// GET /api/config - Konfiguration abrufen
app.get('/api/config', async (req, res) => {
    try {
        const config = await getCurrentConfig();
        res.json({
            success: true,
            data: config
        });
    } catch (error) {
        console.error('Fehler bei /api/config:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// POST /api/calculate-price - Preis berechnen (für Frontend)
app.post('/api/calculate-price', async (req, res) => {
    try {
        const { coin_amount } = req.body;
        
        if (!coin_amount || coin_amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Ungültige Coin-Anzahl'
            });
        }

        const pricing = await calculateCoinPrice(coin_amount);
        
        res.json({
            success: true,
            data: pricing
        });
    } catch (error) {
        console.error('Fehler bei /api/calculate-price:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// POST /api/validate-purchase - Kauf validieren (für Frontend)
app.post('/api/validate-purchase', async (req, res) => {
    try {
        const { coin_amount, wallet_address } = req.body;
        
        const validation = await validatePurchase(coin_amount, wallet_address);
        
        if (validation.isValid) {
            const pricing = await calculateCoinPrice(coin_amount);
            res.json({
                success: true,
                valid: true,
                data: pricing
            });
        } else {
            res.status(400).json({
                success: false,
                valid: false,
                errors: validation.errors
            });
        }
    } catch (error) {
        console.error('Fehler bei /api/validate-purchase:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===========================================
// PAYPAL ROUTES
// ===========================================

// POST /api/paypal/create-order - PayPal Order erstellen
app.post('/api/paypal/create-order', async (req, res) => {
    try {
        const { coin_amount } = req.body;
        
        if (!coin_amount || coin_amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Ungültige Coin-Anzahl'
            });
        }

        // Validierung vor PayPal Order
        const validation = await validatePurchase(coin_amount, 'temp'); // Wallet wird später validiert
        if (!validation.isValid) {
            return res.status(400).json({
                success: false,
                error: validation.errors.join(', ')
            });
        }

        const { jsonResponse, httpStatusCode, pricing } = await createPayPalOrder(coin_amount);
        
        res.status(httpStatusCode).json({
            success: true,
            data: {
                paypal_order: jsonResponse,
                pricing: pricing
            }
        });
    } catch (error) {
        console.error('Fehler bei PayPal Order erstellen:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// POST /api/paypal/capture-order - PayPal Order erfassen und Kauf abschließen
app.post('/api/paypal/capture-order', async (req, res) => {
    try {
        const { 
            paypal_order_id, 
            wallet_address, 
            wallet_type, 
            buyer_email, 
            coin_amount 
        } = req.body;

        if (!paypal_order_id || !wallet_address || !coin_amount) {
            return res.status(400).json({
                success: false,
                error: 'Fehlende erforderliche Felder'
            });
        }

        // 1. PayPal Order erfassen
        const { jsonResponse, httpStatusCode } = await capturePayPalOrder(paypal_order_id);
        
        if (httpStatusCode !== 201 || jsonResponse.status !== 'COMPLETED') {
            return res.status(400).json({
                success: false,
                error: 'PayPal-Zahlung konnte nicht abgeschlossen werden'
            });
        }

        // 2. Kauf verarbeiten
        const { purchase, pricing } = await processPurchase({
            wallet_address,
            wallet_type,
            buyer_email,
            coin_amount: parseInt(coin_amount),
            payment_method: 'paypal',
            paypal_order_id
        });

        res.json({
            success: true,
            data: {
                purchase_id: purchase.id,
                coins_purchased: purchase.coinAmount,
                total_price: purchase.totalPrice,
                wallet_address: maskWalletAddress(wallet_address),
                timestamp: purchase.timestamp,
                paypal_order_id: paypal_order_id
            },
            message: 'Kauf erfolgreich über PayPal abgeschlossen'
        });

        console.log(`PayPal Kauf: ${purchase.coinAmount} BLOXXER für €${purchase.totalPrice} (${maskWalletAddress(wallet_address)})`);

    } catch (error) {
        console.error('Fehler bei PayPal Capture:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ===========================================
// DIRECT PURCHASE ROUTE (für andere Zahlungsmethoden)
// ===========================================

// POST /api/purchases - Direkter Kauf (z.B. für Krypto-Zahlungen)
app.post('/api/purchases', async (req, res) => {
    try {
        const {
            wallet_address,
            wallet_type,
            buyer_email,
            coin_amount,
            payment_method
        } = req.body;

        if (!wallet_address || !coin_amount || !payment_method) {
            return res.status(400).json({
                success: false,
                error: 'Fehlende erforderliche Felder'
            });
        }

        const { purchase, pricing } = await processPurchase({
            wallet_address,
            wallet_type,
            buyer_email,
            coin_amount: parseInt(coin_amount),
            payment_method
        });

        res.json({
            success: true,
            data: {
                purchase_id: purchase.id,
                coins_purchased: purchase.coinAmount,
                total_price: purchase.totalPrice,
                wallet_address: maskWalletAddress(wallet_address),
                timestamp: purchase.timestamp
            },
            message: 'Kauf erfolgreich verarbeitet'
        });

        console.log(`Direkter Kauf: ${purchase.coinAmount} BLOXXER für €${purchase.totalPrice} (${maskWalletAddress(wallet_address)})`);

    } catch (error) {
        console.error('Fehler bei direktem Kauf:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Health Check
app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Server starten
async function startServer() {
    await initializeData();
    
    app.listen(PORT, () => {
        console.log(`🚀 BLOXXER Backend Server läuft auf Port ${PORT}`);
        console.log(`📁 Daten werden gespeichert in: ${DATA_DIR}`);
        console.log(`🌐 API verfügbar unter: http://localhost:${PORT}/api/`);
        console.log(`💳 PayPal Integration: ${PAYPAL_CLIENT_ID ? 'Aktiviert' : 'Nicht konfiguriert'}`);
    });
}

startServer().catch(error => {
    console.error('Fehler beim Starten des Servers:', error);
    process.exit(1);
});