import mongoose, { Document, Schema } from 'mongoose';

export type IncidentStatus = 'ALINDI' | 'INCELEMEDE' | 'ISLEME_ALINDI' | 'COZUMLENDI' | 'KAPATILDI';

export interface IIncident extends Document {
    incidentId: string;
    customerName: string;
    customerPhone: string;
    customerEmail: string;
    address: string;
    meterNo: string;
    issueSummary: string;
    sourcePhoneNumber: string;
    status: IncidentStatus;
    statusHistory: Array<{
        status: IncidentStatus;
        note?: string;
        at: Date;
    }>;
    notifications: {
        teamWhatsAppSent: boolean;
        teamEmailSent: boolean;
        customerEmailSent: boolean;
        lastError?: string;
    };
    photoCoords?: { lat: number; lng: number };
    locationCoords?: { lat: number; lng: number };
    createdAt?: Date;
    updatedAt?: Date;
}

const incidentSchema = new Schema<IIncident>({
    incidentId: { type: String, required: true, unique: true, index: true },
    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true, index: true },
    customerEmail: { type: String, default: '' },
    address: { type: String, required: true },
    meterNo: { type: String, required: true },
    issueSummary: { type: String, default: 'Elektrik arizasi bildirimi' },
    sourcePhoneNumber: { type: String, required: true },
    status: {
        type: String,
        enum: ['ALINDI', 'INCELEMEDE', 'ISLEME_ALINDI', 'COZUMLENDI', 'KAPATILDI'],
        default: 'ALINDI'
    },
    statusHistory: [{
        status: {
            type: String,
            enum: ['ALINDI', 'INCELEMEDE', 'ISLEME_ALINDI', 'COZUMLENDI', 'KAPATILDI'],
            required: true
        },
        note: { type: String, default: '' },
        at: { type: Date, default: Date.now }
    }],
    notifications: {
        teamWhatsAppSent: { type: Boolean, default: false },
        teamEmailSent: { type: Boolean, default: false },
        customerEmailSent: { type: Boolean, default: false },
        lastError: { type: String, default: '' }
    },
    photoCoords: { lat: { type: Number }, lng: { type: Number } },
    locationCoords: { lat: { type: Number }, lng: { type: Number } }
}, {
    timestamps: true
});

export const IncidentModel = mongoose.model<IIncident>('Incident', incidentSchema);
