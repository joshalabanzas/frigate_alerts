const net = require("net");
const { getVideoSettings, getVideoQualityForChat } = require("./config");

const MB = 1024 * 1024;
// Telegram's upload limit for bots is 50 MB; stay a little under it.
const TELEGRAM_MAX_BYTES = 49 * 1000 * 1000;
// Aim this far under a limit: the encoder's bitrate is an average, not a cap.
const TARGET_RATIO = 0.85;

/**
 * Ask the transcoder to shrink a clip to about targetBytes.
 *
 * The transcoder listens on a UNIX socket. The protocol is one line,
 * "S24T1 <target bytes>\n", then the clip; the client closes its side when the
 * clip is sent. The answer is the new MP4, or a line starting with "ERR" if it
 * could not. On a sitebox this is s24-transcode.socket, which runs ffmpeg from
 * the Frigate image already on the box.
 * @param {Buffer} buffer
 * @param {number} targetBytes
 * @param {{transcoder_socket: string, timeout_seconds: number}} settings
 * @returns {Promise<Buffer>}
 */
function transcode(buffer, targetBytes, settings) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        const socket = net.connect(settings.transcoder_socket);
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error(`no answer within ${settings.timeout_seconds}s`));
        }, settings.timeout_seconds * 1000);
        socket.on("connect", () => {
            socket.write(`S24T1 ${Math.floor(targetBytes)}\n`);
            socket.end(buffer);
        });
        socket.on("data", (chunk) => chunks.push(chunk));
        socket.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        socket.on("close", () => {
            clearTimeout(timer);
            const out = Buffer.concat(chunks);
            // An MP4 says "ftyp" at byte 4; anything else is the transcoder's error.
            if (out.length > 1024 && out.toString("latin1", 4, 8) === "ftyp") {
                resolve(out);
            } else {
                reject(new Error(out.toString("utf8", 0, 300).trim() || "empty answer"));
            }
        });
    });
}

/**
 * The clip as a chat with the given quality should get it: unchanged when it
 * is within that quality's limit, else shrunk to fit. Never throws: when the
 * clip can't be shrunk the original goes out, as before this setting existed.
 * @param {Buffer} buffer
 * @param {string} quality "original" or "compressed"
 * @returns {Promise<Buffer>}
 */
async function videoFor(buffer, quality) {
    const settings = getVideoSettings();
    const limit = quality === "compressed" ? Math.min(settings.max_mb * MB, TELEGRAM_MAX_BYTES) : TELEGRAM_MAX_BYTES;
    if (buffer.length <= limit) return buffer;
    const size = (buffer.length / MB).toFixed(1);
    if (!settings.transcoder_socket) {
        console.log(`⚠️ Clip is ${size} MB, over ${(limit / MB).toFixed(1)} MB, but no transcoder is set: sending it as it is`);
        return buffer;
    }
    const started = Date.now();
    try {
        const out = await transcode(buffer, limit * TARGET_RATIO, settings);
        if (out.length >= buffer.length) {
            console.log(`⚠️ Compressed clip is no smaller (${(out.length / MB).toFixed(1)} MB): sending the original`);
            return buffer;
        }
        console.log(`🗜️ Clip compressed ${size} MB → ${(out.length / MB).toFixed(1)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        return out;
    } catch (e) {
        console.error(`❌ Compressing the clip (${size} MB) failed, sending it as it is: ${e.message}`);
        return buffer;
    }
}

/**
 * A picker for one downloaded clip: per chat, the file that chat should get.
 * Each quality is worked out once, however many chats share it.
 * @param {Buffer} buffer
 * @returns {(chatId: string) => Promise<Buffer>}
 */
function videoPicker(buffer) {
    const byQuality = new Map();
    return (chatId) => {
        const quality = getVideoQualityForChat(chatId);
        if (!byQuality.has(quality)) byQuality.set(quality, videoFor(buffer, quality));
        return byQuality.get(quality);
    };
}

module.exports = { videoFor, videoPicker, transcode };
