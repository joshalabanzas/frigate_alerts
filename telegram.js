const axios = require("axios");
const FormData = require("form-data");
const {
    TELEGRAM_BOT_TOKEN,
    MEDIA_RETRY_ATTEMPTS,
    MEDIA_RETRY_DELAY_MS,
    getGroupsToAlert,
} = require("./config");
const snooze = require("./snooze");

const API = (method) => `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;

/**
 * Pick the Telegram send method and form field for a filename
 * @param {string} fileName
 * @returns {{method: string, fieldName: string, type: string}}
 */
function mediaKind(fileName) {
    if (fileName.endsWith(".mp4")) {
        return { method: "sendVideo", fieldName: "video", type: "video" };
    }
    if (fileName.endsWith(".jpg") || fileName.endsWith(".jpeg") || fileName.endsWith(".png")) {
        return { method: "sendPhoto", fieldName: "photo", type: "photo" };
    }
    return { method: "sendDocument", fieldName: "document", type: "document" };
}

/**
 * Send a message to a specific Telegram chat
 * @param {string} chatId
 * @param {string} message
 */
async function sendToTelegram(chatId, message) {
    try {
        await axios.post(API("sendMessage"), {
            chat_id: chatId,
            text: message || "",
            parse_mode: "HTML",
        });
        console.log(`✅ Message sent to chat ${chatId}`);
    } catch (error) {
        console.error(
            `❌ Failed to send message to ${chatId}:`,
            error.response?.data || error.message
        );
    }
}

/**
 * Send media to a specific Telegram chat with retries
 * @param {string} chatId
 * @param {Buffer} buffer
 * @param {string} caption
 * @param {string} fileName
 * @returns {Promise<number|null>} message_id of the sent message, or null on failure
 */
async function sendMediaToTelegram(chatId, buffer, caption, fileName) {
    const { method, fieldName } = mediaKind(fileName);

    for (let attempt = 1; attempt <= MEDIA_RETRY_ATTEMPTS; attempt++) {
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append(fieldName, buffer, { filename: fileName });
        if (caption) form.append("caption", caption);
        form.append("parse_mode", "HTML");

        try {
            const res = await axios.post(API(method), form, { headers: form.getHeaders() });
            const messageId = res.data?.result?.message_id ?? null;
            console.log(`✅ Media sent to chat ${chatId}${messageId ? ` [msg ${messageId}]` : ""}`);
            return messageId;
        } catch (error) {
            const errMsg = error.response?.data?.description || error.message;
            if (attempt < MEDIA_RETRY_ATTEMPTS) {
                const delay = MEDIA_RETRY_DELAY_MS * attempt;
                console.log(`⏳ Telegram send to ${chatId} attempt ${attempt}/${MEDIA_RETRY_ATTEMPTS} failed (${errMsg}), retrying in ${delay / 1000}s...`);
                await new Promise((r) => setTimeout(r, delay));
            } else {
                console.error(`❌ Failed to send media to ${chatId} after ${MEDIA_RETRY_ATTEMPTS} attempts: ${errMsg}`);
            }
        }
    }
    return null;
}

/**
 * Replace the media on a message already in the chat.
 *
 * This is what turns the instant snapshot into the finished clip without
 * posting a second message: Telegram allows a photo message to be edited
 * into a video, so the alert stays a single entry in the group.
 * @param {string} chatId
 * @param {number} messageId
 * @param {Buffer} buffer
 * @param {string} caption
 * @param {string} fileName
 * @returns {Promise<boolean>}
 */
async function editMediaInTelegram(chatId, messageId, buffer, caption, fileName) {
    const { type } = mediaKind(fileName);

    for (let attempt = 1; attempt <= MEDIA_RETRY_ATTEMPTS; attempt++) {
        const form = new FormData();
        form.append("chat_id", chatId);
        form.append("message_id", String(messageId));
        form.append("media", JSON.stringify({
            type,
            media: "attach://upload",
            caption: caption || undefined,
            parse_mode: "HTML",
            ...(type === "video" ? { supports_streaming: true } : {}),
        }));
        form.append("upload", buffer, { filename: fileName });

        try {
            await axios.post(API("editMessageMedia"), form, { headers: form.getHeaders() });
            console.log(`✏️ Media replaced on chat ${chatId} [msg ${messageId}]`);
            return true;
        } catch (error) {
            const errMsg = error.response?.data?.description || error.message;
            if (attempt < MEDIA_RETRY_ATTEMPTS) {
                const delay = MEDIA_RETRY_DELAY_MS * attempt;
                console.log(`⏳ Telegram edit on ${chatId} attempt ${attempt}/${MEDIA_RETRY_ATTEMPTS} failed (${errMsg}), retrying in ${delay / 1000}s...`);
                await new Promise((r) => setTimeout(r, delay));
            } else {
                console.error(`❌ Failed to edit media on ${chatId} after ${MEDIA_RETRY_ATTEMPTS} attempts: ${errMsg}`);
            }
        }
    }
    return false;
}

/**
 * Update only the caption of a message already in the chat
 * @param {string} chatId
 * @param {number} messageId
 * @param {string} caption
 * @returns {Promise<boolean>}
 */
async function editCaptionInTelegram(chatId, messageId, caption) {
    try {
        await axios.post(API("editMessageCaption"), {
            chat_id: chatId,
            message_id: messageId,
            caption: caption || "",
            parse_mode: "HTML",
        });
        return true;
    } catch (error) {
        console.error(
            `❌ Failed to edit caption on ${chatId}:`,
            error.response?.data?.description || error.message
        );
        return false;
    }
}

/**
 * Send alert with media to all configured groups for a camera
 * @param {Object} event
 * @param {Buffer} mediaBuffer
 * @param {string} message
 * @param {string} fileName
 * @returns {Promise<Array<{chatId: string, messageId: number}>>} handles for the
 *          messages that landed, usable later with editMediaAlertInGroups
 */
async function sendMediaAlertToGroups(event, mediaBuffer, message, fileName) {
    const groups = getGroupsToAlert(event).filter((g) => !snooze.shouldSnooze(event.camera, g.name));

    if (groups.length === 0) {
        console.log(`⚠️ No groups configured for camera: ${event.camera}`);
        return [];
    }

    console.log(
        `📤 Sending media alert to ${groups.length} group(s): ${groups
            .map((g) => g.name)
            .join(", ")}`
    );

    const results = await Promise.all(
        groups.map(async (group) => ({
            chatId: group.chat_id,
            messageId: await sendMediaToTelegram(group.chat_id, mediaBuffer, message, fileName),
        }))
    );

    return results.filter((r) => r.messageId !== null);
}

/**
 * Replace the media on alerts already posted to groups
 * @param {Array<{chatId: string, messageId: number}>} handles
 * @param {Buffer} mediaBuffer
 * @param {string} message
 * @param {string} fileName
 * @returns {Promise<boolean>} true if every message was updated
 */
async function editMediaAlertInGroups(handles, mediaBuffer, message, fileName) {
    if (!handles || handles.length === 0) return false;

    console.log(`✏️ Replacing media on ${handles.length} existing alert(s)`);

    const results = await Promise.all(
        handles.map((h) => editMediaInTelegram(h.chatId, h.messageId, mediaBuffer, message, fileName))
    );

    return results.every(Boolean);
}

/**
 * Update the caption on alerts already posted to groups
 * @param {Array<{chatId: string, messageId: number}>} handles
 * @param {string} message
 */
async function editCaptionInGroups(handles, message) {
    if (!handles || handles.length === 0) return;
    await Promise.all(handles.map((h) => editCaptionInTelegram(h.chatId, h.messageId, message)));
}

/**
 * Send text-only alert to all configured groups for a camera
 * @param {Object} event
 * @param {string} message
 */
async function sendTextAlertToGroups(event, message) {
    const groups = getGroupsToAlert(event).filter((g) => !snooze.shouldSnooze(event.camera, g.name));

    if (groups.length === 0) return;

    console.log(
        `📤 Sending text alert to ${groups.length} group(s): ${groups
            .map((g) => g.name)
            .join(", ")}`
    );

    await Promise.all(
        groups.map((group) => sendToTelegram(group.chat_id, message))
    );
}

module.exports = {
    sendMediaAlertToGroups,
    sendTextAlertToGroups,
    editMediaAlertInGroups,
    editCaptionInGroups,
};
