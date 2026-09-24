const axios = require("axios");
const {
    FRIGATE_API_URL,
    WEBHOOK_URL,
    MEDIA_RETRY_ATTEMPTS,
    MEDIA_RETRY_DELAY_MS,
    getGroupsForCamera,
} = require("./config");

const MIN_BUFFER_SIZE = 1024; // 1KB — anything smaller is likely an error response

// Seconds of footage to include either side of the detection window.
// Matches Frigate's record pre_capture/post_capture so the clip has context.
const CLIP_PRE_SECONDS = Number(process.env.CLIP_PRE_SECONDS ?? 5);
const CLIP_POST_SECONDS = Number(process.env.CLIP_POST_SECONDS ?? 5);

/**
 * Retry an async function with increasing delays
 * @param {Function} fn - async function to retry
 * @param {string} label - description for logging
 * @returns {Promise<Buffer>}
 */
async function downloadWithRetry(fn, label) {
    let lastError;
    for (let attempt = 1; attempt <= MEDIA_RETRY_ATTEMPTS; attempt++) {
        try {
            const buffer = await fn();
            if (buffer.length < MIN_BUFFER_SIZE) {
                throw new Error(`Response too small (${buffer.length} bytes), likely not valid media`);
            }
            return buffer;
        } catch (e) {
            lastError = e;
            if (attempt < MEDIA_RETRY_ATTEMPTS) {
                const delay = MEDIA_RETRY_DELAY_MS * attempt;
                console.log(`⏳ ${label} attempt ${attempt}/${MEDIA_RETRY_ATTEMPTS} failed (${e.message}), retrying in ${delay / 1000}s...`);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
    }
    throw lastError;
}

/**
 * Fetch events from Frigate API
 * @returns {Promise<Array>}
 */
async function fetchEvents(params = {}) {
    const response = await axios.get(`${FRIGATE_API_URL}/events`, { params });
    return response.data;
}

/**
 * Download video clip for an event
 * @param {Object} event
 * @returns {Promise<Buffer>}
 */
async function downloadVideo(event) {
    if (!event.end_time) {
        event.end_time = event.start_time + 10;
    }
    // Pad the requested window. This endpoint returns EXACTLY the time range
    // asked for - Frigate's record.pre_capture/post_capture govern what is
    // retained, not what this route serves. Without padding a 2s detection
    // yields a 2s clip, and an instantaneous one yields a single frame.
    const start = Math.max(0, event.start_time - CLIP_PRE_SECONDS);
    const end = event.end_time + CLIP_POST_SECONDS;
    const url = `${FRIGATE_API_URL}/${event.camera}/start/${start}/end/${end}/clip.mp4`;
    const response = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(response.data, "binary");
}

/**
 * Download snapshot for an event
 * @param {Object} event
 * @returns {Promise<Buffer>}
 */
async function downloadSnapshot(event) {
    // A review's own id has no snapshot endpoint; it carries the id of a
    // detection inside it instead. Falls back to event.id for plain events.
    const url = `${FRIGATE_API_URL}/events/${event.snapshot_id || event.id}/snapshot.jpg`;
    const response = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(response.data, "binary");
}

/**
 * Download thumbnail for an event
 * @param {Object} event
 * @returns {Promise<Buffer>}
 */
async function downloadThumbnail(event) {
    // Same as the snapshot: a review id has no thumbnail endpoint either, so
    // use the detection id it carries.
    const url = `${FRIGATE_API_URL}/events/${event.snapshot_id || event.id}/thumbnail.jpg`;
    const response = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(response.data, "binary");
}

/**
 * Download the camera's current frame.
 *
 * Unlike the snapshot and thumbnail routes this needs no event id, so it is
 * always available — the backstop for the first-look still when a review has
 * only just opened and its detection media does not exist yet.
 * @param {Object} event
 * @returns {Promise<Buffer>}
 */
async function downloadLatestFrame(event) {
    const url = `${FRIGATE_API_URL}/${event.camera}/latest.jpg`;
    const response = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(response.data, "binary");
}

/**
 * Download the review segment's own preview clip.
 *
 * Reviews have native media that plain events don't: one clip spanning the
 * whole segment rather than a single detection's crop. The route takes the
 * format as a QUERY param — /preview.mp4 and /preview.gif are both 404.
 * Only reviews have it, so callers must check is_review first.
 * @param {Object} event
 * @returns {Promise<Buffer>}
 */
async function downloadReviewPreview(event) {
    const url = `${FRIGATE_API_URL}/review/${event.id}/preview?format=mp4`;
    const response = await axios.get(url, { responseType: "arraybuffer" });
    return Buffer.from(response.data, "binary");
}

/**
 * Get ordered list of media download attempts for an event
 * @param {Object} event
 * @returns {Array<{download: Function, fileName: string, label: string}>}
 */
function getMediaDownloaders(event) {
    return [
        {
            download: () => downloadWithRetry(() => downloadVideo(event), `Video [${event.id}]`),
            fileName: "video.mp4",
            label: "Video",
        },
        {
            download: () => downloadWithRetry(() => downloadSnapshot(event), `Snapshot [${event.id}]`),
            fileName: "snapshot.jpg",
            label: "Snapshot",
        },
        ...(event.is_review
            ? [
                  {
                      download: () => downloadWithRetry(() => downloadReviewPreview(event), `Preview [${event.id}]`),
                      fileName: "preview.mp4",
                      label: "Preview",
                  },
              ]
            : []),
        {
            download: () => downloadWithRetry(() => downloadThumbnail(event), `Thumbnail [${event.id}]`),
            fileName: "thumbnail.jpg",
            label: "Thumbnail",
        },
    ];
}

/**
 * Stills to try for the immediate "something is happening" alert.
 *
 * Deliberately no retries: this runs while the event is still unfolding and its
 * whole value is speed. If every one fails the alert simply waits for the clip,
 * which is the old behaviour.
 * @param {Object} event
 * @returns {Array<{download: Function, fileName: string, label: string}>}
 */
function getFirstLookDownloaders(event) {
    const guard = (fn) => async () => {
        const buffer = await fn();
        if (buffer.length < MIN_BUFFER_SIZE) {
            throw new Error(`Response too small (${buffer.length} bytes)`);
        }
        return buffer;
    };
    return [
        { download: guard(() => downloadSnapshot(event)), fileName: "snapshot.jpg", label: "Snapshot" },
        { download: guard(() => downloadThumbnail(event)), fileName: "thumbnail.jpg", label: "Thumbnail" },
        { download: guard(() => downloadLatestFrame(event)), fileName: "latest.jpg", label: "Latest frame" },
    ];
}

/**
 * Trigger webhook for an event
 * @param {Object} event
 */
async function triggerWebhook(event) {
    if (!WEBHOOK_URL) return;

    const payload = {
        event_id: event.id,
        camera: event.camera,
        label: event.label,
        start_time: event.start_time,
        end_time: event.end_time,
        groups: getGroupsForCamera(event.camera).map((g) => g.name),
    };

    try {
        await axios.post(WEBHOOK_URL, payload);
        console.log("✅ Webhook triggered successfully");
    } catch (error) {
        console.error("❌ Error triggering webhook:", error.message);
    }
}

module.exports = {
    fetchEvents,
    getMediaDownloaders,
    getFirstLookDownloaders,
    triggerWebhook,
};
