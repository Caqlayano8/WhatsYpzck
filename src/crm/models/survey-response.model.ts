/**
 * Author: Ç.Kurtoğlu
 * Description: Survey Response Model - Müşteri memnuniyeti anket yanıtları (multi-step)
 */

import mongoose, { Document, Schema } from 'mongoose';

export interface ISurveyResponse extends Document {
    incidentId: string;
    customerPhone: string;
    customerName?: string;
    // Adım bazlı yanıtlar
    solutionSatisfied?: boolean;   // Q1: Problem çözüldü mü? 1=evet, 2=hayır
    techSatisfied?: boolean;       // Q2: Teknisyen iletişimi? 1=memnun, 2=değil
    freeComment?: string;          // Q3: Serbest yorum
    step: number;                  // 1=Q1 bekleniyor, 2=Q2 bekleniyor, 3=Q3 bekleniyor, 0=tamamlandı
    sentAt: Date;
    completedAt?: Date;
    status: 'pending' | 'completed' | 'expired';
}

const SurveyResponseSchema = new Schema<ISurveyResponse>({
    incidentId: { type: String, required: true },
    customerPhone: { type: String, required: true },
    customerName: String,
    solutionSatisfied: Boolean,
    techSatisfied: Boolean,
    freeComment: String,
    step: { type: Number, default: 1 },
    sentAt: { type: Date, default: Date.now },
    completedAt: Date,
    status: { type: String, enum: ['pending', 'completed', 'expired'], default: 'pending' }
}, { timestamps: true });

SurveyResponseSchema.index({ incidentId: 1 });
SurveyResponseSchema.index({ customerPhone: 1 });
SurveyResponseSchema.index({ sentAt: -1 });

export const SurveyResponseModel = mongoose.model<ISurveyResponse>('SurveyResponse', SurveyResponseSchema);
