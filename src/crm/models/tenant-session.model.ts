/**
 * Author: Ç.Kurtoğlu
 * Description: Tenant Session Model - Multi-client support per tenant
 * Tracks WhatsApp client lifecycle for each session (primary, support, night-shift, etc.)
 */

import mongoose from 'mongoose';

export interface ITenantSession {
  _id?: any;
  tenantId: string;           // e.g., 'default' or ObjectId
  sessionKey: string;          // e.g., 'primary', 'support', 'night-shift'
  sessionName?: string;        // Display name
  status: 'pending_qr' | 'qr_ready' | 'connected' | 'disconnected' | 'error';
  qrCode?: string;             // Current QR code for scanning
  botPhone?: string;           // Scanned WhatsApp phone/JID
  botPushName?: string;        // WhatsApp display name
  uptime?: number;             // Seconds connected
  lastStatusUpdate: Date;
  errorMessage?: string;       // Last error (if status='error')
  settings?: {
    autoReconnect?: boolean;
    idleTimeoutMins?: number;
  };
  createdAt?: Date;
  updatedAt?: Date;
}

const tenantSessionSchema = new mongoose.Schema<ITenantSession>(
  {
    tenantId: { type: String, required: true, index: true },
    sessionKey: { type: String, required: true },
    sessionName: { type: String, default: null },
    status: {
      type: String,
      enum: ['pending_qr', 'qr_ready', 'connected', 'disconnected', 'error'],
      default: 'pending_qr',
      index: true,
    },
    qrCode: { type: String, default: null },
    botPhone: { type: String, default: null },
    botPushName: { type: String, default: null },
    uptime: { type: Number, default: 0 },
    lastStatusUpdate: { type: Date, default: () => new Date() },
    errorMessage: { type: String, default: null },
    settings: {
      autoReconnect: { type: Boolean, default: true },
      idleTimeoutMins: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

// Compound index for fast lookup
tenantSessionSchema.index({ tenantId: 1, sessionKey: 1 }, { unique: true });
tenantSessionSchema.index({ tenantId: 1, status: 1 });

export const TenantSessionModel = mongoose.model<ITenantSession>(
  'TenantSession',
  tenantSessionSchema
);
