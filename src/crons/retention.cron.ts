/**
 * Author: Ç.Kurtoğlu
 * Description: Data Retention Cron Job
 * Handles archiving and cleanup of old incidents and messages based on retention policies
 * Hiç bir veri silinmez - sadece arşivleme yapılır
 */

import logger from "../configs/logger.config";
import { IncidentModel } from "../crm/models/incident.model";
import { MessageModel } from "../crm/models/message.model";

/**
 * Archive old incidents based on retention policy
 * Incidents are archived but NEVER deleted - they're kept for audit trail
 */
export async function archiveOldIncidents(): Promise<void> {
    try {
        const now = new Date();
        
        // Archive incidents that are older than their retention period
        const result = await IncidentModel.updateMany(
            {
                isArchived: false,
                'retention.keepUntil': { $lte: now }
            },
            {
                $set: {
                    isArchived: true,
                    archivedAt: now
                }
            }
        );

        if (result.modifiedCount > 0) {
            logger.info(`Archived ${result.modifiedCount} old incidents based on retention policy`);
        }
    } catch (error) {
        logger.error('Error archiving old incidents:', error);
    }
}

/**
 * Archive old messages based on retention policy
 * Messages are archived but NEVER deleted - they're kept for audit/legal requirements
 */
export async function archiveOldMessages(): Promise<void> {
    try {
        const now = new Date();
        
        // Archive messages that are older than their retention period
        const result = await MessageModel.updateMany(
            {
                isArchived: false,
                'retention.keepUntil': { $lte: now }
            },
            {
                $set: {
                    isArchived: true,
                    archivedAt: now
                }
            }
        );

        if (result.modifiedCount > 0) {
            logger.info(`Archived ${result.modifiedCount} old messages based on retention policy`);
        }
    } catch (error) {
        logger.error('Error archiving old messages:', error);
    }
}

/**
 * Mark closed/resolved incidents for extended archival
 * Incidents with KAPATILDI (closed) or COZUMLENDI (resolved) status get shorter retention
 */
export async function markClosedIncidentsForArchive(): Promise<void> {
    try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        
        // Find closed/resolved incidents older than 30 days
        const closedIncidents = await IncidentModel.find({
            status: { $in: ['KAPATILDI', 'COZUMLENDI'] },
            archivedAt: null,
            updatedAt: { $lte: thirtyDaysAgo }
        });

        if (closedIncidents.length > 0) {
            const incidentIds = closedIncidents.map(i => i._id);
            
            // Archive them
            const result = await IncidentModel.updateMany(
                { _id: { $in: incidentIds } },
                {
                    $set: {
                        isArchived: true,
                        archivedAt: new Date(),
                        'retention.keepUntil': new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)  // Keep for 1 year after close
                    }
                }
            );

            logger.info(`Auto-archived ${result.modifiedCount} closed/resolved incidents (older than 30 days)`);
        }
    } catch (error) {
        logger.error('Error marking closed incidents for archive:', error);
    }
}

/**
 * Get retention statistics
 */
export async function getRetentionStats(): Promise<any> {
    try {
        const incidentStats = await IncidentModel.aggregate([
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    active: { $sum: { $cond: [{ $eq: ['$isArchived', false] }, 1, 0] } },
                    archived: { $sum: { $cond: [{ $eq: ['$isArchived', true] }, 1, 0] } },
                    readyForArchive: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ['$isArchived', false] },
                                        { $lte: ['$retention.keepUntil', new Date()] }
                                    ]
                                },
                                1,
                                0
                            ]
                        }
                    }
                }
            }
        ]);

        const messageStats = await MessageModel.aggregate([
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    active: { $sum: { $cond: [{ $eq: ['$isArchived', false] }, 1, 0] } },
                    archived: { $sum: { $cond: [{ $eq: ['$isArchived', true] }, 1, 0] } },
                    readyForArchive: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ['$isArchived', false] },
                                        { $lte: ['$retention.keepUntil', new Date()] }
                                    ]
                                },
                                1,
                                0
                            ]
                        }
                    }
                }
            }
        ]);

        return {
            incidents: incidentStats[0] || { total: 0, active: 0, archived: 0, readyForArchive: 0 },
            messages: messageStats[0] || { total: 0, active: 0, archived: 0, readyForArchive: 0 }
        };
    } catch (error) {
        logger.error('Error getting retention stats:', error);
        return null;
    }
}

/**
 * Run all retention operations
 */
export async function runRetentionCycle(): Promise<void> {
    try {
        logger.info('Starting data retention cycle...');
        
        await archiveOldIncidents();
        await archiveOldMessages();
        await markClosedIncidentsForArchive();
        
        const stats = await getRetentionStats();
        if (stats) {
            logger.info('Retention cycle completed', {
                incidents: stats.incidents,
                messages: stats.messages
            });
        }
    } catch (error) {
        logger.error('Error running retention cycle:', error);
    }
}
