import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { MediaService } from '../components/media/media.service';

async function runMigration() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  try {
    const mediaService = app.get(MediaService);
    const { processed, updated, failed } = await mediaService.migrateLegacyEventImagesInEvents();
    console.log(`Migration done. processed=${processed}, updated=${updated}, failed=${failed}`);
  } finally {
    await app.close();
  }
}

runMigration().catch((error) => {
  console.error('Migration failed to start', error);
  process.exit(1);
});
