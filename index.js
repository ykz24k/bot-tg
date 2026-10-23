/**
 * ============================================================================
 * 🚀 USERBOT EXTRACTOR ENTERPRISE ULTIMATE PRO (V7.3 SMART EMOJI FIX) 🚀
 * ============================================================================
 * - Scraping universal y multicanal en tiempo real.
 * - Captura absoluta de TODAS las respuestas (Live + Declined + Risk Bin).
 * - Algoritmo de Luhn para validación matemática de tarjetas bancarias.
 * - Memoria contextual de 3 niveles para extraer la CC de 16 dígitos enteros.
 * - Sanitizador inteligente de emojis: Reemplaza checks engañosos en declines.
 * - Persistencia de caché en disco y cola de mensajes anti-FloodWait.
 * ============================================================================
 */

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { StoreSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { EditedMessage } = require("telegram/events/EditedMessage");
const input = require("input");

// ============================================================================
// 1. CONFIGURACIÓN INICIAL Y VARIABLES DE ENTORNO
// ============================================================================
const apiId = parseInt(process.env.API_ID, 10);
const apiHash = process.env.API_HASH;
const forwardTarget = process.env.FORWARD_TO || "me";

if (!apiId || !apiHash) {
    console.error("[FATAL] ❌ Las variables API_ID y API_HASH son obligatorias en el archivo .env");
    process.exit(1);
}

const parseEnvArray = (envVar) => (envVar || "").split(",").map(id => id.trim()).filter(Boolean);
const targetGroups = parseEnvArray(process.env.TARGET_GROUPS);

const CACHE_TTL_MS = 1000 * 60 * 60 * (parseInt(process.env.CACHE_TTL_HOURS, 10) || 6);
const MSG_CACHE_TTL_MS = 1000 * 60 * (parseInt(process.env.MSG_CACHE_MINUTES, 10) || 60);
const RATE_LIMIT_DELAY = parseInt(process.env.RATE_LIMIT_DELAY_MS, 10) || 1200;

const storeSession = new StoreSession("session_userbot");

// ============================================================================
// 2. EXPRESIONES REGULARES Y ESTRUCTURAS DE DATOS EN MEMORIA
// ============================================================================
const CC_REGEX = /\b(\d{15,16})[^\w\d]*(\d{2})[^\w\d]*(\d{2,4})[^\w\d]*(\d{3,4})\b/g;

const sentCardsCache = new Map();
const messageCache = new Map();
const groupNameCache = new Map();

const stats = {
    startTime: Date.now(),
    processedMessages: 0,
    botResponsesCaptured: 0,
    rawScrapesCaptured: 0,
    totalCCsExtracted: 0,
    errorsEncountered: 0
};

const CACHE_FILE_PATH = path.join(__dirname, "sent_cards_cache.json");

// ============================================================================
// 3. COLA DE MENSAJES ANTI-FLOODWAIT (RATE-LIMITING)
// ============================================================================
class TelegramMessageQueue {
    constructor(client) {
        this.client = client;
        this.queue = [];
        this.isProcessing = false;
    }

    async enqueue(target, messagePayload) {
        this.queue.push({ target, messagePayload });
        this.processQueue();
    }

    async processQueue() {
        if (this.isProcessing || this.queue.length === 0) return;
        this.isProcessing = true;

        while (this.queue.length > 0) {
            const item = this.queue.shift();
            try {
                await this.client.sendMessage(item.target, item.messagePayload);
            } catch (err) {
                stats.errorsEncountered++;
                console.error(`[!] Error al entregar mensaje en cola: ${err.message}`);
                
                if (err.message.includes("FLOOD_WAIT")) {
                    const waitSeconds = parseInt(err.message.replace(/[^0-9]/g, ""), 10) || 15;
                    console.warn(`[⚠️] Alerta FloodWait detectada. Pausando envío durante ${waitSeconds} segundos...`);
                    await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
                }
            }
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
        }

        this.isProcessing = false;
    }
}

let messageQueueInstance = null;

// ============================================================================
// 4. PERSISTENCIA EN DISCO Y MANTENIMIENTO DE CACHÉ
// ============================================================================
function loadDiskCache() {
    try {
        if (fs.existsSync(CACHE_FILE_PATH)) {
            const rawData = fs.readFileSync(CACHE_FILE_PATH, "utf-8");
            const parsed = JSON.parse(rawData);
            const now = Date.now();
            let restoredCount = 0;
            
            for (const [cc, timestamp] of Object.entries(parsed)) {
                if (now - timestamp < CACHE_TTL_MS) {
                    sentCardsCache.set(cc, timestamp);
                    restoredCount++;
                }
            }
            console.log(`[💾] Caché restaurada desde disco: ${restoredCount} registros activos cargados.`);
        }
    } catch (error) {
        console.error(`[!] Error al cargar caché de disco: ${error.message}`);
    }
}

function saveDiskCache() {
    try {
        const cacheObject = {};
        for (const [cc, timestamp] of sentCardsCache.entries()) {
            cacheObject[cc] = timestamp;
        }
        fs.writeFileSync(CACHE_FILE_PATH, JSON.stringify(cacheObject, null, 2), "utf-8");
    } catch (error) {
        console.error(`[!] Error al guardar caché en disco: ${error.message}`);
    }
}

function performCacheMaintenance() {
    const now = Date.now();
    let cardsCleaned = 0;
    let messagesCleaned = 0;

    for (const [cc, timestamp] of sentCardsCache.entries()) {
        if (now - timestamp > CACHE_TTL_MS) {
            sentCardsCache.delete(cc);
            cardsCleaned++;
        }
    }

    for (const [key, data] of messageCache.entries()) {
        if (now - data.timestamp > MSG_CACHE_TTL_MS) {
            messageCache.delete(key);
            messagesCleaned++;
        }
    }

    if (cardsCleaned > 0 || messagesCleaned > 0) {
        saveDiskCache();
    }
}

// ============================================================================
// 5. VALIDACIONES Y CORRECCIÓN INTELIGENTE DE EMOJIS
// ============================================================================

function isValidLuhn(cardNumber) {
    let sum = 0;
    let shouldDouble = false;
    for (let i = cardNumber.length - 1; i >= 0; i--) {
        let digit = parseInt(cardNumber.charAt(i), 10);
        if (shouldDouble) {
            if ((digit *= 2) > 9) digit -= 9;
        }
        sum += digit;
        shouldDouble = !shouldDouble;
    }
    return (sum % 10) === 0;
}

function extractAndCleanCCs(text) {
    if (!text) return [];
    const matches = [];
    let match;
    CC_REGEX.lastIndex = 0;

    while ((match = CC_REGEX.exec(text)) !== null) {
        const ccNumber = match[1];
        const month = parseInt(match[2], 10);
        const rawYear = match[3];
        const cvv = match[4];

        const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;

        if (month >= 1 && month <= 12) {
            if (isValidLuhn(ccNumber)) {
                matches.push(`${ccNumber}|${match[2]}|${year}|${cvv}`);
            }
        }
    }
    return [...new Set(matches)];
}

function cleanUserData(text) {
    if (!text) return "";
    return text.split('\n').filter(line => {
        const lower = line.toLowerCase();
        return !lower.includes("user:") && 
               !lower.includes("usuario:") && 
               !lower.includes("checked by") &&
               !lower.includes("checkedby") &&
               !lower.includes("checked-by") &&
               !lower.includes("by:") &&
               !lower.includes("dev:") &&
               !lower.includes("developer:");
    }).join('\n').trim();
}

/**
 * 🧠 CORRECCIÓN INTELIGENTE DE EMOJIS:
 * Si el bot original pone checks verdes (✅) en estados declinados, de fraude o errores,
 * este método los reemplaza por una cruz roja (❌) o advertencia (⚠️) para evitar confusiones.
 */
function sanitizeBotEmojis(text, isLive) {
    if (!text) return "";
    let lines = text.split('\n');

    return lines.map(line => {
        const lower = line.toLowerCase();

        // Si es una respuesta declinada/muerta/fraude, limpiar los checks engañosos del bot
        if (!isLive) {
            // Reemplazar checks verdes falsos por cruces rojas o neutrales
            if (lower.includes("status:") || lower.includes("cc:") || lower.includes("elapsed:") || lower.includes("gate:")) {
                line = line.replace(/✅/g, "❌");
            }
        }
        return line;
    }).join('\n');
}

async function fetchGroupName(client, message, chatIdStr) {
    if (groupNameCache.has(chatIdStr)) return groupNameCache.get(chatIdStr);
    try {
        const chat = await message.getChat();
        const title = chat.title || chat.username || `Chat ID: ${chatIdStr}`;
        groupNameCache.set(chatIdStr, title);
        return title;
    } catch (error) {
        return `Chat ID: ${chatIdStr}`;
    }
}

function getUptimeString() {
    const totalSecs = Math.floor((Date.now() - stats.startTime) / 1000);
    const hrs = Math.floor(totalSecs / 3600);
    const mins = Math.floor((totalSecs % 3600) / 60);
    const secs = totalSecs % 60;
    return `${hrs}h ${mins}m ${secs}s`;
}

function printBanner() {
    console.clear();
    console.log("=================================================================");
    console.log(" 🚀 USERBOT EXTRACTOR ENTERPRISE ULTIMATE PRO (V7.3 SMART) 🚀 ");
    console.log("=================================================================");
    console.log(`🎯 FILTRADO DE GRUPOS: ${targetGroups.length > 0 && !targetGroups.includes("*") ? targetGroups.length + " grupos específicos" : "TODOS LOS GRUPOS (*)"}`);
    console.log(`➡️ DESTINO DE REENVÍO: ${forwardTarget}`);
    console.log(`⏳ TTL DE CACHÉ EN DISCO: ${process.env.CACHE_TTL_HOURS || 6} Horas`);
    console.log(`⚡ DELAY DE COLA DE MENSAJES: ${RATE_LIMIT_DELAY} ms`);
    console.log("=================================================================\n");
}

// ============================================================================
// 6. LÓGICA PRINCIPAL DE PROCESAMIENTO EN TIEMPO REAL
// ============================================================================

async function processMessage(client, message, isEdit) {
    if (!message || !message.chatId || !message.text) return;
    
    stats.processedMessages++;
    const chatIdStr = message.chatId.toString();
    const text = message.text;
    const lowerText = text.toLowerCase();

    if (Math.random() < 0.05) performCacheMaintenance();

    if (targetGroups.length > 0 && !targetGroups.includes(chatIdStr) && !targetGroups.includes("*")) {
        return;
    }

    // Comandos de control remoto
    if (message.out && text.startsWith("/")) {
        const args = text.split(" ");
        const command = args[0].toLowerCase();

        if (command === "/extraer") {
            const limit = parseInt(args[1], 10) || 50;
            const groupTitle = await fetchGroupName(client, message, chatIdStr);

            await messageQueueInstance.enqueue(forwardTarget, {
                message: `⏳ **[Scraping Histórico Iniciado]**\nAnalizando los últimos **${limit}** mensajes en **${groupTitle}**...`
            });

            try {
                let foundCCsBatch = [];
                const iter = client.iterMessages(message.chatId, { limit });
                for await (const msg of iter) {
                    if (msg && msg.text) {
                        const ccs = extractAndCleanCCs(msg.text);
                        foundCCsBatch.push(...ccs);
                    }
                }

                const uniqueCCs = [...new Set(foundCCsBatch)].filter(cc => !sentCardsCache.has(cc));
                for (const cc of uniqueCCs) {
                    sentCardsCache.set(cc, Date.now());
                }
                saveDiskCache();

                if (uniqueCCs.length > 0) {
                    for (let i = 0; i < uniqueCCs.length; i += 40) {
                        const chunk = uniqueCCs.slice(i, i + 40);
                        await messageQueueInstance.enqueue(forwardTarget, {
                            message: `📂 **[Scraping Masivo Histórico | ${groupTitle}]**\n\n\`${chunk.join('\n')}\``
                        });
                    }
                    stats.totalCCsExtracted += uniqueCCs.length;
                } else {
                    await messageQueueInstance.enqueue(forwardTarget, {
                        message: `⚠️ No se hallaron tarjetas nuevas o válidas en los últimos **${limit}** mensajes de **${groupTitle}**.`
                    });
                }
            } catch (err) {
                console.error(`[!] Error ejecutando /extraer: ${err.message}`);
            }
            return;
        }

        if (command === "/stats") {
            const statsMessage = 
`📊 **[PANEL DE ESTADÍSTICAS USERBOT V7.3]**

⏱️ **Tiempo Activo:** \`${getUptimeString()}\`
📩 **Mensajes Escaneados:** \`${stats.processedMessages}\`
🎯 **Responses de Bots:** \`${stats.botResponsesCaptured}\`
🕷️ **Scrapes Puros:** \`${stats.rawScrapesCaptured}\`
💳 **Total CCs Extraídas:** \`${stats.totalCCsExtracted}\`
💾 **Caché Activa (RAM):** \`${sentCardsCache.size}\`
💬 **Mensajes en Historial:** \`${messageCache.size}\`
❌ **Errores de Red:** \`${stats.errorsEncountered}\``;

            await messageQueueInstance.enqueue(forwardTarget, { message: statsMessage });
            return;
        }

        if (command === "/limpiar") {
            sentCardsCache.clear();
            messageCache.clear();
            saveDiskCache();
            await messageQueueInstance.enqueue(forwardTarget, {
                message: `🧹 **[Mantenimiento Exitoso]** Las memorias RAM y de disco han sido reseteadas.`
            });
            return;
        }
    }

    if (message.id) {
        messageCache.set(`${chatIdStr}_${message.id}`, {
            text: text,
            timestamp: Date.now()
        });
    }

    if (lowerText.trim() === "processing cc" || (lowerText.includes("processing cc") && !lowerText.includes("status:"))) {
        return;
    }

    // Detección de respuesta de bot de checking
    const isBotResponse = lowerText.includes("status:") || 
                          lowerText.includes("gate:") || 
                          lowerText.includes("elapsed:") || 
                          lowerText.includes("issuer:") || 
                          lowerText.includes("country:") ||
                          lowerText.includes("approved") ||
                          lowerText.includes("declined") ||
                          lowerText.includes("charged") ||
                          lowerText.includes("risk bin") ||
                          lowerText.includes("suspected_fraud") ||
                          lowerText.includes("live");

    let foundCCs = extractAndCleanCCs(text);

    // Memoria contextual para recuperar la CC entera de 16 dígitos
    if (isBotResponse && (message.replyToMsgId || message.replyTo)) {
        const replyId = message.replyToMsgId || (message.replyTo && message.replyTo.replyToMsgId);
        if (replyId) {
            const cachedReply = messageCache.get(`${chatIdStr}_${replyId}`);
            if (cachedReply && cachedReply.text) {
                const originalCCs = extractAndCleanCCs(cachedReply.text);
                foundCCs = [...new Set([...foundCCs, ...originalCCs])];
            } else {
                try {
                    const replyMsg = await message.getReplyMessage();
                    if (replyMsg && replyMsg.text) {
                        const originalCCs = extractAndCleanCCs(replyMsg.text);
                        foundCCs = [...new Set([...foundCCs, ...originalCCs])];
                    }
                } catch (e) {}
            }
        }
    }

    const groupTitle = await fetchGroupName(client, message, chatIdStr);

    // -------------------------------------------------------------------------
    // CASO 1: PROCESAMIENTO DE RESPUESTAS DE BOT (TODAS: LIVE Y DECLINED)
    // -------------------------------------------------------------------------
    if (isBotResponse) {
        const alertIcon = isEdit ? "🔄" : "🎯";

        // 🧠 CLasificación rigurosa para saber si el estado es realmente Live/Aceptable o Declined/Fraude
        const explicitDeclines = [
            "declined", "call_issuer", "card_should_be_returned", "account_not_found", 
            "suspected_fraud", "invalid", "dead", "incorrect_cvc", "do_not_honor", 
            "restricted", "expired", "stolen", "lost", "pickup", "inactive", "fraud"
        ];

        const isActualDecline = explicitDeclines.some(dec => lowerText.includes(dec));
        
        // Es Live si no es decline explícito y contiene indicios positivos o Risk Bin
        const isLive = !isActualDecline && (
            lowerText.includes("approved") || 
            lowerText.includes("charged") || 
            lowerText.includes("risk bin") || 
            lowerText.includes("cvv live") || 
            lowerText.includes("ccn live") || 
            lowerText.includes("auth") ||
            lowerText.includes("success")
        );

        // 🧹 Sanitizamos la respuesta original limpiando los emojis falsos si está caída
        const cleanResponse = cleanUserData(sanitizeBotEmojis(text, isLive));

        // Asignamos el ticket visual correcto según la realidad, no según los emojis del bot
        const statusHeader = isLive ? "🟢 [LIVE / SUCCESS RESPONSE]" : "🔴 [DECLINED / DEAD RESPONSE]";

        let finalMessage = `${alertIcon} **${statusHeader}**\n🏷️ **Grupo:** *${groupTitle}*\n\n`;

        const newValidCCs = foundCCs.filter(cc => !sentCardsCache.has(cc));
        
        if (newValidCCs.length > 0) {
            finalMessage += `💳 **CC Completa Extraída:**\n\`${newValidCCs.join("\n")}\`\n\n`;
            for (const cc of newValidCCs) {
                sentCardsCache.set(cc, Date.now());
            }
            saveDiskCache();
            stats.totalCCsExtracted += newValidCCs.length;
        } else if (foundCCs.length > 0) {
            finalMessage += `💳 **CC Completa (Memoria Contextual):**\n\`${foundCCs.join("\n")}\`\n\n`;
        }

        finalMessage += `📝 **Respuesta Original del Bot:**\n${cleanResponse}`;

        await messageQueueInstance.enqueue(forwardTarget, { message: finalMessage });
        stats.botResponsesCaptured++;
        console.log(`[${new Date().toLocaleTimeString()}] ✅ BOT RESPONSE | Estado: ${isLive ? 'LIVE / RISK BIN' : 'DECLINED/FRAUD'} | Grupo: ${groupTitle}`);
    } 
    // -------------------------------------------------------------------------
    // CASO 2: SCRAPING PURO DE TARJETAS SUELTAS EN CHATS
    // -------------------------------------------------------------------------
    else {
        const newValidCCs = foundCCs.filter(cc => !sentCardsCache.has(cc));
        if (newValidCCs.length > 0 && !isEdit) {
            for (const cc of newValidCCs) {
                sentCardsCache.set(cc, Date.now());
            }
            saveDiskCache();

            await messageQueueInstance.enqueue(forwardTarget, {
                message: `🕷️ **[Scraping Puro | ${groupTitle}]**\n\n\`${newValidCCs.join('\n')}\``
            });

            stats.rawScrapesCaptured++;
            stats.totalCCsExtracted += newValidCCs.length;
            console.log(`[${new Date().toLocaleTimeString()}] 🕷️ SCRAPE | ${newValidCCs.length} CCs extraídas de ${groupTitle}`);
        }
    }
}

// ============================================================================
// 7. INICIALIZACIÓN DE CLIENTE TELEGRAM Y GESTIÓN DE CICLO DE VIDA
// ============================================================================

(async () => {
    printBanner();
    loadDiskCache();

    const client = new TelegramClient(storeSession, apiId, apiHash, {
        connectionRetries: 30,
        useWSS: true,
        requestRetries: 5,
        timeout: 50000,
    });

    messageQueueInstance = new TelegramMessageQueue(client);

    try {
        await client.start({
            phoneNumber: async () => await input.text("📱 Ingresa tu número de teléfono (+XX...): "),
            password: async () => await input.text("🔒 Contraseña 2FA (Presiona Enter si no tienes): "),
            phoneCode: async () => await input.text("✉️ Código de verificación recibido en Telegram: "),
            onError: (err) => console.error("❌ Error crítico en autenticación:", err.message),
        });

        console.log("✅ Sesión iniciada y conectada correctamente a los servidores de Telegram.");
        console.log("📡 Escuchando canales, chats y grupos en tiempo real...\n");

        client.addEventHandler(async (event) => {
            await processMessage(client, event.message, false);
        }, new NewMessage({}));

        client.addEventHandler(async (event) => {
            await processMessage(client, event.message, true);
        }, new EditedMessage({}));

    } catch (error) {
        console.error(`[FATAL] Error general en el cliente de Telegram: ${error.message}`);
        process.exit(1);
    }

    process.on("uncaughtException", (err) => {
        stats.errorsEncountered++;
        console.error(`[FATAL EXCEPTION] Excepción no controlada: ${err.message}`);
    });

    process.on("unhandledRejection", (reason) => {
        stats.errorsEncountered++;
        console.error(`[FATAL REJECTION] Promesa rechazada no manejada: ${reason}`);
    });
})();