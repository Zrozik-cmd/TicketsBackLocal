import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';

@Injectable()
export class DatabaseService implements OnModuleInit {
  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const uri = this.config.getOrThrow<string>('DATABASE_URL');
    try {
      await mongoose.connect(uri);
      Logger.log('✅ Mongo database connected');
    } catch (error) {
      Logger.error('Mongo connection failed', error);
    }
  }
}
