/**
 * Author: Ç.Kurtoğlu
 * Description: User Model - Kullanıcı modeli
 */

import mongoose, { Document, Schema } from 'mongoose';

export type UserRole = 'admin' | 'field_tech' | 'viewer';

export interface IUser extends Document {
    username: string;
    password: string;
    role: UserRole;
    displayName?: string;
    phone?: string;
    // Granular permission overrides — admin sets these per user
    permissions?: {
        canViewIncidents?: boolean;
        canUpdateIncidents?: boolean;
        canViewConversations?: boolean;
        canSendMessages?: boolean;
        canManageContacts?: boolean;
        canManageCampaigns?: boolean;
        canManageGroups?: boolean;
        canViewReports?: boolean;
        canManageSettings?: boolean;
        canManageUsers?: boolean;
        canToggleMaintenance?: boolean;
    };
    isActive: boolean;
    lastLogin?: Date;
    // 2FA
    email?: string;
    twoFactorEnabled?: boolean;
    twoFactorMethod?: 'email' | 'totp'; // 'email' = OTP e-posta, 'totp' = Google Authenticator
    twoFactorOtp?: string;
    twoFactorExpiry?: Date;
    totpSecret?: string;     // TOTP gizli anahtarı (base32)
    createdAt: Date;
    updatedAt: Date;
}

const UserSchema = new Schema<IUser>({
    username:    { type: String, required: true, unique: true },
    password:    { type: String, required: true },
    role:        { type: String, enum: ['admin', 'field_tech', 'viewer'], default: 'viewer' },
    displayName: { type: String },
    phone:       { type: String },
    permissions: {
        canViewIncidents:      { type: Boolean },
        canUpdateIncidents:    { type: Boolean },
        canViewConversations:  { type: Boolean },
        canSendMessages:       { type: Boolean },
        canManageContacts:     { type: Boolean },
        canManageCampaigns:    { type: Boolean },
        canManageGroups:       { type: Boolean },
        canViewReports:        { type: Boolean },
        canManageSettings:     { type: Boolean },
        canManageUsers:        { type: Boolean },
        canToggleMaintenance:  { type: Boolean },
    },
    isActive:  { type: Boolean, default: true },
    lastLogin: { type: Date },
    // 2FA alanları
    email:            { type: String },
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorMethod:  { type: String, enum: ['email', 'totp'], default: 'email' },
    twoFactorOtp:     { type: String },   // hash'li OTP
    twoFactorExpiry:  { type: Date },     // OTP geçerlilik süresi
    totpSecret:       { type: String },   // TOTP gizli anahtarı
}, { timestamps: true });

export const UserModel = mongoose.model<IUser>('User', UserSchema);