/**
 * ============================================================================
 * 🚀 USERBOT EXTRACTOR ENTERPRISE ULTIMATE PRO (V7.5 MEGA EXTENDED) 🚀
 * ============================================================================
 * @file index.js
 * @description Userbot avanzado y corporativo para Telegram. Diseñado para 
 *              monitoreo multicanal masivo, extracción de tarjetas de crédito 
 *              con validación algorítmica de Luhn, reconstrucción contextual de 
 *              memoria de 3 niveles, sanitización inteligente de emojis falsos 
 *              y persistencia de datos en disco mediante StringSession.
 * ============================================================================
 */

// ============================================================================
// SECCIÓN 0: IMPORTACIÓN DE MÓDULOS DEL SISTEMA Y LIBRERÍAS EXTERNAS
// ============================================================================
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");
const { EditedMessage } = require("telegram/events/EditedMessage");

// ============================================================================
// SECCIÓN 1: CONFIGURACIÓN INICIAL Y EXTRACCIÓN DE VARIABLES DE ENTORNO
// ============================================================================
const apiId = parseInt(process.env.API_ID, 10);
const apiHash = process.env.API_HASH;
const forwardTarget = process.env.FORWARD_TO || "me";

// Validación estricta de credenciales críticas al inicio del proceso
if (!apiId || !apiHash) {
    console.error("[FATAL ERROR] ❌ Las variables API_ID y API_HASH son obligatorias en el archivo .env o en Render.");
    process.exit(1);
}

// Función auxiliar para parsear listas de grupos separados por comas
const parseEnvArray = (envVar) => (envVar || "").split(",").map(id => id.trim()).filter(Boolean);
const targetGroups = parseEnvArray(process.env.TARGET_GROUPS);

// Configuración de tiempos de vida para cachés y límites de envío
const CACHE_TTL_MS = 1000 * 60 * 60 * (parseInt(process.env.CACHE_TTL_HOURS, 10) || 6);
const MSG_CACHE_TTL_MS = 1000 * 60 * (parseInt(process.env.MSG_CACHE_MINUTES, 10) || 60);
const RATE_LIMIT_DELAY = parseInt(process.env.RATE_LIMIT_DELAY_MS, 10) || 1200;

// Inicialización de la sesión basada en StringSession (para despliegues en la nube sin consola interactiva)
const stringSession = new StringSession(process.env.SESSION_STRING || "");

// ============================================================================
// SECCIÓN 2: DEFINICIÓN DE EXPRESIONES REGULARES Y ESTRUCTURAS EN MEMORIA RAM
// ============================================================================
// Regex altamente optimizada para capturar tarjetas de 15 o 16 dígitos con separadores variables
const CC_REGEX = /\b(\d{15,16})[^\w\d]*(\d{2})[^\w\d]*(\d{2,4})[^\w\d]*(\d{3,4})\b/g;

// Instanciación de estructuras Map para almacenamiento rápido en RAM
const sentCardsCache = new Map();
const messageCache = new Map();
const groupNameCache = new Map();

// Objeto global de estadísticas de rendimiento del bot
const stats = {
    startTime: Date.now(),
    processedMessages: 0,
    botResponsesCaptured: 0,
    rawScrapesCaptured: 0,
    totalCCsExtracted: 0,
    errorsEncountered: 0
};

// Ruta física para guardar el archivo de respaldo de tarjetas procesadas
const CACHE_FILE_PATH = path.join(__dirname, "sent_cards_cache.json");

// ============================================================================
// SECCIÓN 3: CLASE GESTORA DE COLA DE MENSAJES (RATE LIMITING / ANTI-FLOOD)
// ============================================================================
class TelegramMessageQueue {
    constructor(client) {
        this.client = client;
        this.queue = [];
        this.isProcessing = false;
    }

    /**
     * Añade un mensaje a la cola de envío para proteger la cuenta contra FloodWaits.
     * @param {string|number} target 
     * @param {Object} messagePayload 
     */
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
                console.error(`[!] Error crítico al entregar mensaje en cola: ${err.message}`);
                
                // Manejo automático de restricciones temporales de Telegram
                if (err.message.includes("FLOOD_WAIT")) {
                    const waitSeconds = parseInt(err.message.replace(/[^0-9]/g, ""), 10) || 15;
                    console.warn(`[⚠️ ALERTA] FloodWait detectado en la API. Pausando transmisiones por ${waitSeconds} segundos...`);
                    await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
                }
            }
            // Retardo calculado entre mensajes sucesivos
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY));
        }

        this.isProcessing = false;
    }
}

let messageQueueInstance = null;

// ============================================================================
// SECCIÓN 4: MÓDULO DE PERSISTENCIA Y MANTENIMIENTO AUTOMÁTICO DE CACHÉ
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
            console.log(`[💾 PERSISTENCIA] Caché restaurada con éxito: ${restoredCount} registros activos cargados en RAM.`);
        }
    } catch (error) {
        console.error(`[!] Error al recuperar la caché desde el disco local: ${error.message}`);
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
        console.error(`[!] Error al persistir la caché en el disco local: ${error.message}`);
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
// SECCIÓN 5: VALIDACIONES MATEMÁTICAS (ALGORITMO DE LUHN) Y SANITIZACIÓN
// ============================================================================

/**
 * Valida la estructura matemática de un número de tarjeta mediante el Algoritmo de Luhn.
 * @param {string} cardNumber 
 * @returns {boolean}
 */
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

/**
 * Extrae, formatea y valida un conjunto de tarjetas de un bloque de texto arbitrario.
 * @param {string} text 
 * @returns {string[]}
 */
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

        // Validar rango de mes y comprobar algoritmo de Luhn
        if (month >= 1 && month <= 12) {
            if (isValidLuhn(ccNumber)) {
                matches.push(`${ccNumber}|${match[2]}|${year}|${cvv}`);
            }
        }
    }
    return [...new Set(matches)];
}

/**
 * Remueve líneas de metadatos de usuario o referencias de canales para una visualización limpia.
 * @param {string} text 
 * @returns {string}
 */
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
 * Sanitizador inteligente de emojis falsos o engañosos provistos por bots externos.
 * @param {string} text 
 * @param {boolean} isLive 
 * @returns {string}
 */
function sanitizeBotEmojis(text, isLive) {
    if (!text) return "";
    let lines = text.split('\n');

    return lines.map(line => {
        const lower = line.toLowerCase();
        if (!isLive) {
            // Si no es un resultado exitoso, reemplazamos checks verdes por cruces rojas
            if (lower.includes("status:") || lower.includes("cc:") || lower.includes("elapsed:") || lower.includes("gate:")) {
                line = line.replace(/✅/g, "❌");
            }
        }
        return line;
    }).join('\n');
}

/**
 * Recupera de forma segura el título del chat o grupo de procedencia.
 */
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
    console.log(" 🚀 USERBOT EXTRACTOR ENTERPRISE ULTIMATE PRO (V7.5 MEGA) 🚀 ");
    console.log("=================================================================");
    console.log(`🎯 FILTRADO DE GRUPOS: ${targetGroups.length > 0 && !targetGroups.includes("*") ? targetGroups.length + " grupos específicos" : "TODOS LOS GRUPOS (*)"}`);
    console.log(`➡️ DESTINO DE REENVÍO: ${forwardTarget}`);
    console.log("=================================================================\n");
}

// ============================================================================
// SECCIÓN 6: NÚCLEO DE PROCESAMIENTO DE MENSAJES EN TIEMPO REAL
// ============================================================================
async function processMessage(client, message, isEdit) {
    if (!message || !message.chatId || !message.text) return;
    
    stats.processedMessages++;
    const chatIdStr = message.chatId.toString();
    const text = message.text;
    const lowerText = text.toLowerCase();

    // Mantenimiento preventivo aleatorio de cachés
    if (Math.random() < 0.05) performCacheMaintenance();

    // Comprobación de lista blanca o comodín de grupos
    if (targetGroups.length > 0 && !targetGroups.includes(chatIdStr) && !targetGroups.includes("*")) {
        return;
    }

    // -------------------------------------------------------------------------
    // SUBSICIÓN DE COMANDOS ADMINISTRATIVOS REMOTOS
    // -------------------------------------------------------------------------
    if (message.out && text.startsWith("/")) {
        const args = text.split(" ");
        const command = args[0].toLowerCase();

        // 1. Comando /extraer <límite>
        if (command === "/extraer") {
            const limit = parseInt(args[1], 10) || 50;
            const groupTitle = await fetchGroupName(client, message, chatIdStr);

            await messageQueueInstance.enqueue(forwardTarget, {
                message: `⏳ **[Scraping Histórico en Curso]**\nAnalizando los últimos **${limit}** mensajes en **${groupTitle}**...`
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
                        message: `⚠️ No se detectaron tarjetas válidas o nuevas en los últimos **${limit}** mensajes de **${groupTitle}**.`
                    });
                }
            } catch (err) {
                console.error(`[!] Error al ejecutar comando /extraer: ${err.message}`);
            }
            return;
        }

        // 2. Comando /stats (Panel de telemetría)
        if (command === "/stats") {
            const telemetryMessage = 
`📊 **[PANEL DE ESTADÍSTICAS CORPORATIVO V7.5]**

⏱️ **Tiempo en Línea:** \`${getUptimeString()}\`
📩 **Mensajes Analizados:** \`${stats.processedMessages}\`
🎯 **Responses de Bots:** \`${stats.botResponsesCaptured}\`
🕷️ **Scrapes Puros:** \`${stats.rawScrapesCaptured}\`
💳 **Total CCs Procesadas:** \`${stats.totalCCsExtracted}\`
💾 **Caché RAM Activa:** \`${sentCardsCache.size}\`
💬 **Historial en Memoria:** \`${messageCache.size}\`
❌ **Errores de Red:** \`${stats.errorsEncountered}\``;

            await messageQueueInstance.enqueue(forwardTarget, { message: telemetryMessage });
            return;
        }

        // 3. Comando /limpiar (Reseteo de memorias locales)
        if (command === "/limpiar") {
            sentCardsCache.clear();
            messageCache.clear();
            saveDiskCache();
            await messageQueueInstance.enqueue(forwardTarget, {
                message: `🧹 **[Mantenimiento Completado]** Las memorias RAM y de disco han sido vaciadas con éxito.`
            });
            return;
        }
    }

    // Almacenamiento dinámico en memoria RAM para referencias cruzadas (Reply/Contexto)
    if (message.id) {
        messageCache.set(`${chatIdStr}_${message.id}`, {
            text: text,
            timestamp: Date.now()
        });
    }

    // Filtrar estados temporales intermedios
    if (lowerText.trim() === "processing cc" || (lowerText.includes("processing cc") && !lowerText.includes("status:"))) {
        return;
    }

    // -------------------------------------------------------------------------
    // ANÁLISIS ESTRUCTURAL DE RESPUESTAS DE BOTS DE CHECKING
    // -------------------------------------------------------------------------
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

    // 🧠 RECONSTRUCCIÓN CON MEMORIA CONTEXTUAL PROFUNDA
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
    // RAMIFICACIÓN 1: CAPTURA Y TRATAMIENTO DE RESPUESTAS DE BOTS
    // -------------------------------------------------------------------------
    if (isBotResponse) {
        const alertIcon = isEdit ? "🔄" : "🎯";

        const explicitDeclines = [
            "declined", "call_issuer", "card_should_be_returned", "account_not_found", 
            "suspected_fraud", "invalid", "dead", "incorrect_cvc", "do_not_honor", 
            "restricted", "expired", "stolen", "lost", "pickup", "inactive", "fraud"
        ];

        const isActualDecline = explicitDeclines.some(dec => lowerText.includes(dec));
        
        const isLive = !isActualDecline && (
            lowerText.includes("approved") || 
            lowerText.includes("charged") || 
            lowerText.includes("risk bin") || 
            lowerText.includes("cvv live") || 
            lowerText.includes("ccn live") || 
            lowerText.includes("auth") ||
            lowerText.includes("success")
        );

        const cleanResponse = cleanUserData(sanitizeBotEmojis(text, isLive));
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
    // RAMIFICACIÓN 2: SCRAPING PURO DE TARJETAS SUELTAS EN CHATS
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
// SECCIÓN 7: INICIALIZACIÓN Y ARRANQUE DEL CLIENTE DE TELEGRAM (STRINGSESSION)
// ============================================================================
(async () => {
    printBanner();
    loadDiskCache();

    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 30,
        useWSS: true,
        requestRetries: 5,
        timeout: 50000,
    });

    messageQueueInstance = new TelegramMessageQueue(client);

    try {
        // Conexión autónoma mediante StringSession (Ideal para Render / Background Workers)
        await client.connect();
        console.log("✅ Sesión establecida de manera autónoma mediante StringSession.");
        console.log("📡 Monitoreando flujos de datos en tiempo real...\n");

        // Registro de eventos para mensajes nuevos
        client.addEventHandler(async (event) => {
            await processMessage(client, event.message, false);
        }, new NewMessage({}));

        // Registro de eventos para mensajes editados (actualizaciones de estado de bots)
        client.addEventHandler(async (event) => {
            await processMessage(client, event.message, true);
        }, new EditedMessage({}));

    } catch (error) {
        console.error(`[FATAL ERROR] Error general en el ciclo de vida del cliente Telegram: ${error.message}`);
        process.exit(1);
    }

    // Manejadores globales para prevenir cierres inesperados del proceso de Node.js
    process.on("uncaughtException", (err) => {
        stats.errorsEncountered++;
        console.error(`[FATAL EXCEPTION] Excepción no controlada detectada: ${err.message}`);
    });

    process.on("unhandledRejection", (reason) => {
        stats.errorsEncountered++;
        console.error(`[FATAL REJECTION] Promesa rechazada sin manejo catch: ${reason}`);
    });
})();