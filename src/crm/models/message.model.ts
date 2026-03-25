/**
 * Author: Ç.Kurtoğlu
 * Description: Message Model - Mesaj modeli
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IMessage extends Document {
    phoneNumber: string;
    body: string;
    type: 'text' | 'image' | 'document' | 'other';
    direction: 'in' | 'out';
    whatsappMessageId?: string;
    sentVia: 'whatsapp' | 'admin' | 'widget';
    read: boolean;
    campaignId?: mongoose.Types.ObjectId;
    timestamp: Date;
    // Group chat fields
    isGroup: boolean;
    groupId?: string;
    senderName?: string;
    // Widget fields
    visitorIp?: string;
    pageUrl?: string;
    // Maintenance flag
    receivedDuringMaintenance?: boolean;
    // Media
    mediaUrl?: string;
    // Archive ve retention fields - ASLA SİLİNMEYECEK, TARİH BAZLI SAKLANACAK
    isArchived?: boolean;
    archivedAt?: Date;
    retention?: {
        keepUntil?: Date;  // Ne kadar müddet saklanacak
        retentionDays?: number;  // Gün cinsinden retention süresi (default: 90 gün sohbet, 365 gün kapalı sohbet)
    };
}

const MessageSchema = new Schema<IMessage>({
    phoneNumber: { type: String, required: true, index: true },
    body: { type: String, required: true },
    type: { type: String, enum: ['text', 'image', 'document', 'other'], default: 'text' },
    direction: { type: String, enum: ['in', 'out'], required: true },
    whatsappMessageId: { type: String, index: true, sparse: true },
    sentVia: { type: String, enum: ['whatsapp', 'admin', 'widget'], default: 'whatsapp' },
    read: { type: Boolean, default: false },
    campaignId: { type: Schema.Types.ObjectId, ref: 'Campaign' },
    timestamp: { type: Date, default: Date.now },
    isGroup: { type: Boolean, default: false },
    groupId: { type: String, index: true },
    senderName: { type: String },
    visitorIp: { type: String },
    pageUrl: { type: String },
    receivedDuringMaintenance: { type: Boolean, default: false },
    mediaUrl: { type: String },
    // Archive ve retention fields - ASLA SİLİNMEYECEK, TARİH BAZLI SAKLANACAK
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    retention: {
        keepUntil: { type: Date, default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) },  // Default 90 gün
        retentionDays: { type: Number, default: 90 }
    },
});

export const MessageModel = mongoose.model<IMessage>('Message', MessageSchema);
