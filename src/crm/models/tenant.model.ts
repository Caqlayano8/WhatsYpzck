/**
 * Author: Ç.Kurtoğlu
 * Description: Tenant Model - Multi-tenant organization tracking
 */

import mongoose from 'mongoose';

export interface ITenant {
  _id?: any;
  code: string;              // e.g., 'default', 'acme-corp'
  name: string;              // Display name
  description?: string;
  primaryPhone?: string;     // Main WhatsApp number
  status: 'active' | 'inactive' | 'suspended';
  tier: 'free' | 'basic' | 'pro' | 'enterprise'; // for future billing
  settings?: {
    maxSessions?: number;
    maxContacts?: number;
    features?: string[];
  };
  createdAt?: Date;
  updatedAt?: Date;
}

const tenantSchema = new mongoose.Schema<ITenant>(
  {
    code: { type: String, required: true, unique: true, lowercase: true, index: true },
    name: { type: String, required: true },
    description: { type: String, default: null },
    primaryPhone: { type: String, default: null },
    status: {
      type: String,
      enum: ['active', 'inactive', 'suspended'],
      default: 'active',
      index: true,
    },
    tier: {
      type: String,
      enum: ['free', 'basic', 'pro', 'enterprise'],
      default: 'free',
    },
    settings: {
      maxSessions: { type: Number, default: 3 },
      maxContacts: { type: Number, default: 10000 },
      features: [{ type: String }],
    },
  },
  { timestamps: true }
);

export const TenantModel = mongoose.model<ITenant>('Tenant', tenantSchema);
