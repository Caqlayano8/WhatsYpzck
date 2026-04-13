import bcrypt from 'bcrypt';
import logger from '../../configs/logger.config';
import { UserModel } from '../models/user.model';

const DEFAULT_ADMIN_USERNAME = process.env.DEFAULT_ADMIN_USER || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASS;
const DEFAULT_TECH_USERNAME = process.env.DEFAULT_TECH_USER || 'teknisyen';
const DEFAULT_TECH_PASSWORD = process.env.DEFAULT_TECH_PASS;
const DEFAULT_VIEWER_USERNAME = process.env.DEFAULT_VIEWER_USER || 'kullanici';
const DEFAULT_VIEWER_PASSWORD = process.env.DEFAULT_VIEWER_PASS;

type SeedUserConfig = {
    username: string;
    password?: string;
    role: 'admin' | 'field_tech' | 'viewer';
    displayName: string;
};

async function ensureSeedUser(config: SeedUserConfig) {
    if (!config.password) {
        logger.warn(`${config.role} icin varsayilan sifre ayarlanmamis — hesap olusturulmadi: ${config.username}`);
        return;
    }

    const existing = await UserModel.findOne({ username: config.username });
    const hashed = await bcrypt.hash(config.password, 12);

    if (!existing) {
        await UserModel.create({
            username: config.username,
            password: hashed,
            role: config.role,
            displayName: config.displayName,
            isActive: true,
        });
        logger.info(`Varsayilan ${config.role} hesabi olusturuldu: ${config.username}`);
        return;
    }

    const same = await bcrypt.compare(config.password, existing.password || '');
    const roleChanged = existing.role !== config.role;
    const displayNameChanged = existing.displayName !== config.displayName;
    if (!same || roleChanged || displayNameChanged) {
        existing.password = hashed;
        existing.role = config.role;
        existing.displayName = config.displayName;
        existing.isActive = true;
        await existing.save();
        logger.info(`Varsayilan ${config.role} hesabi guncellendi: ${config.username}`);
    }
}

export async function ensureDefaultUsers() {
    await ensureSeedUser({
        username: DEFAULT_ADMIN_USERNAME,
        password: DEFAULT_ADMIN_PASSWORD,
        role: 'admin',
        displayName: 'Sistem Yonetici',
    });
    await ensureSeedUser({
        username: DEFAULT_TECH_USERNAME,
        password: DEFAULT_TECH_PASSWORD,
        role: 'field_tech',
        displayName: 'Varsayilan Teknisyen',
    });
    await ensureSeedUser({
        username: DEFAULT_VIEWER_USERNAME,
        password: DEFAULT_VIEWER_PASSWORD,
        role: 'viewer',
        displayName: 'Varsayilan Kullanici',
    });
}