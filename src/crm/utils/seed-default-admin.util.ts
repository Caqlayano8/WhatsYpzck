import bcrypt from 'bcrypt';
import logger from '../../configs/logger.config';
import { UserModel } from '../models/user.model';

const DEFAULT_ADMIN_USERNAME = process.env.DEFAULT_ADMIN_USER || 'admin';
const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASS;

export async function ensureDefaultAdminUser() {
    if (!DEFAULT_ADMIN_PASSWORD) {
        logger.warn('DEFAULT_ADMIN_PASS ortam degiskeni ayarlanmamis — varsayilan admin olusturulmadi. .env dosyasina ekleyin.');
        return;
    }

    const existing = await UserModel.findOne({ username: DEFAULT_ADMIN_USERNAME });
    const hashed = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 12);

    if (!existing) {
        await UserModel.create({
            username: DEFAULT_ADMIN_USERNAME,
            password: hashed,
            role: 'admin'
        });
        logger.info(`Varsayilan admin hesabi olusturuldu: ${DEFAULT_ADMIN_USERNAME}`);
        return;
    }

    const same = await bcrypt.compare(DEFAULT_ADMIN_PASSWORD, existing.password || '');
    if (!same) {
        existing.password = hashed;
        existing.role = 'admin';
        await existing.save();
        logger.info(`Varsayilan admin sifresi guncellendi: ${DEFAULT_ADMIN_USERNAME}`);
    }
}