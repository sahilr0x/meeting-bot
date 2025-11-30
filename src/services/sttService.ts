import { createClient } from '@deepgram/sdk';
import { Logger } from 'winston';

export class SttService {
  private deepgram: ReturnType<typeof createClient>;
  private logger: Logger;
  private liveConnections: Map<string, any> = new Map();

  constructor(logger: Logger) {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      throw new Error('DEEPGRAM_API_KEY environment variable is required');
    }
    this.deepgram = createClient(apiKey);
    this.logger = logger;
  }

  /**
   * Create a real-time transcription connection
   * @param connectionId - Unique ID for this connection
   * @param onTranscript - Callback for transcriptions
   * @returns Deepgram live transcription connection
   */
  createLiveConnection(connectionId: string, onTranscript: (transcript: string, isFinal: boolean) => void) {
    try {
      this.logger.info('Creating Deepgram live transcription connection', { connectionId });
      
      const connection = this.deepgram.listen.live({
        model: 'nova-2',
        language: 'en-US',
        smart_format: true,
        interim_results: false, // Only final results for cleaner output
        endpointing: 500, // Wait 500ms of silence before finalizing
        // Note: Live API expects raw PCM, but we're sending WebM chunks
        // The connection will be used conditionally based on audio format
      });

      connection.on('open', () => {
        this.logger.info('Deepgram live connection opened', { connectionId });
      });

      connection.on('results', (data: any) => {
        try {
          const transcript = data.channel?.alternatives?.[0]?.transcript || '';
          const isFinal = data.is_final || false;
          
          if (transcript && transcript.trim().length > 0) {
            this.logger.info('Deepgram real-time transcript', { 
              connectionId, 
              transcript, 
              isFinal 
            });
            onTranscript(transcript, isFinal);
          }
        } catch (error: any) {
          this.logger.error('Error processing Deepgram result', { 
            connectionId, 
            error: error?.message 
          });
        }
      });

      connection.on('error', (error: any) => {
        this.logger.error('Deepgram live connection error', { 
          connectionId, 
          error: error?.message 
        });
      });

      connection.on('close', () => {
        this.logger.info('Deepgram live connection closed', { connectionId });
        this.liveConnections.delete(connectionId);
      });

      this.liveConnections.set(connectionId, connection);
      return connection;
    } catch (error: any) {
      this.logger.error('Error creating Deepgram live connection', { 
        connectionId, 
        error: error?.message 
      });
      throw error;
    }
  }

  /**
   * Send audio data to a live connection
   * @param connectionId - Connection ID
   * @param audioBuffer - Audio buffer to send
   */
  sendToLiveConnection(connectionId: string, audioBuffer: Buffer): void {
    const connection = this.liveConnections.get(connectionId);
    if (!connection) {
      this.logger.warn('Live connection not found', { connectionId });
      return;
    }

    try {
      if (connection.getReadyState() === 1) { // OPEN
        connection.send(audioBuffer);
      } else {
        this.logger.warn('Live connection not open', { 
          connectionId, 
          readyState: connection.getReadyState() 
        });
      }
    } catch (error: any) {
      this.logger.error('Error sending to live connection', { 
        connectionId, 
        error: error?.message 
      });
    }
  }

  /**
   * Close a live connection
   * @param connectionId - Connection ID
   */
  closeLiveConnection(connectionId: string): void {
    const connection = this.liveConnections.get(connectionId);
    if (connection) {
      try {
        connection.finish();
        this.liveConnections.delete(connectionId);
        this.logger.info('Closed Deepgram live connection', { connectionId });
      } catch (error: any) {
        this.logger.error('Error closing live connection', { 
          connectionId, 
          error: error?.message 
        });
      }
    }
  }

  /**
   * Transcribe audio buffer using Deepgram
   * @param audioBuffer - Audio buffer to transcribe
   * @returns Transcribed text
   */
  async transcribe(audioBuffer: Buffer): Promise<string> {
    try {
      this.logger.info('Transcribing audio with Deepgram', { bufferSize: audioBuffer.length });

      // Try to transcribe - first try WAV (most reliable), then WebM, then auto-detect
      let response;
      
      // Check if this looks like WAV (starts with "RIFF")
      const isWav = audioBuffer.length >= 4 && 
                    audioBuffer[0] === 0x52 && 
                    audioBuffer[1] === 0x49 && 
                    audioBuffer[2] === 0x46 && 
                    audioBuffer[3] === 0x46; // "RIFF"
      
      if (isWav) {
        try {
          this.logger.info('Detected WAV format, transcribing with WAV mimetype');
          response = await this.deepgram.listen.prerecorded.transcribeFile(
            audioBuffer,
            {
              model: 'nova-2',
              language: 'en-US',
              smart_format: true,
              mimetype: 'audio/wav',
            }
          );
        } catch (wavError: any) {
          this.logger.warn('WAV transcription failed, trying WebM', { error: wavError?.message });
          // Fall through to try WebM
        }
      }
      
      // If not WAV or WAV failed, try WebM (MediaRecorder creates fragmented WebM)
      if (!response) {
        // Try WebM with opus codec first (most common for MediaRecorder)
        try {
          this.logger.info('Trying WebM with opus codec');
          response = await this.deepgram.listen.prerecorded.transcribeFile(
            audioBuffer,
            {
              model: 'nova-2',
              language: 'en-US',
              smart_format: true,
              mimetype: 'audio/webm;codecs=opus',
            }
          );
        } catch (webmOpusError: any) {
          this.logger.warn('WebM with opus codec failed, trying basic WebM', { error: webmOpusError?.message });
          try {
            response = await this.deepgram.listen.prerecorded.transcribeFile(
              audioBuffer,
              {
                model: 'nova-2',
                language: 'en-US',
                smart_format: true,
                mimetype: 'audio/webm',
              }
            );
          } catch (basicWebmError: any) {
            this.logger.warn('Basic WebM failed, trying auto-detect', { error: basicWebmError?.message });
            // Fall through to auto-detect
          }
        }
      }
      
      // If all format-specific attempts failed, try auto-detect
      if (!response) {
        try {
          this.logger.info('Trying auto-detect format');
          response = await this.deepgram.listen.prerecorded.transcribeFile(
            audioBuffer,
            {
              model: 'nova-2',
              language: 'en-US',
              smart_format: true,
            }
          );
        } catch (autoDetectError: any) {
          this.logger.error('All transcription attempts failed', { error: autoDetectError?.message });
          throw autoDetectError;
        }
      }

      if (!response) {
        this.logger.error('Deepgram returned null response');
        return ''; // Return empty instead of throwing - audio may be invalid
      }

      // Check for errors in response
      if ((response as any).error) {
        const error = (response as any).error;
        const errorMsg = error.message || JSON.stringify(error);
        
        this.logger.warn('Deepgram returned an error', { 
          errorName: error.name,
          errorMessage: errorMsg,
          errorStatus: error.status
        });
        
        // If it's a format/corruption error, return empty (audio chunk may be invalid/incomplete)
        if (errorMsg.includes('corrupt') || errorMsg.includes('unsupported') || errorMsg.includes('Bad Request')) {
          this.logger.warn('Deepgram cannot process audio format - chunk may be invalid, incomplete, or too short');
          return '';
        }
        
        // For other errors, still return empty but log it
        return '';
      }

      if (!response.result) {
        this.logger.warn('Deepgram response has no result', { 
          responseKeys: Object.keys(response),
          responseString: JSON.stringify(response).substring(0, 500)
        });
        return ''; // Return empty instead of throwing - audio may contain no speech
      }

      // Check if there are any results
      const results = response.result.results;
      if (!results) {
        this.logger.warn('Deepgram returned no results - audio may be too short or contain no speech', {
          resultKeys: Object.keys(response.result),
          resultString: JSON.stringify(response.result).substring(0, 500)
        });
        return ''; // Return empty string instead of throwing - this is normal for silence
      }

      // Handle both array and object results
      const firstResult = Array.isArray(results) ? results[0] : results;
      if (!firstResult) {
        this.logger.warn('Deepgram returned empty results');
        return '';
      }

      const transcript = firstResult.channels?.[0]?.alternatives?.[0]?.transcript || '';
      
      if (!transcript || transcript.trim().length === 0) {
        this.logger.warn('Deepgram transcript is empty - audio may contain no speech');
        return '';
      }

      this.logger.info('Successfully transcribed audio', { transcript, transcriptLength: transcript.length });

      return transcript;
    } catch (error: any) {
      this.logger.error('Error transcribing audio', { 
        error: error?.message,
        errorStack: error?.stack,
        bufferSize: audioBuffer.length 
      });
      throw error;
    }
  }
}

