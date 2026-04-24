import mongoose, { Document, Schema } from 'mongoose';

export type IncidentStatus = 'ALINDI' | 'INCELEMEDE' | 'ISLEME_ALINDI' | 'COZUMLENDI' | 'KAPATILDI' | 'IPTAL';

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
    images?: string[];
    assignedTechnician?: {
        userId?: string;
        username?: string;
        displayName?: string;
        phone?: string;
        assignedAt?: Date;
        assignedByUserId?: string;
        assignedByName?: string;
    };
    assignment?: {
        method?: 'manual' | 'auto-area';
        matchKeywords?: string[];
    };
    // Multi-tenant session tracking
    tenantId?: string;
    sessionKey?: string;
    // Archive ve retention fields
    isArchived?: boolean;
    archivedAt?: Date;
    retention?: {
        keepUntil?: Date;  // Ne kadar müddet saklanacak
        retentionDays?: number;  // Gün cinsinden retention süresi
    };
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
        enum: ['ALINDI', 'INCELEMEDE', 'ISLEME_ALINDI', 'COZUMLENDI', 'KAPATILDI', 'IPTAL'],
        default: 'ALINDI'
    },
    statusHistory: [{
        status: {
            type: String,
            enum: ['ALINDI', 'INCELEMEDE', 'ISLEME_ALINDI', 'COZUMLENDI', 'KAPATILDI', 'IPTAL'],
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
    locationCoords: { lat: { type: Number }, lng: { type: Number } },
    images: [{ type: String }],
    assignedTechnician: {
        userId: { type: String, default: '' },
        username: { type: String, default: '' },
        displayName: { type: String, default: '' },
        phone: { type: String, default: '' },
        assignedAt: { type: Date, default: null },
        assignedByUserId: { type: String, default: '' },
        assignedByName: { type: String, default: '' }
    },
    assignment: {
        method: { type: String, enum: ['manual', 'auto-area'], default: 'manual' },
        matchKeywords: [{ type: String }]
    },
    // Multi-tenant session tracking
    tenantId: { type: String, default: 'default', index: true },
    sessionKey: { type: String, default: 'primary' },
    // Archive ve retention fields - ASLA SİLİNMEYECEK, TARİH BAZLI SAKLANACAK
    isArchived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    retention: {
        keepUntil: { type: Date, default: () => new Date(Date.now() + 365 * 24 * 60 * 60 * 1000) },  // Default 1 yıl
        retentionDays: { type: Number, default: 365 }
    },
}, {
    timestamps: true
});

export const IncidentModel = mongoose.model<IIncident>('Incident', incidentSchema);
