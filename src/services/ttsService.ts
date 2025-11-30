import { createClient } from '@deepgram/sdk';
import { Logger } from 'winston';

export class TtsService {
  private deepgram: ReturnType<typeof createClient>;
  private logger: Logger;

  constructor(logger: Logger) {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      throw new Error('DEEPGRAM_API_KEY environment variable is required');
    }
    this.deepgram = createClient(apiKey);
    this.logger = logger;
  }

  async textToSpeech(
    text: string,
    options?: {
      voice?: string;
      model?: string;
    }
  ): Promise<Buffer> {
    try {
      this.logger.info('Generating speech with Deepgram TTS', { textLength: text.length });

      const response = await this.deepgram.speak.request(
        { text },
        {
          model: options?.model || 'aura-2-odysseus-en', // Default to Aura-2 Asteria
          encoding: 'linear16',
          container: 'wav',
          sample_rate: 24000,
        }
      );

      if (!response) {
        throw new Error('Deepgram TTS returned no response');
      }

      // Get the stream from the response
      const audioStream = await response.getStream();
      
      if (!audioStream) {
        throw new Error('Deepgram TTS response has no stream');
      }

      // Convert the ReadableStream to a Buffer
      const chunks: Uint8Array[] = [];
      const reader = audioStream.getReader();
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
          }
        }
      } finally {
        reader.releaseLock();
      }

      const audioBuffer = Buffer.concat(chunks);
      this.logger.info('Successfully generated TTS audio', { bufferSize: audioBuffer.length });

      return audioBuffer;
    } catch (error: any) {
      this.logger.error('Error generating TTS', { error: error?.message });
      throw error;
    }
  }
}

