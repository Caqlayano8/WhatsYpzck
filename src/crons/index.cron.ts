import { checkScheduledCampaigns, checkScheduledMessages } from "./campaign.cron";
import { cleanupOldDownloads, checkDiskSpace } from "./cleanup.cron";
import { sendDailyReport } from "./daily-report.cron";
import { runRetentionCycle } from "./retention.cron";
import { BotManager } from "../bot.manager";
import { CronJob } from "cron";
import logger from "../configs/logger.config";

export function initCrons(botManager: BotManager) {
    // Check scheduled campaigns every minute
    new CronJob(
        "* * * * *",
        () => checkScheduledCampaigns(botManager),
        null,
        true,
        "Africa/Lome"
    );

    // Check scheduled messages every minute
    new CronJob(
        "* * * * *",
        () => checkScheduledMessages(botManager),
        null,
        true,
        "Africa/Lome"
    );

    // Cleanup old downloads every hour (at minute 0)
    new CronJob(
        "0 * * * *",
        () => cleanupOldDownloads(24), // Delete files older than 24 hours
        null,
        true,
        "Africa/Lome"
    );

    // Check disk space every 6 hours (at minute 0)
    new CronJob(
        "0 */6 * * *",
        () => checkDiskSpace(),
        null,
        true,
        "Africa/Lome"
    );

    // Daily report at midnight Istanbul time (00:00 Europe/Istanbul)
    new CronJob(
        "0 0 * * *",
        () => sendDailyReport(botManager),
        null,
        true,
        "Europe/Istanbul"
    );

    // Data retention cycle - Run daily at 2 AM Istanbul time to archive old data
    // Incidents: 365 days retention, Conversations: 90 days retention
    new CronJob(
        "0 2 * * *",
        () => runRetentionCycle(),
        null,
        true,
        "Europe/Istanbul"
    );

    logger.info("Cron jobs initialized (campaigns, scheduled-messages, cleanup, disk-space, daily-report, retention-cycle)");
}