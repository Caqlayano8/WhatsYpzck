import mongoose, { Document, Schema } from 'mongoose';

export interface IContactGroup extends Document {
    name: string;
    slug: string;
    description?: string;
    addressKeywords: string[];
    memberPhones: string[];
    enabled: boolean;
}

const ContactGroupSchema = new Schema<IContactGroup>({
    name: { type: String, required: true, trim: true, unique: true },
    slug: { type: String, required: true, trim: true, unique: true, index: true },
    description: { type: String, default: '' },
    addressKeywords: [{ type: String }],
    memberPhones: [{ type: String }],
    enabled: { type: Boolean, default: true }
}, { timestamps: true });

export const ContactGroupModel = mongoose.model<IContactGroup>('ContactGroup', ContactGroupSchema);
