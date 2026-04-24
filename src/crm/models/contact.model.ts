/**
 * Author: Ç.Kurtoğlu
 *Description: Contact Model - İletişim bilgisi modeli
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface IContact extends Document {
    customerId: string;       // Benzersiz müşteri numarası: MUS-000001
    phoneNumber: string;
    name?: string;
    lastName?: string;
    address?: string;
    pushName?: string;
    language?: string;
    detectedLanguage?: 'en' | 'fr' | 'other';
    detectedCountry?: string;
    detectedRegion?: string;
    lastInteraction: Date;
    interactionsCount: number;
    tags: string[];
    blocked: boolean;
    archived: boolean;
    score: number;
    kvkkAccepted?: boolean;
}

// Otomatik artan sıralı müşteri numarası üreteci
const CounterSchema = new Schema({ seq: { type: Number, default: 0 } });
const ContactCounter = (mongoose.models['ContactCounter'] as mongoose.Model<{ seq: number }>) ||
    mongoose.model<{ seq: number }>('ContactCounter', CounterSchema);

export async function generateCustomerId(): Promise<string> {
    const counter = await ContactCounter.findOneAndUpdate(
        {},
        { $inc: { seq: 1 } },
        { upsert: true, new: true }
    ).lean() as { seq: number } | null;
    const seq = String(counter?.seq ?? 1).padStart(6, '0');
    return `MUS-${seq}`;
}

const ContactSchema = new Schema<IContact>({
    customerId: { type: String, unique: true, sparse: true },
    phoneNumber: { type: String, required: true, unique: true },
    name: String,
    lastName: String,
    address: String,
    pushName: String,
    language: String,
    detectedLanguage: { type: String, enum: ['en', 'fr', 'other'] },
    detectedCountry: String,
    detectedRegion: String,
    lastInteraction: { type: Date, default: Date.now },
    interactionsCount: { type: Number, default: 1 },
    tags: [{ type: String }],
    blocked: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    score: { type: Number, default: 0 },
    kvkkAccepted: { type: Boolean, default: false }
}, { timestamps: true });

// Yeni kayıt oluşturulurken otomatik customerId ata
ContactSchema.pre('save', async function () {
    if (!this.customerId) {
        this.customerId = await generateCustomerId();
    }
});

export const ContactModel = mongoose.model<IContact>('Contact', ContactSchema);