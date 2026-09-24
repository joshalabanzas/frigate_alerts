const {
    config,
    FRIGATE_API_URL,
    MEDIA_READY_DELAY_MS,
    MQTT_CONFIG,
    WEBHOOK_URL,
    getCameraSchedule,
    getScheduleForCameraAndGroup,
    shouldAlertAnyGroup,
    isLabelAllowed,
    reloadConfig,
} = require("./config");
const {
    sendMediaAlertToGroups,
    sendTextAlertToGroups,
    editMediaAlertInGroups,
    editCaptionInGroups,
} = require("./telegram");
const {
    fetchEvents,
    getMediaDownloaders,
    getFirstLookDownloaders,
    triggerWebhook,
} = require("./frigate");
const { connect, disconnect } = require("./mqtt");
const snooze = require("./snooze");
const { startServer, setReloadConfigFn } = require("./server");

const processedEvents = new Set();
const pendingEvents = new Map();
// event id -> Promise<handles[]> for the snapshot posted the instant the review
// opened. Held as a promise so a review that closes fast still waits for the
// send to finish rather than posting a second message.
const firstLookSends = new Map();
const MAX_PROCESSED_EVENTS = 1000;
const EVENT_END_TIMEOUT_MS = 60000;

/**
 * Prune processed events set to prevent memory leak
 */
function pruneProcessedEvents() {
    if (processedEvents.size > MAX_PROCESSED_EVENTS) {
        const entries = [...processedEvents];
        const toRemove = entries.slice(0, entries.length - MAX_PROCESSED_EVENTS / 2);
        toRemove.forEach((id) => {
            processedEvents.delete(id);
            firstLookSends.delete(id);
        });
    }
}

/**
 * Handle incoming MQTT event from frigate/events topic
 * @param {Object} payload - MQTT message payload with type, before, after
 */
function handleMqttEvent(payload) {
    const { type } = payload;
    const event = payload.after;

    if (!event || !event.id) return;

    if (type === "new" || type === "update") {
        if (processedEvents.has(event.id)) return;

        if (!isLabelAllowed(event)) {
            if (type === "new") {
                console.log(`🏷️ Event ${event.id} label "${event.label}" not allowed for ${event.camera}`);
            }
            return;
        }
        if (snooze.shouldSnooze(event.camera, null)) {
            console.log(`💤 Event ${event.id} suppressed by snooze for ${event.camera}`);
            return;
        }
        if (!shouldAlertAnyGroup(event)) {
            if (type === "new") {
                console.log(`⏰ Event ${event.id} outside schedule for ${event.camera}`);
            }
            return;
        }

        // Guarded: "update" lands here too, so an event whose "new" was dropped
        // still gets a still, and a chatty one only gets one.
        if (!firstLookSends.has(event.id)) {
            console.log(`📡 ${type === "new" ? "New" : "Ongoing"} event: ${event.label} on ${event.camera} [${event.id}]`);
            firstLookSends.set(event.id, sendFirstLook(event));
        }

        if (pendingEvents.has(event.id)) return;

        // Start timeout — if "end" doesn't arrive, process with snapshot
        const timer = setTimeout(() => {
            if (processedEvents.has(event.id)) return;
            pendingEvents.delete(event.id);
            processedEvents.add(event.id);
            pruneProcessedEvents();
            console.log(`⏰ Event ${event.id} timed out waiting for end, processing now`);
            event.end_time = event.start_time + 10;
            processEvent(event);
        }, EVENT_END_TIMEOUT_MS);

        pendingEvents.set(event.id, { event, timer });
    } else if (type === "end") {
        if (processedEvents.has(event.id)) return;

        // Clear pending timeout
        const pending = pendingEvents.get(event.id);
        if (pending) {
            clearTimeout(pending.timer);
            pendingEvents.delete(event.id);
        }

        if (!isLabelAllowed(event)) return;
        if (!shouldAlertAnyGroup(event)) return;

        processedEvents.add(event.id);
        pruneProcessedEvents();

        console.log(`🏁 Event ended: ${event.label} on ${event.camera} [${event.id}]`);

        // Last resort: nothing went out earlier, so post the still now rather
        // than making the group wait out the media delay and the download too.
        if (!firstLookSends.has(event.id)) {
            firstLookSends.set(event.id, sendFirstLook(event));
        }

        // Delay to let clip finalize, then process
        setTimeout(() => processEvent(event), MEDIA_READY_DELAY_MS);
    }
}

/**
 * Convert a Frigate review segment into the event shape the rest of the
 * pipeline already understands.
 *
 * A review groups several detections over one stretch of activity, so it has a
 * list of objects rather than a single label. `snapshot_id` points at a real
 * detection because a review id has no snapshot endpoint of its own.
 *
 * @param {Object} review - the `after` body of a frigate/reviews message
 * @returns {Object} event-shaped object
 */
function reviewToEvent(review) {
    const objects = [...new Set(review.data?.objects || [])];
    const detections = review.data?.detections || [];
    return {
        id: review.id,
        snapshot_id: detections[0] || review.id,
        camera: review.camera,
        label: objects.join(", ") || "activity",
        labels: objects,
        start_time: review.start_time,
        end_time: review.end_time,
        severity: review.severity,
        detection_count: detections.length,
        zones: review.data?.zones || [],
        is_review: true,
    };
}

/**
 * Handle incoming MQTT message from the frigate/reviews topic.
 *
 * Reviews are Frigate's curated stream — the same one the UI shows. Detections
 * that Frigate later discards as false positives never become reviews, so
 * alerting from here cannot produce a notification with nothing behind it.
 *
 * @param {Object} payload - MQTT message payload with type, before, after
 */
function handleMqttReview(payload) {
    const { type } = payload;
    const review = payload.after;

    if (!review || !review.id) return;
    if (!MQTT_CONFIG.review_severities.includes(review.severity)) return;

    const event = reviewToEvent(review);

    if (type === "new" || type === "update") {
        if (processedEvents.has(event.id)) return;
        if (!isLabelAllowed(event)) {
            if (type === "new") {
                console.log(`🏷️ Review ${event.id} objects "${event.label}" not allowed for ${event.camera}`);
            }
            return;
        }
        if (snooze.shouldSnooze(event.camera, null)) {
            console.log(`💤 Review ${event.id} suppressed by snooze for ${event.camera}`);
            return;
        }
        if (!shouldAlertAnyGroup(event)) {
            if (type === "new") {
                console.log(`⏰ Review ${event.id} outside schedule for ${event.camera}`);
            }
            return;
        }

        // Guarded because "update" lands here too: a review whose "new" was
        // dropped still gets its first look, and a chatty one only gets one.
        if (!firstLookSends.has(event.id)) {
            console.log(`📡 ${type === "new" ? "New" : "Ongoing"} review (${review.severity}): ${event.label} on ${event.camera} [${event.id}]`);

            // Post a still straight away so the group is told within seconds.
            // The clip replaces it in place once the review closes, so this
            // costs no extra message.
            firstLookSends.set(event.id, sendFirstLook(event));
        }

        if (pendingEvents.has(event.id)) return;

        // Wait for the review to close so the detection list is complete. If it
        // never closes, fall back so an alert still goes out.
        const timer = setTimeout(() => {
            if (processedEvents.has(event.id)) return;
            pendingEvents.delete(event.id);
            processedEvents.add(event.id);
            pruneProcessedEvents();
            console.log(`⏰ Review ${event.id} timed out waiting for end, processing now`);
            processEvent({ ...event, end_time: event.start_time + 10 });
        }, EVENT_END_TIMEOUT_MS);

        pendingEvents.set(event.id, { event, timer });
    } else if (type === "end") {
        if (processedEvents.has(event.id)) return;

        const pending = pendingEvents.get(event.id);
        if (pending) {
            clearTimeout(pending.timer);
            pendingEvents.delete(event.id);
        }

        if (!isLabelAllowed(event)) return;
        if (!shouldAlertAnyGroup(event)) return;

        processedEvents.add(event.id);
        pruneProcessedEvents();

        console.log(`🏁 Review ended: ${event.label} on ${event.camera} [${event.id}] (${event.detection_count} detection(s))`);

        // Last resort: if nothing went out earlier (every message before "end"
        // was lost), post the still now rather than making the group wait out
        // the media delay and the clip download too.
        if (!firstLookSends.has(event.id)) {
            firstLookSends.set(event.id, sendFirstLook(event));
        }

        setTimeout(() => processEvent(event), MEDIA_READY_DELAY_MS);
    }
}

/**
 * Build the alert caption.
 * @param {Object} event
 * @param {string} stage - "first" while the event is still running, else "final"
 * @returns {string}
 */
function buildMessage(event, stage) {
    const schedule = getCameraSchedule(event.camera);
    const scheduleInfo = schedule.always_send
        ? "🔔 Always Send"
        : `⏰ ${schedule.start_time} - ${schedule.end_time}`;

    const detail = event.is_review && event.detection_count > 1
        ? ` (${event.detection_count} detections)`
        : "";

    const footer = stage === "first"
        ? "\n📸 Live snapshot — clip to follow"
        : "";

    return `🚨 <b>Frigate Alert!</b>
📷 Camera: ${event.camera}
📌 Object: ${event.label}${detail}
⏳ Time: ${new Date(event.start_time * 1000).toLocaleString()}
${scheduleInfo}${footer}`;
}

/**
 * Post the immediate still for an event that has just started.
 * @param {Object} event
 * @returns {Promise<Array<{chatId: string, messageId: number}>>}
 */
async function sendFirstLook(event) {
    const message = buildMessage(event, "first");

    for (const { download, fileName, label } of getFirstLookDownloaders(event)) {
        try {
            const buffer = await download();
            const handles = await sendMediaAlertToGroups(event, buffer, message, fileName);
            if (handles.length) {
                console.log(`⚡ First look (${label}) out for ${event.camera} [${event.id}]`);
                return handles;
            }
        } catch (e) {
            // Expected early in an event; fall through to the next source.
        }
    }

    console.log(`⚠️ No first-look still available for ${event.camera} [${event.id}], waiting for clip`);
    return [];
}

/**
 * Process a single Frigate event — download media and send alerts.
 *
 * If a first-look still already went out, the clip REPLACES it via
 * editMessageMedia so the alert stays one message in the group.
 * @param {Object} event
 */
async function processEvent(event) {
    const handles = await (firstLookSends.get(event.id) || Promise.resolve([]));
    firstLookSends.delete(event.id);

    const message = buildMessage(event, "final");

    triggerWebhook(event);

    const downloaders = getMediaDownloaders(event);

    for (const { download, fileName, label } of downloaders) {
        try {
            const buffer = await download();
            if (handles.length) {
                if (await editMediaAlertInGroups(handles, buffer, message, fileName)) return;
                console.log(`⚠️ ${label} downloaded but the edit was rejected, trying next...`);
            } else {
                const sent = await sendMediaAlertToGroups(event, buffer, message, fileName);
                if (sent.length) return;
                console.log(`⚠️ ${label} downloaded but Telegram rejected it, trying next...`);
            }
        } catch (e) {
            console.log(`⚠️ ${label} download failed after retries, trying next...`);
        }
    }

    console.error("❌ All media types failed for event:", event.id);
    if (handles.length) {
        // The still is already in the group; say so rather than posting again.
        await editCaptionInGroups(handles, message + "\n⚠️ (Clip unavailable)");
        return;
    }
    await sendTextAlertToGroups(event, message + "\n⚠️ (No media available)");
}

/**
 * Catch up on events missed while the service was down
 */
async function catchUpMissedEvents() {
    try {
        console.log("🔍 Checking for missed events...");
        // Kept deliberately short: anything older is history, and replaying it
        // floods the group on every restart. CATCH_UP_SECONDS=0 disables it.
        const window = Number(process.env.CATCH_UP_SECONDS ?? 90);
        if (window <= 0) {
            console.log("   Catch-up disabled");
            return;
        }
        const since = Date.now() / 1000 - window;
        const events = await fetchEvents({ after: since, limit: 50 });

        if (!events || events.length === 0) {
            console.log("   No recent events found");
            return;
        }

        // Only process completed events (have end_time)
        const completedEvents = events.filter((e) => e.end_time);

        if (completedEvents.length === 0) {
            console.log("   No completed events to catch up on");
            return;
        }

        console.log(`   Found ${completedEvents.length} recent event(s), processing...`);

        for (const event of completedEvents) {
            if (processedEvents.has(event.id)) continue;
            if (!isLabelAllowed(event)) continue;
            if (!shouldAlertAnyGroup(event)) continue;

            processedEvents.add(event.id);
            await processEvent(event);
        }
    } catch (error) {
        console.error("❌ Error during catch-up:", error.message);
    }
}

/**
 * Print startup configuration summary
 */
function printConfigSummary() {
    console.log("\n📋 Configuration Summary:");
    console.log(`   Frigate API: ${FRIGATE_API_URL}`);
    console.log(`   MQTT Broker: ${MQTT_CONFIG.host}`);
    console.log(`   MQTT Topic: ${MQTT_CONFIG.topic_prefix}/${MQTT_CONFIG.source}`);
    console.log(`   Media Ready Delay: ${MEDIA_READY_DELAY_MS / 1000}s`);
    console.log(`   Webhook: ${WEBHOOK_URL || "Not configured"}`);

    const defaultSchedule = config.default_schedule || {
        start_time: "00:00",
        end_time: "23:59",
    };
    console.log(
        `   Default Schedule: ${defaultSchedule.start_time} - ${defaultSchedule.end_time}`
    );

    console.log("\n👥 Groups:");
    for (const [name, group] of Object.entries(config.groups)) {
        const status = group.enabled !== false ? "✅" : "❌";
        const alwaysSend = group.always_send ? " [ALWAYS SEND]" : "";
        const schedule = group.schedule
            ? ` (${group.schedule.start_time} - ${group.schedule.end_time})`
            : " (uses default schedule)";
        console.log(
            `   ${status} ${name}: ${group.chat_id}${alwaysSend}${schedule}`
        );
        if (group.description) {
            console.log(`      ${group.description}`);
        }
    }

    console.log("\n📹 Camera Configurations:");
    console.log(
        `   Default Groups: ${(config.default_groups || ["all"]).join(", ")}`
    );

    if (config.cameras && Object.keys(config.cameras).length > 0) {
        for (const [name, cam] of Object.entries(config.cameras)) {
            const schedule = getCameraSchedule(name);
            const groupNames = cam.groups ||
                config.default_groups || ["default"];
            const labels = cam.labels ? cam.labels.join(", ") : "all";
            const alwaysSend = schedule.always_send ? " [ALWAYS SEND]" : "";
            console.log(`   📷 ${name}:`);
            console.log(
                `      Camera Schedule: ${schedule.start_time} - ${schedule.end_time}${alwaysSend}`
            );
            console.log(`      Labels: ${labels}`);
            console.log(`      Groups:`);

            for (const groupName of groupNames) {
                const effectiveSchedule = getScheduleForCameraAndGroup(
                    name,
                    groupName
                );
                const groupAlwaysSend = effectiveSchedule.always_send
                    ? " [ALWAYS SEND]"
                    : "";
                const hasOverride = cam.group_schedules?.[groupName];
                const overrideIndicator = hasOverride ? " *" : "";
                console.log(
                    `         - ${groupName}: ${effectiveSchedule.start_time} - ${effectiveSchedule.end_time}${groupAlwaysSend}${overrideIndicator}`
                );
            }
        }
        console.log("      (* = camera-specific group schedule override)");
    } else {
        console.log("   No camera-specific configurations (using defaults)");
    }
    console.log("");
}

// Graceful shutdown
function shutdown() {
    console.log("\n🛑 Shutting down...");
    for (const [, { timer }] of pendingEvents) {
        clearTimeout(timer);
    }
    pendingEvents.clear();
    disconnect();
    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Start the service
setReloadConfigFn(reloadConfig);
startServer(config.server_port);
printConfigSummary();
catchUpMissedEvents().then(() => {
    connect(MQTT_CONFIG, MQTT_CONFIG.source === "reviews" ? handleMqttReview : handleMqttEvent);
    console.log("🚀 Frigate event listener started (MQTT mode)\n");
});
