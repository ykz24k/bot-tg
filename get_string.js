const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const input = require("input");

const apiId = 36397820; // Tu API_ID
const apiHash = "1cdf4de873c7d09d7ac9844414ac2ddf"; // Tu API_HASH

(async () => {
    console.log("Generando StringSession...");
    const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
        connectionRetries: 5,
    });
    
    await client.start({
        phoneNumber: async () => await input.text("📱 Ingresa tu número: "),
        password: async () => await input.text("🔒 Contraseña 2FA (Enter si no tienes): "),
        phoneCode: async () => await input.text("✉️ Código de Telegram: "),
        onError: (err) => console.log(err),
    });

    console.log("\n✅ ¡Sesión generada con éxito! Copia el siguiente texto:\n");
    console.log(client.session.save());
    console.log("\n");
    process.exit(0);
})();