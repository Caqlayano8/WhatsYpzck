const mongoose = require('mongoose');

mongoose.connect('mongodb://localhost:27017/WhatsYpzck').then(async () => {
  const db = mongoose.connection.db;
  const result = await db.collection('settings').updateOne({}, { 
    $unset: {
      'apiKeys.SHERPA_ONNX_ASR_ENCODER_PATH': '',
      'apiKeys.SHERPA_ONNX_ASR_DECODER_PATH': '',
      'apiKeys.SHERPA_ONNX_ASR_TOKENS_PATH': ''
    }
  });
  console.log('[DB] Old sherpa paths cleared:', result.modifiedCount);
  process.exit(0);
}).catch(e => { console.error(e); process.exit(1); });
