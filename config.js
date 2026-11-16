require("dotenv").config();
const fs = require("fs");

// Load configuration
const CONFIG_PATH = process.env.CONFIG_PATH || "./config.json";
let config;

try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    console.log("✅ Configuration loaded from", CONFIG_PATH);
} catch (error) {
    console.error("❌ Failed to load config file:", error.message);
    console.log(
        "📝 Please create a config.json file based on config.example.json"
    );
    process.exit(1);
}

// Configuration with fallbacks to environment variables for backwards compatibility
const TELEGRAM_BOT_TOKEN =
    config.telegram_bot_token || process.env.TELEGRAM_BOT_TOKEN;
const FRIGATE_API_URL = config.frigate_api_url || process.env.API_URL;
const WEBHOOK_URL = config.webhook_url || process.env.WEBHOOK_TRIGGER;
const MEDIA_RETRY_ATTEMPTS = config.media_retry_attempts || 4;
const MEDIA_RETRY_DELAY_MS = (config.media_retry_delay_seconds || 3) * 1000;
const MEDIA_READY_DELAY_MS = (config.media_ready_delay_seconds || 5) * 1000;

// MQTT configuration
const MQTT_CONFIG = {
    host: config.mqtt?.host || process.env.MQTT_HOST,
    topic_prefix: config.mqtt?.topic_prefix || "frigate",
    username: config.mqtt?.username || process.env.MQTT_USERNAME || null,
    password: config.mqtt?.password || process.env.MQTT_PASSWORD || null,

    // Which Frigate stream to alert from. Defaults to "events" so existing
    // configs are unaffected.
    //
    //   events  - fires as soon as Frigate starts tracking an object. Frigate
    //             may later discard that object as a false positive and delete
    //             the event, leaving an alert that matches nothing in the UI.
    //   reviews - fires on Frigate's curated review segments, the same stream
    //             the UI shows. Discarded detections never become reviews, and
    //             several detections are consolidated into one review.
    source: config.mqtt?.source || process.env.MQTT_SOURCE || "events",

    // Review severities worth alerting on (source: "reviews" only).
    review_severities: config.mqtt?.review_severities || ["alert"],
};

if (!["events", "reviews"].includes(MQTT_CONFIG.source)) {
    console.error(`❌ Invalid mqtt.source "${MQTT_CONFIG.source}" - expected "events" or "reviews"`);
    process.exit(1);
}

// Validate required configuration
if (!TELEGRAM_BOT_TOKEN) {
    console.error("❌ Missing telegram_bot_token in config");
    process.exit(1);
}

if (!FRIGATE_API_URL) {
    console.error("❌ Missing frigate_api_url in config");
    process.exit(1);
}

if (!config.groups || Object.keys(config.groups).length === 0) {
    console.error("❌ No groups defined in config");
    process.exit(1);
}

if (!MQTT_CONFIG.host) {
    console.error("❌ Missing mqtt.host in config — an MQTT broker is required");
    process.exit(1);
}

/**
 * Get the list of group names assigned to a camera
 * @param {string} cameraName
 * @returns {Array<string>}
 */
function getGroupNamesForCamera(cameraName) {
    const cameraConfig = config.cameras?.[cameraName];
    return (
        cameraConfig?.groups ||
        config.default_groups ||
        Object.keys(config.groups)
    );
}

/**
 * Get enabled groups that should receive alerts for a camera
 * @param {string} cameraName
 * @returns {Array<{name: string, chat_id: string}>}
 */
function getGroupsForCamera(cameraName) {
    const groupNames = getGroupNamesForCamera(cameraName);

    return groupNames
        .filter((name) => config.groups[name]?.enabled !== false)
        .map((name) => ({
            name,
            chat_id: config.groups[name]?.chat_id,
        }))
        .filter((g) => g.chat_id);
}

/**
 * Check if the current time is within a schedule
 * @param {string} startTime
 * @param {string} endTime
 * @returns {boolean}
 */
function isWithinSchedule(startTime, endTime) {
    const now = new Date();
    const [startHour, startMinute] = startTime.split(":").map(Number);
    const [endHour, endMinute] = endTime.split(":").map(Number);

    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = startHour * 60 + startMinute;
    const endMinutes = endHour * 60 + endMinute;

    if (startMinutes <= endMinutes) {
        return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
    } else {
        // Timeframe crosses midnight
        return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
    }
}

/**
 * Get schedule for a specific camera + group combination
 * Priority: camera.group_schedules.X > camera.schedule > group.schedule > default_schedule
 * @param {string} cameraName
 * @param {string} groupName
 * @returns {{start_time: string, end_time: string, always_send: boolean}}
 */
function getScheduleForCameraAndGroup(cameraName, groupName) {
    const cameraConfig = config.cameras?.[cameraName];
    const groupConfig = config.groups?.[groupName];
    const defaultSchedule = config.default_schedule || {
        start_time: "00:00",
        end_time: "23:59",
        always_send: false,
    };

    // Check for camera-specific group schedule (most specific)
    const cameraGroupConfig = cameraConfig?.group_schedules?.[groupName];
    if (
        cameraGroupConfig?.schedule ||
        cameraGroupConfig?.always_send !== undefined
    ) {
        return {
            start_time:
                cameraGroupConfig?.schedule?.start_time ||
                cameraConfig?.schedule?.start_time ||
                groupConfig?.schedule?.start_time ||
                defaultSchedule.start_time,
            end_time:
                cameraGroupConfig?.schedule?.end_time ||
                cameraConfig?.schedule?.end_time ||
                groupConfig?.schedule?.end_time ||
                defaultSchedule.end_time,
            always_send:
                cameraGroupConfig?.always_send ??
                cameraConfig?.always_send ??
                groupConfig?.always_send ??
                defaultSchedule.always_send ??
                false,
        };
    }

    // Check for camera schedule
    if (cameraConfig?.schedule || cameraConfig?.always_send !== undefined) {
        return {
            start_time:
                cameraConfig?.schedule?.start_time ||
                groupConfig?.schedule?.start_time ||
                defaultSchedule.start_time,
            end_time:
                cameraConfig?.schedule?.end_time ||
                groupConfig?.schedule?.end_time ||
                defaultSchedule.end_time,
            always_send:
                cameraConfig?.always_send ??
                groupConfig?.always_send ??
                defaultSchedule.always_send ??
                false,
        };
    }

    // Check for group schedule
    if (groupConfig?.schedule || groupConfig?.always_send !== undefined) {
        return {
            start_time:
                groupConfig?.schedule?.start_time || defaultSchedule.start_time,
            end_time:
                groupConfig?.schedule?.end_time || defaultSchedule.end_time,
            always_send:
                groupConfig?.always_send ??
                defaultSchedule.always_send ??
                false,
        };
    }

    // Fall back to default schedule
    return {
        start_time: defaultSchedule.start_time,
        end_time: defaultSchedule.end_time,
        always_send: defaultSchedule.always_send ?? false,
    };
}

/**
 * Check if a group should receive an alert for an event
 * @param {string} cameraName
 * @param {string} groupName
 * @returns {boolean}
 */
function shouldAlertGroup(cameraName, groupName) {
    const schedule = getScheduleForCameraAndGroup(cameraName, groupName);

    if (schedule.always_send) {
        return true;
    }

    return isWithinSchedule(schedule.start_time, schedule.end_time);
}

/**
 * Get groups that should receive an alert for this event (respecting schedules and always_send)
 * @param {Object} event
 * @returns {Array<{name: string, chat_id: string, schedule: object}>}
 */
function getGroupsToAlert(event) {
    const allGroups = getGroupsForCamera(event.camera);

    return allGroups
        .filter((group) => shouldAlertGroup(event.camera, group.name))
        .map((group) => ({
            ...group,
            schedule: getScheduleForCameraAndGroup(event.camera, group.name),
        }));
}

/**
 * Get schedule configuration for a camera (for display purposes)
 * @param {string} cameraName
 * @returns {{start_time: string, end_time: string, always_send: boolean}}
 */
function getCameraSchedule(cameraName) {
    const cameraConfig = config.cameras?.[cameraName];
    const defaultSchedule = config.default_schedule || {
        start_time: "00:00",
        end_time: "23:59",
    };

    return {
        start_time:
            cameraConfig?.schedule?.start_time || defaultSchedule.start_time,
        end_time: cameraConfig?.schedule?.end_time || defaultSchedule.end_time,
        always_send:
            cameraConfig?.always_send ?? defaultSchedule.always_send ?? false,
    };
}

/**
 * Get allowed labels for a camera (if configured)
 * @param {string} cameraName
 * @returns {Array<string>|null} null means all labels allowed
 */
function getAllowedLabels(cameraName) {
    return config.cameras?.[cameraName]?.labels || null;
}

/**
 * Check if any group should receive alerts for this event
 * @param {Object} event
 * @returns {boolean}
 */
function shouldAlertAnyGroup(event) {
    const groupsToAlert = getGroupsToAlert(event);
    return groupsToAlert.length > 0;
}

/**
 * Check if an event's label is allowed for the camera
 * @param {Object} event
 * @returns {boolean}
 */
function isLabelAllowed(event) {
    const allowedLabels = getAllowedLabels(event.camera);
    if (!allowedLabels) return true; // No filter = all labels allowed
    // Reviews carry several objects; events carry one. Allow either.
    const labels = event.labels?.length ? event.labels : [event.label];
    return labels.some((label) => allowedLabels.includes(label));
}

/**
 * Reload configuration from disk in-place.
 * All functions that read from `config` will see the updated values immediately.
 * Infrastructure constants (tokens, URLs) still require a restart to take effect.
 */
// Alert videos. "original" sends Frigate's clip as it is; "compressed" shrinks
// any clip over video.max_mb before it goes out. Either way a clip over
// Telegram's own upload limit (50 MB for bots) is shrunk, as Telegram would
// refuse it. Shrinking needs a transcoder (video.transcoder_socket); without
// one, or if it fails, the original goes out as before.
const VIDEO_QUALITIES = ["original", "compressed"];

/**
 * The video settings, read from the live config so a reload applies them.
 * @returns {{quality: string, max_mb: number, transcoder_socket: string|null, timeout_seconds: number}}
 */
function getVideoSettings() {
    const video = config.video || {};
    const quality = VIDEO_QUALITIES.includes(video.quality) ? video.quality : "original";
    const maxMb = Number(video.max_mb);
    return {
        quality,
        max_mb: Number.isFinite(maxMb) && maxMb > 0 ? maxMb : 8,
        transcoder_socket: video.transcoder_socket || null,
        timeout_seconds: Number(video.timeout_seconds) > 0 ? Number(video.timeout_seconds) : 120,
    };
}

/**
 * Video quality for a chat: the first group with that chat_id that sets its
 * own video_quality, else the config's. Several groups can share a chat (one
 * per topic); they share the one file too.
 * @param {string} chatId
 * @returns {string} "original" or "compressed"
 */
function getVideoQualityForChat(chatId) {
    const own = Object.values(config.groups || {}).find(
        (g) => String(g?.chat_id) === String(chatId) && VIDEO_QUALITIES.includes(g?.video_quality)
    );
    return own ? own.video_quality : getVideoSettings().quality;
}

if (config.video?.quality && !VIDEO_QUALITIES.includes(config.video.quality)) {
    console.error(`❌ Invalid video.quality "${config.video.quality}" - expected "original" or "compressed"`);
    process.exit(1);
}

function reloadConfig() {
    try {
        const newConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
        // Mutate the exported object in-place so all modules see the change
        Object.keys(config).forEach((k) => delete config[k]);
        Object.assign(config, newConfig);
        console.log("✅ Configuration reloaded");
        return true;
    } catch (e) {
        console.error("❌ Failed to reload config:", e.message);
        return false;
    }
}

module.exports = {
    config,
    TELEGRAM_BOT_TOKEN,
    FRIGATE_API_URL,
    WEBHOOK_URL,
    MEDIA_RETRY_ATTEMPTS,
    MEDIA_RETRY_DELAY_MS,
    MEDIA_READY_DELAY_MS,
    MQTT_CONFIG,
    getGroupsForCamera,
    getGroupsToAlert,
    getCameraSchedule,
    getScheduleForCameraAndGroup,
    shouldAlertAnyGroup,
    isLabelAllowed,
    reloadConfig,
    getVideoSettings,
    getVideoQualityForChat,
};
