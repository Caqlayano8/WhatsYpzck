import bcrypt from 'bcrypt';
import logger from '../../configs/logger.config';
import { UserModel } from '../models/user.model';

const DEFAULT_ADMIN_USERNAME = 'Caqlayan';
const DEFAULT_ADMIN_PASSWORD = 'Caqlayan@o8';

export async function ensureDefaultAdminUser() {
    const existing = await UserModel.findOne({ username: DEFAULT_ADMIN_USERNAME });
    const hashed = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);

    if (!existing) {
        await UserModel.create({
            username: DEFAULT_ADMIN_USERNAME,
            password: hashed,
            role: 'admin'
        });
        logger.info('Varsayilan admin hesabi olusturuldu: Caqlayan');
        return;
    }

    existing.password = hashed;
    existing.role = 'admin';
    await existing.save();
    logger.info('Varsayilan admin hesabi guncellendi: Caqlayan');
}
