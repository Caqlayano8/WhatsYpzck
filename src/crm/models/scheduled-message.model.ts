/**
 * Author: Ç.Kurtoğlu
 * Description: Scheduled Message Model - Zamanlanmış mesaj modeli
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IScheduledMessage extends Document {
    recipientType: 'single' | 'group';
    phoneNumber?: string;
    contactName?: string;
    groupId?: string;
    groupName?: string;
    recipientPhones?: string[];
    recipientCount?: number;
    message: string;
    scheduledAt: Date;
    status: 'pending' | 'sent' | 'failed' | 'cancelled';
    error?: string;
    sentAt?: Date;
    createdBy: mongoose.Types.ObjectId;
}

const ScheduledMessageSchema = new Schema<IScheduledMessage>({
    recipientType: { type: String, enum: ['single', 'group'], default: 'single' },
    phoneNumber:  { type: String },
    contactName:  { type: String },
    groupId:      { type: String },
    groupName:    { type: String },
    recipientPhones: [{ type: String }],
    recipientCount: { type: Number, default: 1 },
    message:      { type: String, required: true },
    scheduledAt:  { type: Date, required: true },
    status:       { type: String, enum: ['pending', 'sent', 'failed', 'cancelled'], default: 'pending' },
    error:        { type: String },
    sentAt:       { type: Date },
    createdBy:    { type: Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

ScheduledMessageSchema.index({ scheduledAt: 1, status: 1 });

export const ScheduledMessageModel = mongoose.model<IScheduledMessage>('ScheduledMessage', ScheduledMessageSchema);
